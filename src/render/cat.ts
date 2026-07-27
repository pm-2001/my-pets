import type { AnimState } from '../brain/pet'
import { PET_HEIGHT } from '../brain/pet'

/**
 * The pet: a flat-vector side-profile cat, drawn procedurally on a small
 * skeleton so every movement is defined by joints rather than hand-drawn frames.
 *
 * The rig, in body-local units (origin at the ground between the paws, +x is the
 * way the cat faces, -y is up):
 *   - a spine from hip -> shoulder, a neck/head off the shoulder, a 3-joint tail
 *     off the hip (all forward-kinematic);
 *   - four legs, each a thigh + shank solved by 2-bone IK to a *foot target* on
 *     (or above) the ground, so paws plant and the knees bend correctly.
 *
 * `update()` lerps a small set of rig parameters towards a per-state target and
 * advances the walk cycle; `draw()` solves the skeleton and paints flat shapes on
 * it. No image assets, so each pet keeps its own seeded coat colour. Facing flips
 * the whole rig horizontally.
 */

const H = PET_HEIGHT

function css(color: number): string {
  return `#${(color & 0xffffff).toString(16).padStart(6, '0')}`
}
function lighten(color: number, a: number): number {
  const r = (color >> 16) & 0xff, g = (color >> 8) & 0xff, b = color & 0xff
  const m = (c: number) => Math.round(c + (255 - c) * a)
  return (m(r) << 16) | (m(g) << 8) | m(b)
}
function darken(color: number, a: number): number {
  const r = (color >> 16) & 0xff, g = (color >> 8) & 0xff, b = color & 0xff
  const m = (c: number) => Math.round(c * (1 - a))
  return (m(r) << 16) | (m(g) << 8) | m(b)
}

interface Vec { x: number; y: number }

/** The tunable state of the skeleton — what a pose sets and update() lerps. */
interface Rig {
  hipY: number      // hip height above ground (up = larger)
  shoulderY: number // shoulder height above ground
  bodyLen: number   // hip -> shoulder distance
  headAngle: number // neck angle: 0 level, + lowers the muzzle
  headOut: number   // how far the head reaches forward from the shoulder
  earPerk: number
  eyeOpen: number
  tail: [number, number, number] // three tail joint angles (rad)
  /** Foot targets, in ground-local x offset from their rest column; y is lift. */
  gait: number      // 0 planted, 1 full walk cycle
  stride: number    // stride length in units of H
  crouch: number    // lowers everything (sleep)
}

const STAND: Rig = {
  hipY: 0.58,
  shoulderY: 0.58,
  bodyLen: 0.92,
  headAngle: 0,
  headOut: 1,
  earPerk: 0,
  eyeOpen: 1,
  // Up and back off the rump, tip curling forward — a proud upright tail.
  tail: [-2.05, 0.5, 0.55],
  gait: 0,
  stride: 0.12,
  crouch: 0,
}

function poseFor(anim: AnimState): Partial<Rig> {
  switch (anim) {
    case 'walk':
      return { gait: 1, stride: 0.12, tail: [-2.0, 0.45, 0.5], earPerk: 0.1 }
    case 'run':
      return { gait: 1, stride: 0.2, hipY: 0.56, shoulderY: 0.58, tail: [-1.85, 0.35, 0.4], earPerk: 0.2, headAngle: 0.1 }
    case 'look':
      return { earPerk: 0.5, headAngle: -0.15, tail: [-2.0, 0.4, 0.4] }
    case 'sit':
      // Haunches down at the back, forelegs straight, chest up.
      return { hipY: 0.26, shoulderY: 0.64, bodyLen: 0.5, tail: [-1.7, -0.2, -0.2], headAngle: -0.05 }
    case 'sleep':
      // A low loaf with the head tucked down.
      return { hipY: 0.2, shoulderY: 0.24, bodyLen: 0.66, crouch: 0.12, headAngle: 0.5, headOut: 0.7, eyeOpen: 0, earPerk: -0.3, tail: [-1.2, 0.3, 0.5] }
    case 'stretch':
      return { hipY: 0.7, shoulderY: 0.42, bodyLen: 0.72, headAngle: -0.2, tail: [-2.7, -0.6, -0.5], eyeOpen: 0.4 }
    case 'jump':
      return { hipY: 0.74, shoulderY: 0.78, bodyLen: 0.58, headAngle: -0.2, earPerk: 0.4, tail: [-2.9, -0.7, -0.6] }
    case 'fall':
      return { hipY: 0.5, shoulderY: 0.52, headAngle: 0.1, earPerk: 0.5, tail: [-1.8, 0.2, 0.3] }
    case 'dance':
      return { earPerk: 0.5, tail: [-2.2, -0.6, -0.6], headAngle: -0.1 }
    case 'celebrate':
      return { earPerk: 0.8, hipY: 0.62, tail: [-2.7, -0.7, -0.6], headAngle: -0.2 }
    case 'scratch':
      return { earPerk: 0.3, tail: [-2.3, -0.3, -0.3] }
    case 'climb':
      return { headAngle: -0.3, earPerk: 0.3, tail: [-1.6, -0.2, -0.2] }
    default:
      return {}
  }
}

