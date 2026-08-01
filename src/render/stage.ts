import type { PetAssignment, PetSpawn, Settings, WorldEnv, WorldPulse } from '@shared/types'
import { Desktop } from '../world/desktop'
import { Pet, PET_HEIGHT, type AnimState } from '../brain/pet'
import type { ActionId } from '../brain/actions'
import { CatRenderer } from './cat'

/**
 * Owns the render loop and the bridge between the simulation (global desktop
 * coordinates) and the canvas (window-local coordinates).
 *
 * There is one Stage per overlay window, i.e. one per display. It draws every
 * pet currently living on its display onto a single full-window Canvas2D layer,
 * clearing only the pixels each pet actually touches. A pet that walks off a
 * display edge with a neighbour beyond it is handed to that neighbour's window;
 * because coordinates are global, the receiving stage just keeps simulating from
 * the same numbers.
 *
 * Also owns hit-testing: this is the only code that knows where each pet's pixels
 * are, so it is the only code that can decide when the click-through overlay
 * should become solid.
 */

export interface StageState {
  petId: number
  /** Pet position in window-local coordinates, for placing DOM overlays. */
  screenX: number
  screenY: number
  mood: string
  action: string
  hovered: boolean
  /** App the pet is standing on, if any. */
  standingOn: string | null
}

/** Extra pixels around the sprite that still count as "on the pet" for clicks. */
const HIT_PADDING = 8

interface Entry {
  pet: Pet
  cat: CatRenderer
  /** Device-independent box cleared last frame, so it can be erased this frame. */
  lastBox: { left: number; top: number; width: number; height: number } | null
  /** Fraction across the display to spawn at, once bounds are known. */
  spawnFraction: number
  needsSpawn: boolean
  /** Previous grounded state, to fire the landing squash on the touch-down frame. */
  wasGrounded: boolean
}

export class Stage {
  readonly desktop = new Desktop()
  private entries = new Map<number, Entry>()
  private canvas!: HTMLCanvasElement
  private ctx!: CanvasRenderingContext2D
  private dpr = 1
  private settings: Settings
  private displayId = -1

  private interactive = false
  private hovered = false
  private hoveredPetId: number | null = null
  private forceInteractive = false
  private activePetId: number | null = null

  private lastFrame = performance.now()
  private debugFrames = 0
  private debugSince = performance.now()
  private targetFps = 30
  private running = false
  private rafHandle = 0
  private timerHandle: ReturnType<typeof setTimeout> | null = null
  private onState: (state: StageState | null) => void = () => {}
  private onClick: (petId: number) => void = () => {}

  constructor(settings: Settings) {
    this.settings = settings
    this.desktop.useWindows = settings.useWindows
  }

  async init(
    mount: HTMLElement,
    onState: (state: StageState | null) => void,
    onClick: (petId: number) => void,
  ): Promise<void> {
    this.onState = onState
    this.onClick = onClick

    const canvas = document.createElement('canvas')
    canvas.style.position = 'absolute'
    canvas.style.inset = '0'
    canvas.style.width = '100%'
    canvas.style.height = '100%'
    mount.appendChild(canvas)
    this.canvas = canvas
    this.ctx = canvas.getContext('2d')!
    this.resize()
    window.addEventListener('resize', this.resize)

    canvas.addEventListener('pointerdown', (event) => {
      // Clicks that land on the transparent part of the overlay belong to
      // whatever is underneath, not to any pet.
      if (this.hoveredPetId === null) return
      event.preventDefault()
      this.onClick(this.hoveredPetId)
    })

    this.running = true
    this.scheduleNext()
  }

