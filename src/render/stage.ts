import { Application } from 'pixi.js'
import type { PetMemory, Settings, WorldEnv, WorldPulse } from '@shared/types'
import { Desktop } from '../world/desktop'
import { Pet, PET_HEIGHT } from '../brain/pet'
import { CatRenderer } from './cat'

/**
 * Owns the render loop and the bridge between the simulation (global desktop
 * coordinates) and the canvas (window-local coordinates).
 *
 * The canvas is deliberately *not* the size of the window. The overlay spans the
 * whole screen so the pet can walk anywhere, but a screen-sized canvas at Retina
 * density means rasterising and compositing several million pixels every frame
 * for a sprite that occupies a few thousand of them. Instead the canvas is a
 * small viewport that is moved with a compositor-only transform, and the pet is
 * drawn at a fixed anchor inside it.
 *
 * Also owns hit-testing: this is the only code that knows where the pet's pixels
 * actually are, so it is the only code that can decide when the click-through
 * overlay should become solid.
 */

export interface StageState {
  /** Pet position in window-local coordinates, for placing DOM overlays. */
  screenX: number
  screenY: number
  mood: string
  action: string
  hovered: boolean
  /** App the pet is standing on, if any. */
  standingOn: string | null
}

/** Viewport size in CSS pixels — large enough for the pet at maximum scale. */
const VIEW_W = 320
const VIEW_H = 300
/** Where the pet's feet sit inside the viewport. */
const ANCHOR_X = VIEW_W / 2
const ANCHOR_Y = VIEW_H - 40

/** Extra pixels around the sprite that still count as "on the pet" for clicks. */
const HIT_PADDING = 8

export class Stage {
  readonly desktop = new Desktop()
  readonly pet: Pet
  private app = new Application()
  private cat: CatRenderer
  private settings: Settings
  private interactive = false
  private lastFrame = performance.now()
  private wasGrounded = true
  private hovered = false
  private forceInteractive = false
  private spawned = false
  private lastViewX = Number.NaN
  private lastViewY = Number.NaN
  private debugFrames = 0
  private debugSince = performance.now()
  private targetFps = 30
  private running = false
  private rafHandle = 0
  private timerHandle: ReturnType<typeof setTimeout> | null = null
  private onState: (state: StageState) => void = () => {}

  constructor(memory: PetMemory, settings: Settings) {
    this.pet = new Pet(memory.personality, memory.seed)
    this.cat = new CatRenderer(this.pet.palette)
    this.settings = settings
  }

  async init(mount: HTMLElement, onState: (state: StageState) => void, onClick: () => void): Promise<void> {
    await this.app.init({
      backgroundAlpha: 0,
      width: VIEW_W,
      height: VIEW_H,
      antialias: true,
      // Match the display so the pet is crisp on Retina without oversampling.
      resolution: window.devicePixelRatio,
      autoDensity: true,
      // We drive the loop ourselves so the frame rate can be throttled by state.
      autoStart: false,
    })

    const canvas = this.app.canvas
    canvas.style.position = 'absolute'
    canvas.style.left = '0'
    canvas.style.top = '0'
    // translate3d keeps viewport movement on the compositor instead of
    // triggering layout every frame.
    canvas.style.willChange = 'transform'
    mount.appendChild(canvas)

    this.app.stage.addChild(this.cat.root)
    this.cat.root.position.set(ANCHOR_X, ANCHOR_Y)

    canvas.addEventListener('pointerdown', (event) => {
      // Clicks that land on the transparent part of the viewport belong to
      // whatever is underneath, not to the pet.
      if (!this.hovered) return
      event.preventDefault()
      onClick()
    })

    // Pixi's own ticker is not used. Its `maxFPS` throttles the *update* but
    // still requests an animation frame every display refresh — on a 120Hz
    // panel that is 120 wakeups a second no matter how slowly the pet is
    // animating, and it dominated the idle cost. Instead a timer sets the pace
    // and a single rAF aligns the render to vsync, so wakeups scale with the
    // frame rate we actually want.
    this.app.ticker.stop()
    this.onState = onState
    this.running = true
    this.scheduleNext()
  }

  private scheduleNext(): void {
    if (!this.running) return
    const delay = Math.max(0, 1000 / this.targetFps - 2)
    this.timerHandle = setTimeout(() => {
      this.rafHandle = requestAnimationFrame(() => {
        if (!this.running) return
        this.frame(this.onState)
        this.app.render()
        this.scheduleNext()
      })
    }, delay)
  }

  /**
   * Hold the window solid regardless of cursor position. Needed while the speech
   * bubble is open, or the user could not click into its input field.
   */
  setForceInteractive(force: boolean): void {
    this.forceInteractive = force
  }

  setSettings(settings: Settings): void {
    this.settings = settings
    this.desktop.useWindows = settings.useWindows
  }

