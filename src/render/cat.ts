import type { AnimState } from '../brain/pet'
import { PET_HEIGHT } from '../brain/pet'

/**
 * The pet, drawn procedurally with Canvas2D.
 *
 * This is a direct port of what used to be a Pixi scene graph. A live WebGL
 * context inside a transparent Electron window carries a large, frame-rate-
 * independent compositing cost, and Canvas2D rasterises this little sprite
 * several times more cheaply — so the whole render layer moved to immediate-mode
 * drawing. The behaviour engine did not change at all; only the drawing did.
 *
 * Every animation is still expressed as a target `Pose`. The current pose is
 * lerped towards the target each frame, which is what gives smooth transitions
 * between states for free: there are no hand-authored blends between "walk" and
 * "sit", the interpolation handles it. `update()` advances that simulation;
 * `draw()` renders the current pose immediately — geometry is not retained
 * between frames, which for a sprite this small is cheaper than it sounds and is
 * exactly the trade the move off WebGL was making.
 */

interface Pose {
  /** Vertical offset of the whole body, in local units. Positive sinks down. */
  bodyY: number
  bodyRot: number
  bodyScaleY: number
  bodyScaleX: number
  headRot: number
  headY: number
  /** Amplitude of the leg swing. Zero holds them still. */
  legSwing: number
  /** How fast the legs cycle, in radians per second. */
  legRate: number
  /** 0 closed, 1 wide open. */
  eyeOpen: number
  tailBase: number
  tailWag: number
  tailRate: number
  /** Ears rotate outward as this rises. */
  earPerk: number
  /** Lifts the front paw, for scratching and waving. */
  frontPaw: number
}

const REST: Pose = {
  bodyY: 0,
  bodyRot: 0,
  bodyScaleY: 1,
  bodyScaleX: 1,
  headRot: 0,
  headY: 0,
  legSwing: 0,
  legRate: 0,
  eyeOpen: 1,
  tailBase: -0.5,
  tailWag: 0.08,
  tailRate: 1.4,
  earPerk: 0,
  frontPaw: 0,
}

const POSES: Record<AnimState, Partial<Pose>> = {
  idle: {},
  look: { earPerk: 0.35, tailWag: 0.16, tailRate: 2.2 },
  walk: { legSwing: 0.55, legRate: 9, tailBase: -0.75, tailWag: 0.18, tailRate: 5 },
  run: { legSwing: 0.9, legRate: 17, bodyRot: -0.1, tailBase: -1.15, tailWag: 0.22, tailRate: 9 },
  sit: { bodyY: 7, bodyScaleY: 0.9, bodyScaleX: 1.04, tailBase: -0.15, tailWag: 0.1, tailRate: 1.1 },
  sleep: {
    bodyY: 13,
    bodyScaleY: 0.72,
    bodyScaleX: 1.16,
    headY: 6,
    headRot: 0.22,
    eyeOpen: 0,
    // Laid down alongside the body rather than raised — a raised tail reads as
    // an alert cat, which fights the rest of the pose.
    tailBase: -1.45,
    tailWag: 0.03,
    tailRate: 0.5,
    earPerk: -0.25,
  },
  jump: { bodyScaleY: 1.12, bodyScaleX: 0.92, legSwing: 0.4, bodyRot: -0.18, tailBase: -1.5, earPerk: 0.4 },
  fall: { bodyScaleY: 1.06, bodyScaleX: 0.96, legSwing: 0.7, bodyRot: 0.14, tailBase: -1.9, earPerk: 0.5 },
  stretch: { bodyY: 5, bodyScaleX: 1.28, bodyScaleY: 0.82, headY: 4, headRot: -0.2, tailBase: -1.7, eyeOpen: 0.25 },
  dance: { bodyRot: 0.16, legSwing: 0.5, legRate: 12, tailWag: 0.5, tailRate: 12, earPerk: 0.5, headRot: -0.12 },
  celebrate: { earPerk: 0.8, tailWag: 0.45, tailRate: 11, headRot: -0.22, frontPaw: 0.9, eyeOpen: 1 },
  scratch: { bodyY: 4, frontPaw: 1, earPerk: 0.3, headRot: -0.1, tailWag: 0.2, tailRate: 4 },
  // Body drawn as usual but reaching: the whole sprite is rotated upright against
  // the wall in draw(). Legs cycle so the paws read as pulling it up hand-over-hand.
  climb: { legSwing: 0.42, legRate: 7, tailBase: -0.35, tailWag: 0.06, tailRate: 1.4, earPerk: 0.28, eyeOpen: 1, bodyScaleX: 1.04 },
}

