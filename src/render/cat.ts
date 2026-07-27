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
  hipY: 0.6,
  shoulderY: 0.62,
  bodyLen: 0.6,
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
    const hip: Vec = { x: -H * 0.3, y: -r.hipY * H + crouch }
    const shoulder: Vec = { x: H * 0.3, y: -r.shoulderY * H + crouch }
    // Neck/head off the shoulder.
    const spineA = Math.atan2(shoulder.y - hip.y, shoulder.x - hip.x)
    const neck: Vec = { x: shoulder.x + H * 0.12, y: shoulder.y - H * 0.02 }
    const headBob = Math.abs(Math.sin(this.legPhase)) * H * 0.015 * r.gait
    const head: Vec = {
      x: neck.x + Math.cos(-0.5 + r.headAngle) * H * 0.24 * r.headOut,
      y: neck.y + Math.sin(-0.5 + r.headAngle) * H * 0.24 * r.headOut + headBob,
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
    const jFrontNear: Vec = { x: shoulder.x - H * 0.04, y: shoulder.y + H * 0.16 }
    const jFrontFar: Vec = { x: shoulder.x + H * 0.02, y: shoulder.y + H * 0.16 }
    const jBackNear: Vec = { x: hip.x + H * 0.04, y: hip.y + H * 0.16 }
    const jBackFar: Vec = { x: hip.x - H * 0.02, y: hip.y + H * 0.16 }
    const fFrontNear = foot(H * 0.34, 0)
    const fFrontFar = foot(H * 0.34, 0.5)
    const fBackNear = foot(-H * 0.26, 0.5)
    const fBackFar = foot(-H * 0.26, 0)

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
    const l1 = H * 0.26, l2 = H * 0.28
    // Front legs (positive x joints) bend their elbow back; hind legs bend forward.
    const bend = J.x > 0 ? 1 : -1
    const K = ik(J, F, l1, l2, bend)
    ctx.strokeStyle = color
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
    ctx.lineWidth = H * 0.14
    ctx.beginPath()
    ctx.moveTo(J.x, J.y)
    ctx.lineTo(K.x, K.y)
    ctx.stroke()
    ctx.lineWidth = H * 0.1
    ctx.beginPath()
    ctx.moveTo(K.x, K.y)
    ctx.lineTo(F.x, F.y)
    ctx.stroke()
    // Paw.
    ctx.beginPath()
    ctx.ellipse(F.x + H * 0.03, F.y - H * 0.02, H * 0.075, H * 0.055, 0, 0, Math.PI * 2)
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
    // Perpendicular (up) to the spine.
    const nx = Math.sin(spineA), ny = -Math.cos(spineA)
    const topR = H * (0.28 + breath)
    const botR = H * 0.3
    const rump = { x: hip.x - H * 0.06, y: hip.y }
    const withr = (p: Vec, r: number) => ({ x: p.x + nx * r, y: p.y + ny * r })

    // Body outline: back (top) rump -> shoulder, chest down, belly back to rump.
    const backRump = withr(rump, topR)
    const backSh = withr(shoulder, topR * 0.95)
    const chest = { x: shoulder.x + H * 0.16, y: shoulder.y + botR * 0.2 }
    const bellyF = withr(shoulder, -botR)
    const bellyB = withr(rump, -botR * 0.95)

    ctx.fillStyle = this.coat
    ctx.beginPath()
    ctx.moveTo(backRump.x, backRump.y)
    ctx.quadraticCurveTo(hip.x + (shoulder.x - hip.x) * 0.5 + nx * topR * 1.15, hip.y + (shoulder.y - hip.y) * 0.5 + ny * topR * 1.15, backSh.x, backSh.y)
    ctx.quadraticCurveTo(shoulder.x + H * 0.2, shoulder.y - H * 0.02, chest.x, chest.y)
    ctx.quadraticCurveTo(shoulder.x + H * 0.12, shoulder.y + botR * 0.9, bellyF.x, bellyF.y)
    ctx.quadraticCurveTo(hip.x + (shoulder.x - hip.x) * 0.5 - nx * botR * 1.05, hip.y + (shoulder.y - hip.y) * 0.5 - ny * botR * 1.05, bellyB.x, bellyB.y)
    ctx.quadraticCurveTo(rump.x - H * 0.16, rump.y, backRump.x, backRump.y)
    ctx.closePath()
    ctx.fill()

    // Cream belly patch.
    ctx.fillStyle = this.belly
    ctx.beginPath()
    ctx.moveTo(chest.x - H * 0.04, chest.y + H * 0.02)
    ctx.quadraticCurveTo(shoulder.x + H * 0.05, shoulder.y + botR * 0.85, bellyF.x - H * 0.02, bellyF.y - H * 0.02)
    ctx.quadraticCurveTo(hip.x + (shoulder.x - hip.x) * 0.4 - nx * botR * 0.9, hip.y + (shoulder.y - hip.y) * 0.4 - ny * botR * 0.9, bellyB.x + H * 0.06, bellyB.y - H * 0.02)
    ctx.quadraticCurveTo((chest.x + bellyB.x) / 2, (chest.y + bellyB.y) / 2 + H * 0.1, chest.x - H * 0.04, chest.y + H * 0.02)
    ctx.closePath()
    ctx.fill()

    // Tabby stripes across the back.
    ctx.strokeStyle = this.stripe
    ctx.lineCap = 'round'
    ctx.lineWidth = H * 0.055
    for (const f of [0.35, 0.5, 0.65, 0.8]) {
      const bx = hip.x + (shoulder.x - hip.x) * f
      const by = hip.y + (shoulder.y - hip.y) * f
      ctx.beginPath()
      ctx.moveTo(bx + nx * topR * 0.9, by + ny * topR * 0.9)
      ctx.lineTo(bx + nx * topR * 0.3, by + ny * topR * 0.3)
      ctx.stroke()
    }
  }

  private drawHead(ctx: CanvasRenderingContext2D, neck: Vec, head: Vec): void {
    const r = this.rig
    // Neck: a thick coat bridge so the head joins the body with no gap.
    ctx.strokeStyle = this.coat
    ctx.lineCap = 'round'
    ctx.lineWidth = H * 0.3
    ctx.beginPath()
    ctx.moveTo(neck.x - H * 0.16, neck.y + H * 0.05)
    ctx.lineTo(head.x - H * 0.03, head.y + H * 0.04)
    ctx.stroke()

    // Ear (behind, on the crown).
    const ang = Math.atan2(head.y - neck.y, head.x - neck.x)
    ctx.fillStyle = this.coat
    const earBase = { x: head.x - Math.cos(ang) * H * 0.06, y: head.y + Math.sin(ang) * 0 - H * 0.16 }
    ctx.beginPath()
    ctx.moveTo(earBase.x - H * 0.02, earBase.y + H * 0.08)
    ctx.lineTo(earBase.x - H * 0.05, earBase.y - H * (0.16 + r.earPerk * 0.06))
    ctx.lineTo(earBase.x + H * 0.13, earBase.y - H * 0.02)
    ctx.closePath()
    ctx.fill()
    ctx.fillStyle = this.ear
    ctx.beginPath()
    ctx.moveTo(earBase.x, earBase.y + H * 0.04)
    ctx.lineTo(earBase.x - H * 0.02, earBase.y - H * 0.1)
    ctx.lineTo(earBase.x + H * 0.08, earBase.y - H * 0.01)
    ctx.closePath()
    ctx.fill()

    // Head + muzzle.
    ctx.fillStyle = this.coat
    ctx.beginPath()
    ctx.ellipse(head.x, head.y, H * 0.2, H * 0.185, 0, 0, Math.PI * 2)
    ctx.fill()
    // Muzzle wedge toward the front (+x).
    ctx.beginPath()
    ctx.moveTo(head.x + H * 0.05, head.y - H * 0.09)
    ctx.quadraticCurveTo(head.x + H * 0.3, head.y - H * 0.02, head.x + H * 0.26, head.y + H * 0.08)
    ctx.quadraticCurveTo(head.x + H * 0.18, head.y + H * 0.16, head.x + H * 0.02, head.y + H * 0.12)
    ctx.closePath()
    ctx.fill()

    // Nose.
    ctx.fillStyle = this.dark
    ctx.beginPath()
    ctx.moveTo(head.x + H * 0.24, head.y + H * 0.03)
    ctx.lineTo(head.x + H * 0.29, head.y + H * 0.03)
    ctx.lineTo(head.x + H * 0.265, head.y + H * 0.07)
    ctx.closePath()
    ctx.fill()

    // Eye.
    const open = Math.max(0.06, this.blinkAmount)
    ctx.save()
    ctx.translate(head.x + H * 0.05, head.y - H * 0.02)
    ctx.scale(1, open)
    ctx.beginPath()
    ctx.ellipse(0, 0, H * 0.035, H * 0.05, 0, 0, Math.PI * 2)
    ctx.fillStyle = this.dark
    ctx.fill()
    if (open > 0.4) {
      ctx.beginPath()
      ctx.ellipse(H * 0.012, -H * 0.016, H * 0.012, H * 0.014, 0, 0, Math.PI * 2)
      ctx.fillStyle = '#ffffff'
      ctx.fill()
    }
    ctx.restore()

    // Whiskers.
    ctx.strokeStyle = this.dark
    ctx.globalAlpha = 0.55
    ctx.lineWidth = Math.max(0.8, H * 0.008)
    for (const dy of [-0.02, 0.01, 0.04]) {
      ctx.beginPath()
      ctx.moveTo(head.x + H * 0.22, head.y + H * (0.04 + dy))
      ctx.lineTo(head.x + H * 0.5, head.y + H * (0.02 + dy * 2))
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
