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
  /** 0 legs fully extended, 1 legs retracted/folded under the body (sit/sleep). */
  legTuck: number
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
  legTuck: 0,
}

const POSES: Record<AnimState, Partial<Pose>> = {
  idle: {},
  look: { earPerk: 0.35, tailWag: 0.16, tailRate: 2.2 },
  walk: { legSwing: 0.55, legRate: 9, tailBase: -0.75, tailWag: 0.18, tailRate: 5 },
  run: { legSwing: 0.9, legRate: 17, bodyRot: -0.1, tailBase: -1.15, tailWag: 0.22, tailRate: 9 },
  sit: { bodyY: 11, bodyScaleY: 0.97, bodyScaleX: 1.02, legTuck: 0.55, tailBase: -0.15, tailWag: 0.1, tailRate: 1.1 },
  sleep: {
    bodyY: 14,
    bodyScaleY: 0.95,
    bodyScaleX: 1.04,
    legTuck: 0.9,
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

/** A darker shade of a packed colour, for the far (behind) legs. */
function darken(color: number, amount: number): number {
  const r = (color >> 16) & 0xff, g = (color >> 8) & 0xff, b = color & 0xff
  const m = (c: number) => Math.round(c * (1 - amount))
  return (m(r) << 16) | (m(g) << 8) | m(b)
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number, fill: string): void {
  ctx.beginPath()
  ctx.roundRect(x, y, w, h, r)
  ctx.fillStyle = fill
  ctx.fill()
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
  private coat: string
  private belly: string
  private accent: string
  private shade: string

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
    this.belly = css(palette.belly)
    this.accent = css(palette.accent)
    this.shade = css(darken(palette.coat, 0.16))
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
    this.drawLegs(ctx, 'far')
    this.drawBody(ctx, breath, bob)
    this.drawLegs(ctx, 'near')
    this.drawFrontPaw(ctx)
    this.drawHead(ctx, breath, bob)
    this.drawZs(ctx)

    ctx.restore()
  }

  private drawTail(ctx: CanvasRenderingContext2D): void {
    const p = this.pose
    ctx.save()
    // The tail's root rides with the body's vertical offset, so it stays attached
    // to the rump when the body sinks (e.g. while sleeping) instead of floating.
    ctx.translate(-H * 0.31, -H * 0.4 + p.bodyY)
    for (let i = 0; i < TAIL_SEGMENTS; i++) {
      // Each joint lives in its parent's rotated frame, so transforms accumulate
      // down the chain without a save/restore per joint — that is what makes the
      // wag travel outward as a wave instead of swinging rigidly from the base.
      if (i > 0) ctx.translate(0, -TAIL_LEN)
      const wag = Math.sin(this.time * p.tailRate + i * 0.5) * p.tailWag
      const curl = i === 0 ? p.tailBase - this.speed * 0.0012 : 0.17
      ctx.rotate(curl + wag)
      const width = H * 0.095 * (1 - i * 0.11)
      roundRect(ctx, -width / 2, -TAIL_LEN, width, TAIL_LEN + width / 2, width / 2, i === TAIL_SEGMENTS - 1 ? this.belly : this.coat)
    }
    ctx.restore()
  }

  private drawLegs(ctx: CanvasRenderingContext2D, layer: 'far' | 'near'): void {
    const p = this.pose
    const isFar = layer === 'far'
    const color = isFar ? this.shade : this.coat
    // Far pair: drawn behind the body, a shade darker, tucked further up so the
    // body hides their tops. Near pair: in front. Flat-topped straight legs (a
    // plain column into the body) with a small rounded foot — no rounded pill top.
    const top = isFar ? -H * 0.28 : -H * 0.21
    const len = isFar ? H * 0.3 : H * 0.23
    // Phases follow a real cat's 4-beat lateral-sequence walk: each foot lands a
    // quarter-cycle after the previous, in the order near-hind, near-front,
    // far-hind, far-front — a smooth wave, not a two-beat diagonal bounce.
    const legs: [number, number][] = isFar
      ? [
          [H * 0.22, Math.PI * 1.5], // far front
          [-H * 0.28, Math.PI], // far back
        ]
      : [
          [H * 0.11, Math.PI * 0.5], // near front
          [-H * 0.16, 0], // near back
        ]
    // A leg is two segments hinged at a knee: an upper (hip→knee) that swings with
    // the gait, and a lower (knee→paw) that folds back under the body when tucking.
    const w = H * 0.08
    const upperLen = len * 0.52
    const lowerLen = len * 0.48
    for (const [x, phase] of legs) {
      // Tuck bends the knee (all legs by the same amount, same direction) so the
      // shins fold back parallel under the body instead of the whole leg leaning as
      // a rigid stick; the lowering body then hides the folded shins.
      const swing = Math.sin(this.legPhase + phase) * p.legSwing
      const kneeBend = p.legTuck * (Math.PI * 0.62)
      ctx.save()
      ctx.translate(x, top + p.bodyY * 0.35)
      ctx.rotate(swing)
      ctx.fillStyle = color
      // Upper leg (thigh): hip down to the knee.
      ctx.fillRect(-w / 2, 0, w, upperLen)
      // Knee joint — a small disc so the hinge has no square notch when bent.
      ctx.translate(0, upperLen)
      ellipse(ctx, 0, 0, w / 2, w / 2, color)
      // Lower leg (shin): bends back at the knee.
      ctx.rotate(kneeBend)
      ctx.fillRect(-w / 2, 0, w, lowerLen)
      // Rounded foot.
      ellipse(ctx, 0, lowerLen, H * 0.052, H * 0.045, color)
      ctx.restore()
    }
  }

  private drawBody(ctx: CanvasRenderingContext2D, breath: number, bob: number): void {
    const p = this.pose
    ctx.save()
    ctx.translate(0, -H * 0.38 + p.bodyY - bob)
    ctx.rotate(p.bodyRot + (this.anim === 'dance' ? Math.sin(this.time * 6) * 0.12 : 0))
    ctx.scale(p.bodyScaleX * (1 - this.squash * 0.35), (p.bodyScaleY + breath) * (1 + this.squash * 0.45))
    // A smooth, non-elliptical side body: chest at the front (+x, under the head),
    // an arched back, a rounded rump toward the tail (-x) and a flatter belly.
    // Drawn as a smooth closed curve — each control point is a corner, each anchor
    // the midpoint between two corners, which keeps it round without lumps.
    const pts: [number, number][] = [
      [0.35, -0.02],
      [0.25, -0.18],
      [0.0, -0.23],
      [-0.29, -0.17],
      [-0.44, 0.03],
      [-0.29, 0.22],
      [0.0, 0.26],
      [0.25, 0.18],
    ]
    ctx.beginPath()
    const last = pts[pts.length - 1]!
    ctx.moveTo(((last[0] + pts[0]![0]) / 2) * H, ((last[1] + pts[0]![1]) / 2) * H)
    for (let i = 0; i < pts.length; i++) {
      const cur = pts[i]!
      const nxt = pts[(i + 1) % pts.length]!
      ctx.quadraticCurveTo(cur[0] * H, cur[1] * H, ((cur[0] + nxt[0]) / 2) * H, ((cur[1] + nxt[1]) / 2) * H)
    }
    ctx.closePath()
    ctx.fillStyle = this.coat
    ctx.fill()
    // Belly patch, clipped to the body so its lighter fill can never spill past
    // the body's edge.
    ctx.save()
    ctx.clip()
    ellipse(ctx, H * 0.03, H * 0.14, H * 0.28, H * 0.14, this.belly)
    ctx.restore()
    ctx.restore()
  }

  private drawFrontPaw(ctx: CanvasRenderingContext2D): void {
    const pawUp = this.pose.frontPaw
    if (pawUp <= 0.02) return
    const wave = this.anim === 'scratch' ? Math.sin(this.time * 14) * 0.5 : Math.sin(this.time * 7) * 0.3
    ctx.save()
    ctx.translate(H * 0.21, -H * 0.34 - pawUp * H * 0.08)
    ctx.rotate(-pawUp * 1.1 + wave * pawUp)
    roundRect(ctx, -H * 0.045, 0, H * 0.09, H * 0.2, H * 0.045, this.coat)
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
      poly(ctx, [side * 0.02 * H, -H * 0.01, side * H * 0.11, -H * 0.11, side * H * 0.13, 0], this.accent)
      ctx.restore()
    }

    ellipse(ctx, 0, 0, H * 0.22, H * 0.22, this.coat)

    for (const side of [-1, 1] as const) {
      ctx.save()
      ctx.translate(H * 0.055 + side * H * 0.075, -H * 0.02)
      ctx.scale(1, Math.max(0.08, this.blinkAmount))
      ellipse(ctx, 0, 0, H * 0.035, H * 0.05, this.accent)
      // Catchlight — tiny, but it is most of what makes a face feel alive.
      ellipse(ctx, H * 0.014, -H * 0.018, H * 0.014, H * 0.014, '#ffffff')
      ctx.restore()
    }

    // Nose — centred between the eyes (their midpoint is x = 0.055H), below them.
    const cx = H * 0.055
    poly(ctx, [cx - H * 0.04, H * 0.045, cx + H * 0.04, H * 0.045, cx, H * 0.1], this.accent)

    // Mouth: a little ω just under the nose.
    ctx.strokeStyle = this.accent
    ctx.lineWidth = Math.max(1, H * 0.013)
    ctx.lineCap = 'round'
    ctx.beginPath()
    ctx.moveTo(cx, H * 0.1)
    ctx.lineTo(cx, H * 0.14)
    ctx.moveTo(cx, H * 0.14)
    ctx.quadraticCurveTo(cx - H * 0.04, H * 0.178, cx - H * 0.075, H * 0.145)
    ctx.moveTo(cx, H * 0.14)
    ctx.quadraticCurveTo(cx + H * 0.04, H * 0.178, cx + H * 0.075, H * 0.145)
    ctx.stroke()

    // Whiskers, fanning out from both cheeks.
    ctx.beginPath()
    for (const side of [-1, 1] as const) {
      for (const dy of [-0.015, 0.015]) {
        ctx.moveTo(cx + side * H * 0.05, H * (0.07 + dy))
        ctx.lineTo(cx + side * H * 0.19, H * (0.06 + dy * 1.6))
      }
    }
    ctx.lineWidth = Math.max(1, H * 0.012)
    ctx.strokeStyle = this.accent
    ctx.globalAlpha = 0.55
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
