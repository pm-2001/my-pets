import type { AnimState } from '../brain/pet'
import { PET_HEIGHT } from '../brain/pet'

/**
 * The pet: a front-facing kawaii cat, drawn procedurally with Canvas2D.
 *
 * Everything is drawn immediate-mode each frame — no image assets — so each pet
 * keeps its own seeded coat colour (with a matching darker outline) while sharing
 * one friendly face. The behaviour engine is untouched: `update()` advances a
 * lerped `Pose`, `draw()` renders it.
 *
 * Posture follows movement. Standing still, the cat *sits* — belly to the ground,
 * two front paws, tail curled. To walk it *stands up on four legs* that step in
 * diagonal pairs, and sits back down when it stops; a `stand` value blends
 * smoothly between the two. Squash-and-stretch is kept gentle so it never
 * flattens into a pancake.
 *
 * Outlines use a "stroke behind" trick: fill the whole silhouette first, then
 * stroke it again with `destination-over` so only the outer rim shows — a single
 * clean outline with no seams where head, body, legs and ears overlap.
 */

interface Pose {
  /** Vertical sink of the whole cat; positive lowers it (sit/sleep). */
  bodyY: number
  bodyRot: number
  bodyScaleY: number
  bodyScaleX: number
  headRot: number
  headY: number
  legSwing: number
  legRate: number
  /** 0 closed, 1 wide open. */
  eyeOpen: number
  tailBase: number
  tailWag: number
  tailRate: number
  /** Ears prick up as this rises, droop when negative. */
  earPerk: number
  /** Raises the front paws, for waving / celebrating / scratching. */
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
  tailBase: 0,
  tailWag: 0.06,
  tailRate: 1.4,
  earPerk: 0,
  frontPaw: 0,
}

const POSES: Record<AnimState, Partial<Pose>> = {
  idle: {},
  look: { earPerk: 0.4, tailWag: 0.14, tailRate: 2.2 },
  walk: { legRate: 9, tailWag: 0.18, tailRate: 5, earPerk: 0.1 },
  run: { legRate: 17, tailWag: 0.24, tailRate: 9, earPerk: 0.2 },
  sit: { bodyY: 3, tailWag: 0.08, tailRate: 1.1 },
  // Lowers and closes its eyes — a gentle settle, not a flattening.
  sleep: { bodyY: 7, bodyScaleY: 0.95, eyeOpen: 0, earPerk: -0.3, tailWag: 0.03, tailRate: 0.5 },
  jump: { bodyScaleY: 1.08, bodyScaleX: 0.95, earPerk: 0.5, frontPaw: 0.35, tailWag: 0.2 },
  fall: { bodyScaleY: 1.05, bodyScaleX: 0.97, earPerk: 0.55, frontPaw: 0.2 },
  stretch: { bodyY: -2, bodyScaleY: 1.08, bodyScaleX: 0.96, eyeOpen: 0.3, earPerk: 0.2 },
  dance: { earPerk: 0.5, tailWag: 0.5, tailRate: 12, headRot: 0.14 },
  celebrate: { earPerk: 0.85, tailWag: 0.45, tailRate: 11, frontPaw: 1, eyeOpen: 1 },
  scratch: { frontPaw: 1, earPerk: 0.3, tailWag: 0.2, tailRate: 4 },
  climb: { frontPaw: 1, earPerk: 0.3, tailWag: 0.08 },
}

const H = PET_HEIGHT

function css(color: number): string {
  return `#${(color & 0xffffff).toString(16).padStart(6, '0')}`
}

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

function ellipsePath(ctx: CanvasRenderingContext2D, cx: number, cy: number, rx: number, ry: number): void {
  ctx.beginPath()
  ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2)
}

interface Leg {
  x: number
  /** Y the leg attaches under the body. */
  topY: number
  /** How far the paw is lifted off the ground this frame. */
  lift: number
  front: boolean
}

export class CatRenderer {
  private coat: string
  private coatHi: string
  private coatLo: string
  private outline: string
  private belly: string
  private readonly pink = '#eba7c6'
  private readonly blush = 'rgba(233, 150, 180, 0.55)'
  private readonly nose = '#c98ba6'
  private readonly eye = '#2b2533'