/** Solve a 2-bone chain from joint J so the paw reaches target F; return the knee. */
function ik(J: Vec, F: Vec, l1: number, l2: number, bend: number): Vec {
  let dx = F.x - J.x, dy = F.y - J.y
  let d = Math.hypot(dx, dy)
  const min = Math.abs(l1 - l2) + 1e-3
  const max = l1 + l2 - 1e-3
  if (d < min) d = min
  if (d > max) d = max
  const base = Math.atan2(dy, dx)
  const cosA = (d * d + l1 * l1 - l2 * l2) / (2 * d * l1)
  const a = Math.acos(Math.max(-1, Math.min(1, cosA)))
  const ka = base + bend * a
  return { x: J.x + l1 * Math.cos(ka), y: J.y + l1 * Math.sin(ka) }
}

export class CatRenderer {
  private coat: string
  private stripe: string
  private shade: string
  private belly: string
  private ear: string
  private dark: string

  private rig: Rig = { ...STAND, tail: [...STAND.tail] as [number, number, number] }
  private legPhase = 0
  private blinkTimer = 2
  private blinkAmount = 1
  private squash = 0
  private squashVelocity = 0
  private time = 0

  private anim: AnimState = 'idle'
  private facing: 1 | -1 = 1
  private scale = 1

  constructor(palette: { coat: number; belly: number; accent: number }) {
    this.coat = css(palette.coat)
    this.stripe = css(darken(palette.coat, 0.17))
    this.shade = css(darken(palette.coat, 0.1))
    this.belly = css(lighten(palette.coat, 0.55))
    this.ear = css(lighten(palette.coat, 0.28))
    this.dark = css(darken(palette.coat, 0.62))
  }

  update(dt: number, anim: AnimState, facing: 1 | -1, speed: number, scale: number): void {
    this.time += dt
    this.anim = anim
    this.facing = facing
    this.scale = scale

    const target: Rig = { ...STAND, ...poseFor(anim) }
    const k = 1 - Math.exp(-11 * dt)
    this.rig.hipY += (target.hipY - this.rig.hipY) * k
    this.rig.shoulderY += (target.shoulderY - this.rig.shoulderY) * k
    this.rig.bodyLen += (target.bodyLen - this.rig.bodyLen) * k
    this.rig.headAngle += (target.headAngle - this.rig.headAngle) * k
    this.rig.headOut += (target.headOut - this.rig.headOut) * k
    this.rig.earPerk += (target.earPerk - this.rig.earPerk) * k
    this.rig.gait += (target.gait - this.rig.gait) * k
    this.rig.stride += (target.stride - this.rig.stride) * k
    this.rig.crouch += (target.crouch - this.rig.crouch) * k
    this.rig.tail[0] += (target.tail[0] - this.rig.tail[0]) * k
    this.rig.tail[1] += (target.tail[1] - this.rig.tail[1]) * k
    this.rig.tail[2] += (target.tail[2] - this.rig.tail[2]) * k

    this.updateBlink(dt, target.eyeOpen)
    this.updateSquash(dt)
    // Advance the walk cycle only while there is gait; faster when running.
    if (this.rig.gait > 0.03) {
      const rate = 5 + Math.abs(speed) * 0.06 + (anim === 'run' ? 5 : 0)
      this.legPhase += rate * dt
    }
  }