const TAIL_SEGMENTS = 5
const H = PET_HEIGHT
/** Length of every tail joint; only the widths taper down the chain. */
const TAIL_LEN = H * 0.145

/** 0xRRGGBB (how palettes are stored) to a Canvas2D fill string. */
function css(color: number): string {
  return `#${(color & 0xffffff).toString(16).padStart(6, '0')}`
}

/** Shade helpers on packed 0xRRGGBB, for deriving highlight/shadow tones per pet. */
function lighten(color: number, amount: number): number {
  const r = (color >> 16) & 0xff, g = (color >> 8) & 0xff, b = color & 0xff
  const m = (c: number) => Math.round(c + (255 - c) * amount)
  return (m(r) << 16) | (m(g) << 8) | m(b)
}

function darken(color: number, amount: number): number {
  const r = (color >> 16) & 0xff, g = (color >> 8) & 0xff, b = color & 0xff
  const m = (c: number) => Math.round(c * (1 - amount))
  return (m(r) << 16) | (m(g) << 8) | m(b)
}

function rgba(color: number, alpha: number): string {
  return `rgba(${(color >> 16) & 0xff}, ${(color >> 8) & 0xff}, ${color & 0xff}, ${alpha})`
}

function ellipse(ctx: CanvasRenderingContext2D, cx: number, cy: number, rx: number, ry: number, fill: string): void {
  ctx.beginPath()
  ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2)
  ctx.fillStyle = fill
  ctx.fill()
}

function poly(ctx: CanvasRenderingContext2D, pts: number[], fill: string): void {
  ctx.beginPath()
  ctx.moveTo(pts[0]!, pts[1]!)
  for (let i = 2; i < pts.length; i += 2) ctx.lineTo(pts[i]!, pts[i + 1]!)
  ctx.closePath()
  ctx.fillStyle = fill
  ctx.fill()
}

export class CatRenderer {
  // Base tones plus derived highlight/shadow shades, so the body reads as a
  // rounded volume instead of a flat fill — all keyed off the pet's own palette.
  private coat: string
  private coatHi: string
  private coatLo: string
  private belly: string
  private bellyHi: string
  private stripe: string
  private mouth: string
  // Face features. The iris/nose/inner-ear are warm constants; everything else
  // is per-pet, so cats stay individually coloured but share a friendly face.
  private readonly innerEar = '#d9a0a0'
  private readonly nose = '#d98a8a'
  private readonly noseHi = '#f4cccc'
  private readonly eyeIris = '#c99a3c'
  private readonly eyePupil = '#241c1a'

  private pose: Pose = { ...REST }
  private legPhase = 0
  private blinkTimer = 2
  private blinkAmount = 1
  /** Squash-and-stretch spring, kicked on landing. */
  private squash = 0
  private squashVelocity = 0
  private time = 0

  // Snapshot of the last update(), so draw() is a pure function of stored state.
  private anim: AnimState = 'idle'
  private facing: 1 | -1 = 1
  private scale = 1
  private speed = 0

  constructor(palette: { coat: number; belly: number; accent: number }) {
    this.coat = css(palette.coat)
    this.coatHi = css(lighten(palette.coat, 0.24))
    this.coatLo = css(darken(palette.coat, 0.16))
    this.belly = css(palette.belly)
    this.bellyHi = css(lighten(palette.belly, 0.22))
    this.mouth = css(darken(palette.coat, 0.34))
    this.stripe = rgba(darken(palette.coat, 0.34), 0.26)
  }