  private pose: Pose = { ...REST }
  private legPhase = 0
  private blinkTimer = 2
  private blinkAmount = 1
  private squash = 0
  private squashVelocity = 0
  private time = 0
  /** 0 sitting, 1 standing on all fours; blends with movement. */
  private stand = 0

  private anim: AnimState = 'idle'
  private facing: 1 | -1 = 1
  private scale = 1

  // Per-frame posture, computed once in drawCat and read by the draw passes.
  private bodyCY = 0
  private bodyRx = 0
  private bodyRy = 0
  private headCY = 0
  private legs: Leg[] = []

  constructor(palette: { coat: number; belly: number; accent: number }) {
    this.coat = css(palette.coat)
    this.coatHi = css(lighten(palette.coat, 0.2))
    this.coatLo = css(darken(palette.coat, 0.13))
    this.outline = css(darken(palette.coat, 0.55))
    this.belly = css(lighten(palette.coat, 0.82))
  }

  update(dt: number, anim: AnimState, facing: 1 | -1, speed: number, scale: number): void {
    this.time += dt
    this.anim = anim
    this.facing = facing
    this.scale = scale

    const target = { ...REST, ...POSES[anim] }
    const k = 1 - Math.exp(-12 * dt)
    for (const key of Object.keys(this.pose) as (keyof Pose)[]) {
      this.pose[key] += (target[key] - this.pose[key]) * k
    }

    // Stand up to walk/run, sit back down otherwise.
    const wantStand = anim === 'walk' || anim === 'run' ? 1 : 0
    this.stand += (wantStand - this.stand) * (1 - Math.exp(-9 * dt))

    this.updateBlink(dt, target.eyeOpen)
    this.updateSquash(dt)

    const rate = this.pose.legRate > 0 ? this.pose.legRate : 0
    this.legPhase += (rate + Math.abs(speed) * 0.05) * dt
  }

  /** Draw the pet with its feet at the current context origin. */
  draw(ctx: CanvasRenderingContext2D): void {
    const p = this.pose
    const sleeping = this.anim === 'sleep'
    const breath = Math.sin(this.time * (sleeping ? 1.1 : 2.4)) * (sleeping ? 0.028 : 0.014)
    const airborne = this.anim === 'jump' || this.anim === 'fall'
    // Body bobs as it strides.
    const bob = Math.abs(Math.sin(this.legPhase)) * H * 0.03 * this.stand
    const lean = this.stand * this.facing * 0.05 + (this.anim === 'dance' ? Math.sin(this.time * 6) * 0.12 : 0)

    if (!airborne && this.anim !== 'climb') {
      ctx.save()
      ctx.scale(this.scale, this.scale)
      const sw = H * (0.44 - 0.06 * this.stand)
      const g = ctx.createRadialGradient(0, -H * 0.01, 0, 0, -H * 0.01, sw)
      g.addColorStop(0, 'rgba(0,0,0,0.2)')
      g.addColorStop(1, 'rgba(0,0,0,0)')
      ellipsePath(ctx, 0, -H * 0.01, sw, H * 0.09)
      ctx.fillStyle = g
      ctx.fill()
      ctx.restore()
    }

    ctx.save()
    ctx.scale(this.scale, this.scale)
    ctx.translate(0, -bob + p.bodyY)
    // Keep squash/stretch subtle so the cat never flattens into a pancake.
    const sx = p.bodyScaleX * (1 - this.squash * 0.16)
    const sy = (p.bodyScaleY + breath) * (1 + this.squash * 0.22)
    ctx.scale(sx, sy)
    ctx.rotate(lean)

    this.drawCat(ctx)
    this.drawZs(ctx)

    ctx.restore()
  }