  draw(ctx: CanvasRenderingContext2D): void {
    const r = this.rig
    const breath = Math.sin(this.time * (this.anim === 'sleep' ? 1.1 : 2.4)) * (this.anim === 'sleep' ? 0.02 : 0.01)
    const crouch = r.crouch * H

    // --- key joints (canonical: facing +x, ground at y=0) ---
    const halfLen = r.bodyLen * 0.5 * H
    const hip: Vec = { x: -halfLen, y: -r.hipY * H + crouch }
    const shoulder: Vec = { x: halfLen, y: -r.shoulderY * H + crouch }
    // Neck/head off the shoulder.
    const spineA = Math.atan2(shoulder.y - hip.y, shoulder.x - hip.x)
    // Neck rises from the front of the chest; the head sits close above it.
    const neck: Vec = { x: shoulder.x + H * 0.1, y: shoulder.y - H * 0.08 }
    const headBob = Math.abs(Math.sin(this.legPhase)) * H * 0.015 * r.gait
    const head: Vec = {
      x: neck.x + Math.cos(-0.4 + r.headAngle) * H * 0.19 * r.headOut,
      y: neck.y + Math.sin(-0.4 + r.headAngle) * H * 0.19 * r.headOut + headBob,
    }

    // --- feet (IK targets) ---
    const walk = r.gait
    const foot = (restX: number, phaseOff: number): Vec => {
      const t = ((this.legPhase / (Math.PI * 2) + phaseOff) % 1 + 1) % 1
      let fx = restX
      let fy = 0
      if (walk > 0.02) {
        if (t < 0.5) {
          // Stance: paw planted, sliding backward from +stride to -stride.
          fx = restX + r.stride * H * (1 - 4 * t)
        } else {
          // Swing: lift and swing forward from -stride back to +stride.
          const u = (t - 0.5) / 0.5
          fx = restX + r.stride * H * (2 * u - 1)
          fy = -Math.sin(u * Math.PI) * H * 0.16
        }
        fx = restX + (fx - restX) * walk
        fy *= walk
      }
      return { x: fx, y: fy }
    }
    // Front legs hang from the shoulder, back legs from the hip; near/far offset.
    // Legs hang from the belly straight down (feet under their joints).
    const belly = H * 0.19
    const jFrontNear: Vec = { x: shoulder.x - H * 0.08, y: shoulder.y + belly }
    const jFrontFar: Vec = { x: shoulder.x - H * 0.02, y: shoulder.y + belly }
    const jBackNear: Vec = { x: hip.x + H * 0.08, y: hip.y + belly }
    const jBackFar: Vec = { x: hip.x + H * 0.02, y: hip.y + belly }
    const fFrontNear = foot(shoulder.x - H * 0.08, 0)
    const fFrontFar = foot(shoulder.x - H * 0.02, 0.5)
    const fBackNear = foot(hip.x + H * 0.08, 0.5)
    const fBackFar = foot(hip.x + H * 0.02, 0)

    // --- paint ---
    ctx.save()
    ctx.scale(this.facing * this.scale, this.scale)

    // Far legs (behind the body), darker.
    this.drawLeg(ctx, jFrontFar, fFrontFar, this.shade)
    this.drawLeg(ctx, jBackFar, fBackFar, this.shade)

    this.drawTail(ctx, hip)
    this.drawBody(ctx, hip, shoulder, spineA, breath)
    this.drawHead(ctx, neck, head)

    // Near legs (in front), full colour.
    this.drawLeg(ctx, jBackNear, fBackNear, this.coat)
    this.drawLeg(ctx, jFrontNear, fFrontNear, this.coat)

    ctx.restore()

    this.drawZs(ctx, head)
  }

  private drawLeg(ctx: CanvasRenderingContext2D, J: Vec, F: Vec, color: string): void {
    const l1 = H * 0.24, l2 = H * 0.26
    // Front legs (positive x joints) bend their elbow back; hind legs bend forward.
    const bend = J.x > 0 ? 1 : -1
    const K = ik(J, F, l1, l2, bend)
    ctx.strokeStyle = color
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
    // Slim legs: a slightly fuller upper leg tapering to a thin shank.
    ctx.lineWidth = H * 0.09
    ctx.beginPath()
    ctx.moveTo(J.x, J.y)
    ctx.lineTo(K.x, K.y)
    ctx.stroke()
    ctx.lineWidth = H * 0.07
    ctx.beginPath()
    ctx.moveTo(K.x, K.y)
    ctx.lineTo(F.x, F.y)
    ctx.stroke()
    // A small paw.
    ctx.beginPath()
    ctx.ellipse(F.x + H * 0.02, F.y - H * 0.01, H * 0.05, H * 0.038, 0, 0, Math.PI * 2)
    ctx.fillStyle = color
    ctx.fill()
  }