  /**
   * Advance the animation simulation. Cheap and allocation-light so it can run
   * every frame for every pet even when the frame is not ultimately drawn.
   *
   * @param facing  1 faces right, -1 faces left
   * @param speed   horizontal speed in points/sec, used to drive gait timing
   */
  update(dt: number, anim: AnimState, facing: 1 | -1, speed: number, scale: number): void {
    this.time += dt
    this.anim = anim
    this.facing = facing
    this.speed = speed
    this.scale = scale

    const target = { ...REST, ...POSES[anim] }
    // Lerp rate tuned so transitions land in roughly a fifth of a second — fast
    // enough to feel responsive, slow enough to read as a movement.
    const k = 1 - Math.exp(-12 * dt)
    for (const key of Object.keys(this.pose) as (keyof Pose)[]) {
      this.pose[key] += (target[key] - this.pose[key]) * k
    }

    this.updateBlink(dt, target.eyeOpen)
    this.updateSquash(dt)

    // Gait phase advances with actual speed so walking and running share one
    // cycle and never look like they are sliding.
    const rate = this.pose.legRate > 0 ? this.pose.legRate : 0
    this.legPhase += (rate + Math.abs(speed) * 0.04) * dt
  }

  /**
   * Draw the pet at the current context origin, which the caller has already
   * translated to the pet's feet. Mirrors the old scene-graph hierarchy exactly:
   * tail, back legs, body, front legs, front paw, head, then sleep glyphs.
   */
  draw(ctx: CanvasRenderingContext2D): void {
    const p = this.pose
    const breathRate = this.anim === 'sleep' ? 1.1 : 2.4
    const breath = Math.sin(this.time * breathRate) * (this.anim === 'sleep' ? 0.05 : 0.022)
    const bob = p.legSwing > 0.05 ? Math.abs(Math.sin(this.legPhase)) * H * 0.02 : 0

    // A soft contact shadow grounds the pet. Skipped while airborne or climbing,
    // where there is nothing directly beneath its feet.
    if (this.anim !== 'climb' && this.anim !== 'jump' && this.anim !== 'fall') {
      ctx.save()
      ctx.scale(this.scale, this.scale)
      const sw = H * 0.46
      const g = ctx.createRadialGradient(0, -H * 0.01, 0, 0, -H * 0.01, sw)
      g.addColorStop(0, 'rgba(0,0,0,0.22)')
      g.addColorStop(1, 'rgba(0,0,0,0)')
      ctx.beginPath()
      ctx.ellipse(0, -H * 0.01, sw, H * 0.1, 0, 0, Math.PI * 2)
      ctx.fillStyle = g
      ctx.fill()
      ctx.restore()
    }

    ctx.save()
    if (this.anim === 'climb') {
      // Cling to a vertical wall, head up, belly and paws toward the wall. `facing`
      // says which side the wall is on: +1 wall on the right, -1 wall on the left.
      // Rotating the normally-horizontal sprite a quarter turn puts the head up and
      // the leg/paw side against the wall; the left case adds a flip to keep it so.
      ctx.scale(this.scale, this.scale)
      if (this.facing === 1) {
        ctx.rotate(-Math.PI / 2)
      } else {
        ctx.rotate(Math.PI / 2)
        ctx.scale(1, -1)
      }
    } else {
      ctx.scale(this.facing * this.scale, this.scale)
    }

    this.drawTail(ctx)
    this.drawLegs(ctx, /* front */ false)
    this.drawBody(ctx, breath, bob)
    this.drawLegs(ctx, /* front */ true)
    this.drawFrontPaw(ctx)
    this.drawHead(ctx, breath, bob)
    this.drawZs(ctx)

    ctx.restore()
  }

  private drawTail(ctx: CanvasRenderingContext2D): void {
    const p = this.pose
    ctx.save()
    ctx.translate(-H * 0.31, -H * 0.4)
    for (let i = 0; i < TAIL_SEGMENTS; i++) {
      // Each joint lives in its parent's rotated frame, so transforms accumulate
      // down the chain without a save/restore per joint — that is what makes the
      // wag travel outward as a wave instead of swinging rigidly from the base.
      if (i > 0) ctx.translate(0, -TAIL_LEN)
      const wag = Math.sin(this.time * p.tailRate + i * 0.5) * p.tailWag
      const curl = i === 0 ? p.tailBase - this.speed * 0.0012 : 0.17
      ctx.rotate(curl + wag)
      const width = H * 0.095 * (1 - i * 0.11)
      const last = i === TAIL_SEGMENTS - 1
      // A left-to-right gradient across the width gives the tail a rounded,
      // cylindrical read; the tip fades to the pale belly tone.
      const g = ctx.createLinearGradient(-width / 2, 0, width / 2, 0)
      if (last) {
        g.addColorStop(0, this.belly)
        g.addColorStop(1, this.bellyHi)
      } else {
        g.addColorStop(0, this.coatLo)
        g.addColorStop(0.5, this.coat)
        g.addColorStop(1, this.coatHi)
      }
      ctx.beginPath()
      ctx.roundRect(-width / 2, -TAIL_LEN, width, TAIL_LEN + width / 2, width / 2)
      ctx.fillStyle = g
      ctx.fill()
      // Faint tabby rings on alternate joints.
      if (!last && i % 2 === 1) {
        ctx.beginPath()
        ctx.roundRect(-width / 2, -TAIL_LEN, width, TAIL_LEN * 0.34, width / 2)
        ctx.fillStyle = this.stripe
        ctx.fill()
      }
    }
    ctx.restore()
  }