  private drawCat(ctx: CanvasRenderingContext2D): void {
    const stand = this.stand
    // Standing lifts and narrows the body so all four legs show beneath and
    // beside it; the hind pair sits just outside the body's edge.
    this.bodyCY = -H * (0.42 + 0.17 * stand)
    this.bodyRx = H * (0.36 - 0.05 * stand)
    this.bodyRy = H * (0.42 - 0.13 * stand)
    this.headCY = -H * (0.95 + 0.08 * stand)

    // Four legs, stepping in diagonal pairs (front-left with hind-right).
    const amp = H * 0.08 * stand
    const sF = Math.max(0, Math.sin(this.legPhase))
    const sB = Math.max(0, Math.sin(this.legPhase + Math.PI))
    const bodyBottom = this.bodyCY + this.bodyRy
    // Front paws keep a small presence even when sitting; hind legs only emerge
    // as the cat stands (they hide behind the wider sitting body).
    const frontTop = Math.min(-H * 0.14, bodyBottom + H * 0.04)
    const hindTop = bodyBottom - H * 0.02
    this.legs = [
      { x: -H * 0.33, topY: hindTop, lift: sB * amp, front: false },
      { x: H * 0.33, topY: hindTop, lift: sF * amp, front: false },
      { x: -H * 0.13, topY: frontTop, lift: sF * amp, front: true },
      { x: H * 0.13, topY: frontTop, lift: sB * amp, front: true },
    ]

    this.silhouette(ctx, 'fill')
    this.shade(ctx)
    ctx.save()
    ctx.globalCompositeOperation = 'destination-over'
    this.silhouette(ctx, 'stroke')
    ctx.restore()
    this.face(ctx)
  }

  private silhouette(ctx: CanvasRenderingContext2D, mode: 'fill' | 'stroke'): void {
    const p = this.pose
    const line = Math.max(1.5, H * 0.055)
    const stroke = mode === 'stroke'
    ctx.lineJoin = 'round'
    ctx.lineCap = 'round'
    ctx.lineWidth = line
    ctx.strokeStyle = this.outline
    const paint = (fill: string) => {
      if (stroke) ctx.stroke()
      else {
        ctx.fillStyle = fill
        ctx.fill()
      }
    }

    const leg = (l: Leg) => {
      const w = l.front ? H * 0.14 : H * 0.13
      const bottom = -l.lift
      if (bottom - l.topY < H * 0.02) return
      ctx.beginPath()
      ctx.roundRect(l.x - w / 2, l.topY, w, bottom - l.topY, w * 0.5)
      // Hind legs are a shade darker so they read as further back.
      paint(l.front ? this.coat : this.coatLo)
    }

    // --- tail: curled beside a sitting cat, raised up and back when it stands
    // to walk so it clears the hind legs ---
    const tSide = -this.facing
    const wag = Math.sin(this.time * p.tailRate) * p.tailWag
    ctx.save()
    ctx.translate(tSide * H * (0.26 - 0.06 * this.stand), -H * (0.16 + 0.28 * this.stand))
    ctx.rotate(tSide * (0.2 - 0.5 * this.stand + wag))
    ctx.beginPath()
    ctx.moveTo(0, 0)
    ctx.quadraticCurveTo(tSide * H * 0.44, -H * 0.02, tSide * H * 0.5, -H * 0.34)
    ctx.quadraticCurveTo(tSide * H * 0.54, -H * 0.6, tSide * H * 0.34, -H * 0.66)
    if (stroke) {
      ctx.lineWidth = line + H * 0.16
      ctx.stroke()
      ctx.lineWidth = line
    } else {
      ctx.lineWidth = H * 0.16
      ctx.strokeStyle = this.coat
      ctx.stroke()
      ctx.strokeStyle = this.outline
      ctx.lineWidth = line
    }
    ctx.restore()

    // --- hind legs (behind the body) ---
    for (const l of this.legs) if (!l.front) leg(l)

    // --- body ---
    ellipsePath(ctx, 0, this.bodyCY, this.bodyRx, this.bodyRy)
    paint(this.coat)

    // --- front legs (in front of the body) ---
    for (const l of this.legs) if (l.front) leg(l)

    // --- head ---
    ellipsePath(ctx, 0, this.headCY, H * 0.46, H * 0.42)
    paint(this.coat)

    // --- ears ---
    const eTop = this.headCY - H * 0.23
    for (const side of [-1, 1] as const) {
      const perk = p.earPerk * 0.12
      ctx.beginPath()
      ctx.moveTo(side * H * 0.44, eTop + H * (0.05 - perk))
      ctx.quadraticCurveTo(side * H * 0.28, eTop - H * (0.27 + perk), side * H * 0.12, eTop - H * (0.05 + perk * 0.4))
      ctx.quadraticCurveTo(side * H * 0.3, eTop + H * 0.07, side * H * 0.44, eTop + H * (0.05 - perk))
      ctx.closePath()
      paint(this.coat)
    }
  }