  private drawTail(ctx: CanvasRenderingContext2D, hip: Vec): void {
    const r = this.rig
    const wag = Math.sin(this.time * 2.4) * 0.12 * (this.anim === 'walk' || this.anim === 'run' ? 1.6 : 1)
    let x = hip.x - H * 0.08
    let y = hip.y + H * 0.02
    let ang = r.tail[0]!
    const pts: Vec[] = [{ x, y }]
    const segs = [H * 0.24, H * 0.22, H * 0.2]
    for (let i = 0; i < 3; i++) {
      ang += (i === 0 ? 0 : r.tail[i]!) + wag * (i + 1) * 0.5
      x += Math.cos(ang) * segs[i]!
      y += Math.sin(ang) * segs[i]!
      pts.push({ x, y })
    }
    ctx.strokeStyle = this.coat
    ctx.lineCap = 'round'
    ctx.lineWidth = H * 0.13
    ctx.beginPath()
    ctx.moveTo(pts[0]!.x, pts[0]!.y)
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i]!.x, pts[i]!.y)
    ctx.stroke()
    // Tail stripes.
    ctx.strokeStyle = this.stripe
    ctx.lineWidth = H * 0.13
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1]!, b = pts[i]!
      const mx = a.x + (b.x - a.x) * 0.55, my = a.y + (b.y - a.y) * 0.55
      ctx.beginPath()
      ctx.moveTo(a.x + (b.x - a.x) * 0.35, a.y + (b.y - a.y) * 0.35)
      ctx.lineTo(mx, my)
      ctx.stroke()
    }
  }

  private drawBody(ctx: CanvasRenderingContext2D, hip: Vec, shoulder: Vec, spineA: number, breath: number): void {
    const mx = (hip.x + shoulder.x) / 2
    const my = (hip.y + shoulder.y) / 2
    const len = Math.hypot(shoulder.x - hip.x, shoulder.y - hip.y)
    const half = len / 2 + H * 0.16
    const th = H * (0.22 + breath) // half body thickness

    // Work in the body's own frame: +x toward the front (shoulder), y down.
    ctx.save()
    ctx.translate(mx, my)
    ctx.rotate(spineA)

    // Torso: a long rounded rectangle — flat back, rounded rump and chest.
    ctx.fillStyle = this.coat
    ctx.beginPath()
    ctx.roundRect(-half, -th, half * 2, th * 2, [th * 0.95, th * 0.7, th * 0.7, th])
    ctx.fill()
    // A little extra chest fullness at the front-lower.
    ctx.beginPath()
    ctx.ellipse(half - th * 0.35, th * 0.35, th * 0.75, th * 0.95, 0, 0, Math.PI * 2)
    ctx.fill()

    // Cream belly + chest patch along the underside/front.
    ctx.fillStyle = this.belly
    ctx.beginPath()
    ctx.ellipse(half * 0.32, th * 0.55, half * 0.52, th * 0.55, 0, 0, Math.PI * 2)
    ctx.fill()
    ctx.beginPath()
    ctx.ellipse(half - th * 0.4, th * 0.35, th * 0.42, th * 0.62, 0, 0, Math.PI * 2)
    ctx.fill()

    // Tabby stripes over the mid-back.
    ctx.strokeStyle = this.stripe
    ctx.lineCap = 'round'
    ctx.lineWidth = H * 0.05
    for (const fx of [-0.12, 0.02, 0.16, 0.3]) {
      const bx = half * fx
      ctx.beginPath()
      ctx.moveTo(bx, -th * 0.9)
      ctx.lineTo(bx, -th * 0.25)
      ctx.stroke()
    }

    ctx.restore()
  }

  private drawHead(ctx: CanvasRenderingContext2D, neck: Vec, head: Vec): void {
    const r = this.rig
    const perk = r.earPerk * 0.06

    // Neck: a rounded coat bridge from the chest to the head.
    ctx.strokeStyle = this.coat
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
    ctx.lineWidth = H * 0.24
    ctx.beginPath()
    ctx.moveTo(neck.x - H * 0.02, neck.y + H * 0.12)
    ctx.lineTo(head.x - H * 0.09, head.y + H * 0.08)
    ctx.stroke()

    // Far ear (behind the head), a shade darker.
    ctx.fillStyle = this.shade
    ctx.beginPath()
    ctx.moveTo(head.x - H * 0.17, head.y - H * 0.11)
    ctx.lineTo(head.x - H * 0.11, head.y - H * (0.35 + perk))
    ctx.lineTo(head.x - H * 0.0, head.y - H * 0.15)
    ctx.closePath()
    ctx.fill()

    // Head (large, rounded) + a soft muzzle at the front.
    ctx.fillStyle = this.coat
    ctx.beginPath()
    ctx.ellipse(head.x, head.y, H * 0.215, H * 0.2, 0, 0, Math.PI * 2)
    ctx.fill()
    ctx.beginPath()
    ctx.ellipse(head.x + H * 0.17, head.y + H * 0.07, H * 0.12, H * 0.095, 0, 0, Math.PI * 2)
    ctx.fill()

    // Near ear (front) with a pink inner.
    ctx.fillStyle = this.coat
    ctx.beginPath()
    ctx.moveTo(head.x - H * 0.05, head.y - H * 0.15)
    ctx.lineTo(head.x + H * 0.02, head.y - H * (0.37 + perk))
    ctx.lineTo(head.x + H * 0.15, head.y - H * 0.15)
    ctx.closePath()
    ctx.fill()
    ctx.fillStyle = this.ear
    ctx.beginPath()
    ctx.moveTo(head.x + H * 0.0, head.y - H * 0.16)
    ctx.lineTo(head.x + H * 0.04, head.y - H * (0.3 + perk))
    ctx.lineTo(head.x + H * 0.1, head.y - H * 0.16)
    ctx.closePath()
    ctx.fill()

    // Nose + a short mouth line.
    ctx.fillStyle = this.dark
    ctx.beginPath()
    ctx.moveTo(head.x + H * 0.25, head.y + H * 0.01)
    ctx.lineTo(head.x + H * 0.3, head.y + H * 0.01)
    ctx.lineTo(head.x + H * 0.275, head.y + H * 0.05)
    ctx.closePath()
    ctx.fill()
    ctx.strokeStyle = this.dark
    ctx.lineWidth = Math.max(0.8, H * 0.01)
    ctx.beginPath()
    ctx.moveTo(head.x + H * 0.275, head.y + H * 0.05)
    ctx.lineTo(head.x + H * 0.275, head.y + H * 0.095)
    ctx.stroke()

    // Eye.
    const open = Math.max(0.06, this.blinkAmount)
    ctx.save()
    ctx.translate(head.x + H * 0.09, head.y - H * 0.04)
    ctx.scale(1, open)
    ctx.beginPath()
    ctx.ellipse(0, 0, H * 0.035, H * 0.048, 0, 0, Math.PI * 2)
    ctx.fillStyle = this.dark
    ctx.fill()
    if (open > 0.4) {
      ctx.beginPath()
      ctx.ellipse(H * 0.012, -H * 0.016, H * 0.012, H * 0.014, 0, 0, Math.PI * 2)
      ctx.fillStyle = '#ffffff'
      ctx.fill()
    }
    ctx.restore()

    // Whiskers (short).
    ctx.strokeStyle = this.dark
    ctx.globalAlpha = 0.5
    ctx.lineWidth = Math.max(0.8, H * 0.008)
    for (const dy of [-0.01, 0.02, 0.05]) {
      ctx.beginPath()
      ctx.moveTo(head.x + H * 0.24, head.y + H * (0.04 + dy))
      ctx.lineTo(head.x + H * 0.46, head.y + H * (0.01 + dy * 1.8))
      ctx.stroke()
    }
    ctx.globalAlpha = 1
  }

  private drawZs(ctx: CanvasRenderingContext2D, head: Vec): void {
    if (this.anim !== 'sleep') return
    ctx.save()
    ctx.scale(this.scale, this.scale)
    ctx.translate(this.facing * (head.x + H * 0.2), head.y - H * 0.25)
    ctx.strokeStyle = this.dark
    ctx.lineWidth = Math.max(1.5, H * 0.02)
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
    for (let i = 0; i < 3; i++) {
      const phase = (this.time * 0.42 + i / 3) % 1
      const s = 0.55 + phase * 0.7
      ctx.globalAlpha = Math.sin(phase * Math.PI) * 0.8
      ctx.save()
      ctx.translate(phase * H * 0.16, -phase * H * 0.45)
      ctx.scale(s, s)
      ctx.beginPath()
      ctx.moveTo(0, 0)
      ctx.lineTo(H * 0.07, 0)
      ctx.lineTo(0, H * 0.07)
      ctx.lineTo(H * 0.07, H * 0.07)
      ctx.stroke()
      ctx.restore()
    }
    ctx.restore()
  }

  boundsFor(scale: number): { left: number; top: number; width: number; height: number } {
    return {
      left: -1.1 * H * scale,
      top: -1.35 * H * scale,
      width: 2.2 * H * scale,
      height: 1.55 * H * scale,
    }
  }

  impact(force: number): void {
    this.squashVelocity += Math.min(1, force / 600) * 5
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