  applyEnv(env: WorldEnv): void {
    this.desktop.updateEnv(env)
    this.desktop.useWindows = this.settings.useWindows

    // The pet cannot be placed until we know where the screen actually is, so
    // spawning waits for the first env that carries display geometry.
    if (!this.spawned && env.displays.length > 0) {
      this.pet.spawn(this.desktop)
      this.spawned = true
    }
  }

  applyPulse(pulse: WorldPulse): void {
    this.desktop.updatePulse(pulse)
  }

  poke(): void {
    this.pet.poke()
  }

  destroy(): void {
    this.running = false
    if (this.timerHandle) clearTimeout(this.timerHandle)
    cancelAnimationFrame(this.rafHandle)
    this.app.destroy(true, { children: true })
  }

  private frame(onState: (state: StageState) => void): void {
    const now = performance.now()
    // Clamped so a stalled renderer or a sleeping laptop cannot teleport the pet
    // across the screen on the next frame.
    const dt = Math.min(0.1, (now - this.lastFrame) / 1000)
    this.lastFrame = now

    this.pet.update(dt, this.desktop)

    // Landing kicks the squash spring; the impact reads as weight.
    if (!this.wasGrounded && this.pet.grounded) this.cat.impact(Math.abs(this.pet.vy) + 320)
    this.wasGrounded = this.pet.grounded

    const scale = this.settings.scale
    const localX = this.pet.x - this.desktop.bounds.x
    const localY = this.pet.y - this.desktop.bounds.y

    // Move the viewport, not the sprite. Rounded to whole pixels so the pet does
    // not shimmer from subpixel resampling as it walks.
    const viewX = Math.round(localX - ANCHOR_X)
    const viewY = Math.round(localY - ANCHOR_Y)
    if (viewX !== this.lastViewX || viewY !== this.lastViewY) {
      this.app.canvas.style.transform = `translate3d(${viewX}px, ${viewY}px, 0)`
      this.lastViewX = viewX
      this.lastViewY = viewY
    }

    this.cat.update(dt, this.pet.anim, this.pet.facing, this.pet.vx, scale)

    this.updateHitTest(scale)
    this.throttle()
    this.debugStats(now)

    onState({
      screenX: localX,
      screenY: localY - PET_HEIGHT * scale,
      mood: this.pet.mood,
      action: this.pet.action,
      hovered: this.hovered,
      standingOn: this.pet.surface?.app ?? null,
    })
  }

  /**
   * Toggle the window between click-through and solid based on whether the
   * cursor is over the pet. Only sends IPC on a change — this runs every frame.
   */
  private updateHitTest(scale: number): void {
    const halfWidth = PET_HEIGHT * 0.45 * scale + HIT_PADDING
    const height = PET_HEIGHT * scale + HIT_PADDING

    const { x: cx, y: cy } = this.desktop.cursor
    const over =
      cx >= this.pet.x - halfWidth &&
      cx <= this.pet.x + halfWidth &&
      cy >= this.pet.y - height &&
      cy <= this.pet.y + HIT_PADDING

    this.hovered = over
    const want = over || this.forceInteractive
    if (want === this.interactive) return
    this.interactive = want
    window.pet.setInteractive(want)
  }

  /**
   * Reports the frame rate actually achieved alongside the cap we asked for, so
   * a throttle that silently fails to engage is visible. Enabled with PET_DEBUG.
   */
  private debugStats(now: number): void {
    if (!window.pet.debug) return
    this.debugFrames++
    if (now - this.debugSince < 5000) return
    const fps = (this.debugFrames * 1000) / (now - this.debugSince)
    console.log(
      `[stats] fps=${fps.toFixed(1)} cap=${this.targetFps} anim=${this.pet.anim} ` +
        `asleep=${this.pet.asleep} idle=${this.desktop.idleSeconds}s windows=${this.desktop.windows.length}`,
    )
    this.debugFrames = 0
    this.debugSince = now
  }

  /**
   * Drop the frame rate when nothing is moving. A sleeping pet on an idle
   * machine should cost close to nothing; this is most of why the app can sit
   * in the background all day.
   */
  private throttle(): void {
    // What matters is whether anything is actually *moving*, not which action is
    // running. The pet spends most of its life in sit/idle/look, where the only
    // motion is breathing and the occasional blink — those read perfectly well
    // at a third of the frame rate, and this is the common case all day.
    const moving = Math.abs(this.pet.vx) > 0.5 || !this.pet.grounded
    const lively =
      moving ||
      this.pet.anim === 'dance' ||
      this.pet.anim === 'celebrate' ||
      this.pet.anim === 'scratch' ||
      this.pet.anim === 'stretch'
    const userAway = this.desktop.idleSeconds > 30

    // settings.fps is a ceiling, never a floor — every rule below may only take
    // the rate down.
    let fps = this.settings.fps
    if (this.pet.asleep) fps = Math.min(fps, userAway ? 4 : 8)
    else if (!lively) fps = Math.min(fps, userAway ? 8 : 12)
    if (this.desktop.onBattery) fps = Math.min(fps, 24)

    this.targetFps = Math.max(1, fps)
  }
}