  private shade(ctx: CanvasRenderingContext2D): void {
    // Head highlight (light from upper-left).
    ctx.globalAlpha = 0.5
    ellipsePath(ctx, -H * 0.16, this.headCY - H * 0.11, H * 0.16, H * 0.2)
    ctx.fillStyle = this.coatHi
    ctx.fill()
    // Soft shadow on the lower-right of the body.
    ctx.globalAlpha = 0.26
    ellipsePath(ctx, H * 0.13, this.bodyCY + H * 0.02, this.bodyRx * 0.7, this.bodyRy * 0.9)
    ctx.fillStyle = this.coatLo
    ctx.fill()
    ctx.globalAlpha = 1

    // White belly bib (chest down the front).
    const top = this.bodyCY - this.bodyRy * 0.72
    ctx.beginPath()
    ctx.moveTo(0, top)
    ctx.quadraticCurveTo(H * 0.24, this.bodyCY - H * 0.16, H * 0.18, this.bodyCY + this.bodyRy * 0.62)
    ctx.quadraticCurveTo(H * 0.1, this.bodyCY + this.bodyRy, 0, this.bodyCY + this.bodyRy)
    ctx.quadraticCurveTo(-H * 0.1, this.bodyCY + this.bodyRy, -H * 0.18, this.bodyCY + this.bodyRy * 0.62)
    ctx.quadraticCurveTo(-H * 0.24, this.bodyCY - H * 0.16, 0, top)
    ctx.fillStyle = this.belly
    ctx.fill()

    // Inner ears (pink).
    const eTop = this.headCY - H * 0.23
    for (const side of [-1, 1] as const) {
      const perk = this.pose.earPerk * 0.12
      ctx.beginPath()
      ctx.moveTo(side * H * 0.38, eTop + H * (0.04 - perk))
      ctx.quadraticCurveTo(side * H * 0.27, eTop - H * (0.19 + perk), side * H * 0.16, eTop - H * (0.03 + perk * 0.4))
      ctx.quadraticCurveTo(side * H * 0.29, eTop + H * 0.05, side * H * 0.38, eTop + H * (0.04 - perk))
      ctx.closePath()
      ctx.fillStyle = this.pink
      ctx.fill()
    }
  }