  private drawLegs(ctx: CanvasRenderingContext2D, front: boolean): void {
    const p = this.pose
    const xs = front ? [H * 0.1, H * 0.21] : [-H * 0.17, -H * 0.05]
    for (let i = 0; i < xs.length; i++) {
      // Global leg index across the four legs, so diagonal pairs stay in phase.
      const index = front ? i + 2 : i
      const offset = index === 0 || index === 3 ? 0 : Math.PI
      ctx.save()
      ctx.translate(xs[i]!, -H * 0.19 + p.bodyY * 0.35)
      ctx.rotate(Math.sin(this.legPhase + offset) * p.legSwing)
      const g = ctx.createLinearGradient(-H * 0.045, 0, H * 0.045, 0)
      g.addColorStop(0, this.coatLo)
      g.addColorStop(0.55, this.coat)
      g.addColorStop(1, this.coatHi)
      ctx.beginPath()
      ctx.roundRect(-H * 0.045, 0, H * 0.09, H * 0.19, H * 0.045)
      ctx.fillStyle = g
      ctx.fill()
      // A single toe crease at the paw reads as a little foot.
      ctx.strokeStyle = this.coatLo
      ctx.globalAlpha = 0.5
      ctx.lineWidth = Math.max(0.6, H * 0.008)
      ctx.beginPath()
      ctx.moveTo(0, H * 0.165)
      ctx.lineTo(0, H * 0.19)
      ctx.stroke()
      ctx.globalAlpha = 1
      ctx.restore()
    }
  }

  private drawBody(ctx: CanvasRenderingContext2D, breath: number, bob: number): void {
    const p = this.pose
    ctx.save()
    ctx.translate(0, -H * 0.38 + p.bodyY - bob)
    ctx.rotate(p.bodyRot + (this.anim === 'dance' ? Math.sin(this.time * 6) * 0.12 : 0))
    ctx.scale(p.bodyScaleX * (1 - this.squash * 0.35), (p.bodyScaleY + breath) * (1 + this.squash * 0.45))

    // Coat: top-lit vertical gradient for volume.
    const g = ctx.createLinearGradient(0, -H * 0.23, 0, H * 0.23)
    g.addColorStop(0, this.coatHi)
    g.addColorStop(0.55, this.coat)
    g.addColorStop(1, this.coatLo)
    ctx.beginPath()
    ctx.ellipse(0, 0, H * 0.36, H * 0.23, 0, 0, Math.PI * 2)
    ctx.fillStyle = g
    ctx.fill()

    // Tabby stripes down the back, clipped to the body so they never spill out.
    ctx.save()
    ctx.beginPath()
    ctx.ellipse(0, 0, H * 0.36, H * 0.23, 0, 0, Math.PI * 2)
    ctx.clip()
    ctx.strokeStyle = this.stripe
    ctx.lineWidth = H * 0.035
    for (const bx of [-0.2, -0.06, 0.08, 0.2]) {
      ctx.beginPath()
      ctx.moveTo(H * bx, -H * 0.24)
      ctx.quadraticCurveTo(H * (bx + 0.04), 0, H * bx, H * 0.2)
      ctx.stroke()
    }
    ctx.restore()

    // Belly patch with its own soft gradient.
    const bg = ctx.createLinearGradient(0, -H * 0.02, 0, H * 0.21)
    bg.addColorStop(0, this.bellyHi)
    bg.addColorStop(1, this.belly)
    ctx.beginPath()
    ctx.ellipse(H * 0.04, H * 0.09, H * 0.26, H * 0.12, 0, 0, Math.PI * 2)
    ctx.fillStyle = bg
    ctx.fill()

    // A faint top highlight sells the roundness.
    ctx.globalAlpha = 0.16
    ellipse(ctx, -H * 0.06, -H * 0.14, H * 0.2, H * 0.07, this.coatHi)
    ctx.globalAlpha = 1

    ctx.restore()
  }