  /** Size the backing store to the display in device pixels; work in CSS px. */
  private resize = (): void => {
    this.dpr = window.devicePixelRatio || 1
    const w = window.innerWidth
    const h = window.innerHeight
    this.canvas.width = Math.round(w * this.dpr)
    this.canvas.height = Math.round(h * this.dpr)
    // Reset every pet's remembered box; the whole surface is blank after a resize.
    for (const entry of this.entries.values()) entry.lastBox = null
    this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0)
  }

  private scheduleNext(): void {
    if (!this.running) return
    const delay = Math.max(0, 1000 / this.targetFps - 2)
    this.timerHandle = setTimeout(() => {
      // A timer sets the pace and a single rAF aligns the render to vsync, so
      // wakeups scale with the frame rate we actually want rather than the
      // display's refresh rate.
      this.rafHandle = requestAnimationFrame(() => {
        if (!this.running) return
        this.frame()
        this.scheduleNext()
      })
    }, delay)
  }

  /** Hold the window solid regardless of cursor position (while a bubble is open). */
  setForceInteractive(force: boolean): void {
    this.forceInteractive = force
  }

  /** Which pet a DOM bubble is currently attached to, so we report its position. */
  setActivePet(petId: number | null): void {
    this.activePetId = petId
  }

  setSettings(settings: Settings): void {
    this.settings = settings
    this.desktop.useWindows = settings.useWindows
  }

  applyEnv(env: WorldEnv): void {
    this.desktop.updateEnv(env)
    this.desktop.useWindows = this.settings.useWindows
  }

  applyPulse(pulse: WorldPulse): void {
    this.desktop.updatePulse(pulse)
  }

  /** Main told this window which display it is and the exact set of pets it owns. */
  applyAssignment(assignment: PetAssignment): void {
    this.displayId = assignment.displayId
    this.desktop.setDisplay(assignment.displayId)

    const wanted = new Set(assignment.pets.map((p) => p.id))
    // Drop pets no longer assigned here.
    let removed = false
    for (const id of [...this.entries.keys()]) {
      if (!wanted.has(id)) {
        this.removePet(id)
        removed = true
      }
    }
    // Belt and braces: if the population shrank, wipe the whole surface so a
    // departed pet cannot leave a stale silhouette behind, whatever its box was.
    if (removed && this.ctx) {
      this.ctx.clearRect(0, 0, window.innerWidth, window.innerHeight)
      for (const entry of this.entries.values()) entry.lastBox = null
    }
    if (window.pet.debug) {
      console.log(`[assign] display=${assignment.displayId} wanted=${[...wanted].join(',')} entries=${this.entries.size} removed=${removed}`)
    }
    // Add newly assigned pets, spread across the display so they do not stack.
    assignment.pets.forEach((identity, index) => {
      if (this.entries.has(identity.id)) return
      const fraction = (index + 1) / (assignment.pets.length + 1)
      const pet = new Pet(identity.personality, identity.seed)
      this.entries.set(identity.id, {
        pet,
        cat: new CatRenderer(pet.palette),
        lastBox: null,
        spawnFraction: fraction,
        needsSpawn: true,
        wasGrounded: true,
      })
    })
  }

  /** A pet arriving from another display, mid-stride. Resume its live state. */
  receivePet(spawn: PetSpawn): void {
    if (this.entries.has(spawn.id)) return
    const pet = new Pet(spawn.personality, spawn.seed)
    if (spawn.live) pet.restore(spawn.live)
    else pet.spawn(this.desktop)
    this.entries.set(spawn.id, {
      pet,
      cat: new CatRenderer(pet.palette),
      lastBox: null,
      spawnFraction: 0.5,
      needsSpawn: false,
      wasGrounded: pet.grounded,
    })
  }

  private removePet(id: number): void {
    const entry = this.entries.get(id)
    if (!entry) return
    if (entry.lastBox) this.clearBox(entry.lastBox)
    this.entries.delete(id)
    if (this.activePetId === id) this.activePetId = null
    if (this.hoveredPetId === id) this.hoveredPetId = null
  }

  /** Tray "Say hi" pokes whichever pet is on this display; returns the poked id. */
  pokeAny(): number | null {
    const first = this.entries.values().next().value as Entry | undefined
    if (!first) return null
    first.pet.poke()
    return first.pet.id
  }

  poke(petId: number): void {
    this.entries.get(petId)?.pet.poke()
  }

  /** Drive a pet from a spoken command (see App's intent parser). */
  command(petId: number, intent: string): void {
    const pet = this.entries.get(petId)?.pet
    if (!pet) return
    if (intent === 'hop') pet.hop()
    else if (intent === 'wake') pet.wake()
    else if (intent === 'acknowledge') pet.acknowledge()
    else pet.command(intent as ActionId)
  }

  destroy(): void {
    this.running = false
    if (this.timerHandle) clearTimeout(this.timerHandle)
    cancelAnimationFrame(this.rafHandle)
    window.removeEventListener('resize', this.resize)
  }

  private frame(): void {
    const now = performance.now()
    // Clamped so a stalled renderer or a sleeping laptop cannot teleport a pet
    // across the screen on the next frame.
    const dt = Math.min(0.1, (now - this.lastFrame) / 1000)
    this.lastFrame = now

    const scale = this.settings.scale
    const boundsReady = this.desktop.displays.length > 0
    const pets = [...this.entries.values()].map((e) => e.pet)

    // --- simulate every pet, then resolve any that walked off a display edge ---
    const handoffs: number[] = []
    for (const entry of this.entries.values()) {
      if (entry.needsSpawn) {
        if (!boundsReady) continue
        const b = this.desktop.bounds
        entry.pet.spawn(this.desktop, b.x + b.w * entry.spawnFraction)
        entry.needsSpawn = false
      }

      const others = pets.filter((p) => p !== entry.pet)
      const vyBefore = entry.pet.vy
      entry.pet.update(dt, this.desktop, others)

      // Landing kicks the squash spring; the impact reads as weight.
      if (!entry.wasGrounded && entry.pet.grounded) entry.cat.impact(Math.abs(vyBefore) + 320)
      entry.wasGrounded = entry.pet.grounded

      // Advance the drawable pose here, before the clear pass, so the box that
      // gets reserved matches the pose that will actually be drawn this frame —
      // otherwise a pet that just started climbing clears an upright-sized box
      // and its rotated sprite smears.
      const anim = (window.pet.posePreview as AnimState) || entry.pet.anim
      entry.cat.update(dt, anim, entry.pet.facing, entry.pet.vx, scale)
      entry.cat.setEmote(window.pet.emotePreview || entry.pet.emote)

      if (entry.pet.grounded && boundsReady) {
        const b = this.desktop.bounds
        if (entry.pet.x < b.x - 2 || entry.pet.x >= b.x + b.w + 2) {
          const target = this.desktop.displayContaining(entry.pet.x, entry.pet.y)
          if (target && target.id !== this.displayId) {
            window.pet.handoff({
              id: entry.pet.id,
              personality: entry.pet.personality,
              seed: entry.pet.seed,
              live: entry.pet.serialize(),
            })
            handoffs.push(entry.pet.id)
          }
        }
      }
    }
    for (const id of handoffs) this.removePet(id)

    // --- clear each pet's old and new footprint, then draw them all ---
    for (const entry of this.entries.values()) {
      if (entry.needsSpawn) continue
      const box = this.boxFor(entry, scale)
      if (entry.lastBox) this.clearBox(entry.lastBox)
      this.clearBox(box)
      entry.lastBox = box
    }
    for (const entry of this.entries.values()) {
      if (entry.needsSpawn) continue
      const pet = entry.pet
      // Pose was already advanced in the simulate pass above; just draw it.
      const localX = Math.round(pet.x - this.desktop.bounds.x)
      const localY = Math.round(pet.y - this.desktop.bounds.y)
      this.ctx.save()
      this.ctx.translate(localX, localY)
      entry.cat.draw(this.ctx)
      this.ctx.restore()
    }

    this.updateHitTest(scale)
    this.throttle()
    this.debugStats(now)
    this.reportActive(scale)
  }

  /** Window-local, padded bounding box for a pet's sprite this frame. */
  private boxFor(entry: Entry, scale: number): { left: number; top: number; width: number; height: number } {
    const b = entry.cat.boundsFor(scale)
    const localX = Math.round(entry.pet.x - this.desktop.bounds.x)
    const localY = Math.round(entry.pet.y - this.desktop.bounds.y)
    return {
      left: Math.floor(localX + b.left) - 2,
      top: Math.floor(localY + b.top) - 2,
      width: Math.ceil(b.width) + 4,
      height: Math.ceil(b.height) + 4,
    }
  }

  private clearBox(box: { left: number; top: number; width: number; height: number }): void {
    this.ctx.clearRect(box.left, box.top, box.width, box.height)
  }

  private reportActive(scale: number): void {
    if (this.activePetId === null) {
      this.onState(null)
      return
    }
    const entry = this.entries.get(this.activePetId)
    if (!entry) {
      this.onState(null)
      return
    }
    const pet = entry.pet
    this.onState({
      petId: pet.id,
      screenX: pet.x - this.desktop.bounds.x,
      screenY: pet.y - this.desktop.bounds.y - PET_HEIGHT * scale,
      mood: pet.mood,
      action: pet.action,
      hovered: this.hoveredPetId === pet.id,
      standingOn: pet.surface?.app ?? null,
    })
  }

  /**
   * Toggle the window between click-through and solid based on whether the cursor
   * is over any pet, and remember which pet that is for click routing. Only sends
   * IPC on a change — this runs every frame.
   */
  private updateHitTest(scale: number): void {
    const halfWidth = PET_HEIGHT * 0.45 * scale + HIT_PADDING
    const height = PET_HEIGHT * scale + HIT_PADDING
    const { x: cx, y: cy } = this.desktop.cursor

    let hit: number | null = null
    let bestDist = Infinity
    for (const entry of this.entries.values()) {
      const pet = entry.pet
      const over =
        cx >= pet.x - halfWidth &&
        cx <= pet.x + halfWidth &&
        cy >= pet.y - height &&
        cy <= pet.y + HIT_PADDING
      if (!over) continue
      const d = Math.abs(cx - pet.x)
      if (d < bestDist) {
        bestDist = d
        hit = pet.id
      }
    }

    this.hoveredPetId = hit
    this.hovered = hit !== null
    const want = this.hovered || this.forceInteractive
    if (want === this.interactive) return
    this.interactive = want
    window.pet.setInteractive(want)
  }

  private debugStats(now: number): void {
    if (!window.pet.debug) return
    this.debugFrames++
    if (now - this.debugSince < 5000) return
    const fps = (this.debugFrames * 1000) / (now - this.debugSince)
    console.log(
      `[stats] fps=${fps.toFixed(1)} cap=${this.targetFps} display=${this.displayId} ` +
        `pets=${this.entries.size} windows=${this.desktop.windows.length}`,
    )
    this.debugFrames = 0
    this.debugSince = now
  }

  /**
   * Drop the frame rate when nothing is moving. A screen of sleeping pets on an
   * idle machine should cost close to nothing. The rate is the liveliest pet's
   * need, so one running cat lifts the whole display while the rest doze.
   */
  private throttle(): void {
    let anyLively = false
    let allAsleep = this.entries.size > 0
    for (const { pet } of this.entries.values()) {
      const moving = Math.abs(pet.vx) > 0.5 || !pet.grounded
      const lively =
        moving ||
        pet.anim === 'dance' ||
        pet.anim === 'celebrate' ||
        pet.anim === 'scratch' ||
        pet.anim === 'stretch'
      if (lively) anyLively = true
      if (!pet.asleep) allAsleep = false
    }
    const userAway = this.desktop.idleSeconds > 30

    // settings.fps is a ceiling, never a floor — every rule below may only lower it.
    let fps = this.settings.fps
    if (allAsleep) fps = Math.min(fps, userAway ? 4 : 8)
    else if (!anyLively) fps = Math.min(fps, userAway ? 8 : 12)
    if (this.desktop.onBattery) fps = Math.min(fps, 24)

    this.targetFps = Math.max(1, fps)
  }
}