  private face(ctx: CanvasRenderingContext2D): void {
    const open = Math.max(0.06, this.blinkAmount)
    const cy = this.headCY

    // Blush cheeks.
    for (const side of [-1, 1] as const) {
      ellipsePath(ctx, side * H * 0.29, cy + H * 0.08, H * 0.09, H * 0.055)
      ctx.fillStyle = this.blush
      ctx.fill()
    }

    // Eyes: big glossy black with catchlights; happy arcs when asleep.
    for (const side of [-1, 1] as const) {
      const ex = side * H * 0.17
      if (open < 0.25) {
        ctx.beginPath()
        ctx.lineWidth = Math.max(1.5, H * 0.03)
        ctx.strokeStyle = this.eye
        ctx.lineCap = 'round'
        ctx.arc(ex, cy - H * 0.01, H * 0.08, Math.PI * 0.15, Math.PI * 0.85)
        ctx.stroke()
      } else {
        ctx.save()
        ctx.translate(ex, cy - H * 0.01)
        ctx.scale(1, open)
        ellipsePath(ctx, 0, 0, H * 0.1, H * 0.13)
        ctx.fillStyle = this.eye
        ctx.fill()
        ellipsePath(ctx, -H * 0.03, -H * 0.04, H * 0.035, H * 0.045)
        ctx.fillStyle = '#ffffff'
        ctx.fill()
        ellipsePath(ctx, H * 0.03, H * 0.04, H * 0.02, H * 0.025)
        ctx.fillStyle = 'rgba(255,255,255,0.85)'
        ctx.fill()
        ctx.restore()
      }
    }

    // Nose + ω mouth.
    ctx.beginPath()
    ctx.moveTo(-H * 0.035, cy + H * 0.14)
    ctx.quadraticCurveTo(0, cy + H * 0.19, H * 0.035, cy + H * 0.14)
    ctx.quadraticCurveTo(H * 0.01, cy + H * 0.13, 0, cy + H * 0.135)
    ctx.quadraticCurveTo(-H * 0.01, cy + H * 0.13, -H * 0.035, cy + H * 0.14)
    ctx.fillStyle = this.nose
    ctx.fill()

    ctx.strokeStyle = this.outline
    ctx.lineWidth = Math.max(1, H * 0.016)
    ctx.lineCap = 'round'
    ctx.beginPath()
    ctx.moveTo(0, cy + H * 0.16)
    ctx.lineTo(0, cy + H * 0.19)
    ctx.moveTo(0, cy + H * 0.19)
    ctx.quadraticCurveTo(-H * 0.05, cy + H * 0.235, -H * 0.09, cy + H * 0.2)
    ctx.moveTo(0, cy + H * 0.19)
    ctx.quadraticCurveTo(H * 0.05, cy + H * 0.235, H * 0.09, cy + H * 0.2)
    ctx.stroke()

    // Whiskers.
    ctx.lineWidth = Math.max(0.8, H * 0.012)
    ctx.globalAlpha = 0.75
    for (const side of [-1, 1] as const) {
      for (const dy of [-0.03, 0, 0.03]) {
        ctx.beginPath()
        ctx.moveTo(side * H * 0.16, cy + H * (0.16 + dy))
        ctx.lineTo(side * H * 0.5, cy + H * (0.13 + dy * 2.4))
        ctx.stroke()
      }
    }
    ctx.globalAlpha = 1

    // Toe lines on paws that are planted.
    ctx.lineWidth = Math.max(0.8, H * 0.013)
    for (const l of this.legs) {
      if (l.lift > H * 0.01) continue
      const w = (l.front ? H * 0.14 : H * 0.13) * 0.5
      for (const t of [-0.4, 0.4]) {
        ctx.beginPath()
        ctx.moveTo(l.x + w * t, -H * 0.05)
        ctx.lineTo(l.x + w * t, -H * 0.005)
        ctx.stroke()
      }
    }
  }

  private drawZs(ctx: CanvasRenderingContext2D): void {
    if (this.anim !== 'sleep') return
    ctx.save()
    ctx.translate(H * 0.36, this.headCY - H * 0.28)
    ctx.strokeStyle = this.outline
    ctx.lineWidth = Math.max(1.5, H * 0.02)
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
    for (let i = 0; i < 3; i++) {
      const phase = (this.time * 0.42 + i / 3) % 1
      const s = 0.6 + phase * 0.7
      ctx.globalAlpha = Math.sin(phase * Math.PI) * 0.8
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

  boundsFor(scale: number): { left: number; top: number; width: number; height: number } {
    return {
      left: -1.2 * H * scale,
      top: -1.72 * H * scale,
      width: 2.4 * H * scale,
      height: 2.0 * H * scale,
    }
  }

  impact(force: number): void {
    this.squashVelocity += Math.min(1, force / 600) * 6
  }

  private updateSquash(dt: number): void {
    this.squashVelocity += -this.squash * 220 * dt
    this.squashVelocity *= Math.exp(-11 * dt)
    this.squash += this.squashVelocity * dt
  }

  private updateBlink(dt: number, targetOpen: number): void {
    if (targetOpen < 0.3) {
      this.blinkAmount += (targetOpen - this.blinkAmount) * (1 - Math.exp(-10 * dt))
      return
    }
    this.blinkTimer -= dt
    if (this.blinkTimer <= 0) {
      this.blinkTimer = 1.8 + Math.random() * 4.5
      this.blinkAmount = 0
    }
    this.blinkAmount += (targetOpen - this.blinkAmount) * (1 - Math.exp(-18 * dt))
  }
}