  private drawFrontPaw(ctx: CanvasRenderingContext2D): void {
    const pawUp = this.pose.frontPaw
    if (pawUp <= 0.02) return
    const wave = this.anim === 'scratch' ? Math.sin(this.time * 14) * 0.5 : Math.sin(this.time * 7) * 0.3
    ctx.save()
    ctx.translate(H * 0.21, -H * 0.34 - pawUp * H * 0.08)
    ctx.rotate(-pawUp * 1.1 + wave * pawUp)
    const g = ctx.createLinearGradient(-H * 0.045, 0, H * 0.045, 0)
    g.addColorStop(0, this.coatLo)
    g.addColorStop(0.55, this.coat)
    g.addColorStop(1, this.coatHi)
    ctx.beginPath()
    ctx.roundRect(-H * 0.045, 0, H * 0.09, H * 0.2, H * 0.045)
    ctx.fillStyle = g
    ctx.fill()
    ctx.restore()
  }

  private drawHead(ctx: CanvasRenderingContext2D, breath: number, bob: number): void {
    const p = this.pose
    ctx.save()
    ctx.translate(H * 0.22, -H * 0.62 + p.headY - bob * 1.4)
    ctx.rotate(p.headRot + (this.anim === 'look' ? Math.sin(this.time * 1.6) * 0.18 : 0) + breath * 0.6)

    // Ears, drawn behind the head so their bases tuck under it.
    for (const side of [-1, 1] as const) {
      ctx.save()
      ctx.translate(side * H * 0.11, -H * 0.13)
      ctx.rotate(side * p.earPerk * 0.5)
      poly(ctx, [0, 0, side * H * 0.13, -H * 0.15, side * H * 0.17, H * 0.03], this.coat)
      poly(ctx, [side * 0.02 * H, -H * 0.01, side * H * 0.11, -H * 0.11, side * H * 0.13, 0], this.innerEar)
      ctx.restore()
    }

    // Head as a top-lit sphere.
    const hg = ctx.createRadialGradient(-H * 0.07, -H * 0.09, H * 0.02, 0, 0, H * 0.24)
    hg.addColorStop(0, this.coatHi)
    hg.addColorStop(0.65, this.coat)
    hg.addColorStop(1, this.coatLo)
    ctx.beginPath()
    ctx.ellipse(0, 0, H * 0.22, H * 0.22, 0, 0, Math.PI * 2)
    ctx.fillStyle = hg
    ctx.fill()

    // A pale muzzle defines the snout.
    ctx.globalAlpha = 0.45
    ellipse(ctx, H * 0.07, H * 0.07, H * 0.13, H * 0.095, this.bellyHi)
    ctx.globalAlpha = 1

    // Eyes: dark almond, amber iris, vertical slit pupil, two catchlights.
    for (const side of [-1, 1] as const) {
      ctx.save()
      ctx.translate(H * 0.055 + side * H * 0.075, -H * 0.02)
      ctx.scale(1, Math.max(0.08, this.blinkAmount))
      ellipse(ctx, 0, 0, H * 0.046, H * 0.058, this.mouth)
      ellipse(ctx, 0, 0, H * 0.037, H * 0.05, this.eyeIris)
      ellipse(ctx, 0, 0, H * 0.013, H * 0.048, this.eyePupil)
      ellipse(ctx, H * 0.016, -H * 0.02, H * 0.013, H * 0.013, '#ffffff')
      ctx.globalAlpha = 0.5
      ellipse(ctx, -H * 0.012, H * 0.018, H * 0.007, H * 0.007, '#ffffff')
      ctx.globalAlpha = 1
      ctx.restore()
    }

    // Nose with a tiny highlight.
    poly(ctx, [H * 0.17, H * 0.05, H * 0.23, H * 0.05, H * 0.2, H * 0.09], this.nose)
    ellipse(ctx, H * 0.192, H * 0.056, H * 0.012, H * 0.008, this.noseHi)

    // A small ω-shaped mouth under the nose.
    ctx.strokeStyle = this.mouth
    ctx.lineWidth = Math.max(0.8, H * 0.01)
    ctx.globalAlpha = 0.6
    ctx.beginPath()
    ctx.moveTo(H * 0.2, H * 0.09)
    ctx.lineTo(H * 0.2, H * 0.115)
    ctx.moveTo(H * 0.2, H * 0.115)
    ctx.quadraticCurveTo(H * 0.16, H * 0.132, H * 0.13, H * 0.105)
    ctx.moveTo(H * 0.2, H * 0.115)
    ctx.quadraticCurveTo(H * 0.24, H * 0.132, H * 0.27, H * 0.105)
    ctx.stroke()
    ctx.globalAlpha = 1

    // Whiskers — pale and fine.
    ctx.beginPath()
    for (const dy of [-0.02, 0.01, 0.04]) {
      ctx.moveTo(H * 0.2, H * (0.06 + dy))
      ctx.lineTo(H * 0.44, H * (0.03 + dy * 2.4))
    }
    ctx.lineWidth = Math.max(0.8, H * 0.01)
    ctx.strokeStyle = '#ffffff'
    ctx.globalAlpha = 0.5
    ctx.stroke()
    ctx.globalAlpha = 1

    ctx.restore()
  }

  private drawZs(ctx: CanvasRenderingContext2D): void {
    if (this.anim !== 'sleep') return
    ctx.save()
    ctx.translate(H * 0.34, -H * 0.85)
    ctx.strokeStyle = '#ffffff'
    ctx.lineWidth = Math.max(1.5, H * 0.02)
    for (let i = 0; i < 3; i++) {
      const phase = (this.time * 0.42 + i / 3) % 1
      const s = 0.6 + phase * 0.7
      // Fade in then out so glyphs do not pop at the start or end of the loop.
      ctx.globalAlpha = Math.sin(phase * Math.PI) * 0.75
      ctx.save()
      ctx.translate(phase * H * 0.18, -phase * H * 0.5)
      ctx.scale(s, s)
      ctx.beginPath()
      ctx.moveTo(0, 0)
      ctx.lineTo(H * 0.08, 0)
      ctx.lineTo(0, H * 0.08)
      ctx.lineTo(H * 0.08, H * 0.08)
      ctx.stroke()
      ctx.restore()
    }
    ctx.globalAlpha = 1
    ctx.restore()
  }

  /**
   * The pet's bounding box in local (unscaled-by-position) points, used by the
   * stage to clear only the pixels a pet touches. It must cover the fully
   * extended tail (which can swing more than a body-length from its root) and the
   * floating sleep glyphs, and it must be symmetric because `facing` mirrors the
   * whole sprite — an under-sized box leaves tail-tip ghosts as the pet walks.
   */
  boundsFor(scale: number): { left: number; top: number; width: number; height: number } {
    // Climbing rotates the whole sprite a quarter turn, swinging the tail down
    // below the feet and the head out to the side. The upright box does not cover
    // that, so a climbing pet needs a larger, near-square box or its tail smears a
    // trail up the wall as it ascends.
    if (this.anim === 'climb') {
      return { left: -1.55 * H * scale, top: -1.55 * H * scale, width: 3.1 * H * scale, height: 2.9 * H * scale }
    }
    return {
      left: -1.2 * H * scale,
      top: -1.45 * H * scale,
      width: 2.4 * H * scale,
      height: 1.65 * H * scale,
    }
  }

  /** Called by the stage when the pet lands, to kick the squash spring. */
  impact(force: number): void {
    this.squashVelocity += Math.min(1, force / 600) * 9
  }

  private updateSquash(dt: number): void {
    // Critically-ish damped spring back to zero.
    this.squashVelocity += -this.squash * 220 * dt
    this.squashVelocity *= Math.exp(-11 * dt)
    this.squash += this.squashVelocity * dt
  }

  private updateBlink(dt: number, targetOpen: number): void {
    if (targetOpen < 0.3) {
      // Asleep or squinting — hold the lids where the pose wants them.
      this.blinkAmount += (targetOpen - this.blinkAmount) * (1 - Math.exp(-10 * dt))
      return
    }

    this.blinkTimer -= dt
    if (this.blinkTimer <= 0) {
      // Irregular intervals; a metronomic blink looks robotic.
      this.blinkTimer = 1.8 + Math.random() * 4.5
      this.blinkAmount = 0
    }
    this.blinkAmount += (targetOpen - this.blinkAmount) * (1 - Math.exp(-18 * dt))
  }
}
