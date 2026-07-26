import { Container, Graphics } from 'pixi.js'
import type { AnimState } from '../brain/pet'
import { PET_HEIGHT } from '../brain/pet'

/**
 * The pet, drawn procedurally.
 *
 * Geometry is built once and animated purely through transforms — rebuilding
 * Graphics paths every frame is the expensive way to do this, and at 30fps all
 * day it would show up in the battery meter.
 *
 * Every animation is expressed as a target `Pose`. The current pose is lerped
 * towards the target each frame, which is what gives smooth transitions between
 * states for free: there are no hand-authored blends between "walk" and "sit",
 * the interpolation handles it.
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
}

const TAIL_SEGMENTS = 5

export class CatRenderer {
  readonly root = new Container()

  private bodyGroup = new Container()
  private headGroup = new Container()
  private tailRoot = new Container()
  private tailJoints: Container[] = []
  private legs: Graphics[] = []
  private frontPawGroup = new Container()
  private eyes: Container[] = []
  private ears: Graphics[] = []
  private zzz = new Container()
  private zGlyphs: Graphics[] = []

  private pose: Pose = { ...REST }
  private legPhase = 0
  private blinkTimer = 2
  private blinkAmount = 1
  /** Squash-and-stretch spring, kicked on landing. */
  private squash = 0
  private squashVelocity = 0
  private time = 0

  constructor(palette: { coat: number; belly: number; accent: number }) {
    const H = PET_HEIGHT
    const coat = palette.coat
    const belly = palette.belly
    const accent = palette.accent

    // --- tail: a chain of nested joints so one rotation propagates outward ---
    this.tailRoot.position.set(-H * 0.31, -H * 0.4)
    let parent: Container = this.tailRoot
    for (let i = 0; i < TAIL_SEGMENTS; i++) {
      const joint = new Container()
      const width = H * 0.095 * (1 - i * 0.11)
      const length = H * 0.145
      const seg = new Graphics()
        .roundRect(-width / 2, -length, width, length + width / 2, width / 2)
        .fill(i === TAIL_SEGMENTS - 1 ? belly : coat)
      joint.addChild(seg)
      if (i > 0) joint.position.set(0, -length)
      parent.addChild(joint)
      this.tailJoints.push(joint)
      parent = joint
    }

    // --- legs: back pair drawn behind the body, front pair in front ---
    const makeLeg = (x: number) => {
      const leg = new Graphics().roundRect(-H * 0.045, 0, H * 0.09, H * 0.19, H * 0.045).fill(coat)
      leg.position.set(x, -H * 0.19)
      return leg
    }

    const backLegs = [makeLeg(-H * 0.17), makeLeg(-H * 0.05)]
    const frontLegs = [makeLeg(H * 0.1), makeLeg(H * 0.21)]
    this.legs = [...backLegs, ...frontLegs]

    // --- body ---
    const body = new Graphics()
      .ellipse(0, 0, H * 0.36, H * 0.23)
      .fill(coat)
      .ellipse(H * 0.04, H * 0.09, H * 0.26, H * 0.12)
      .fill(belly)
    this.bodyGroup.position.set(0, -H * 0.38)
    this.bodyGroup.addChild(body)

    // --- head ---
    for (const side of [-1, 1] as const) {
      const ear = new Graphics()
        .poly([0, 0, side * H * 0.13, -H * 0.15, side * H * 0.17, H * 0.03])
        .fill(coat)
        .poly([side * 0.02 * H, -H * 0.01, side * H * 0.11, -H * 0.11, side * H * 0.13, H * 0.0])
        .fill(accent)
      ear.position.set(side * H * 0.11, -H * 0.13)
      this.ears.push(ear)
      this.headGroup.addChild(ear)
    }

    this.headGroup.addChild(new Graphics().circle(0, 0, H * 0.22).fill(coat))

    for (const side of [-1, 1] as const) {
      const eye = new Container()
      eye.addChild(new Graphics().ellipse(0, 0, H * 0.035, H * 0.05).fill(accent))
      // Catchlight — tiny, but it is most of what makes a face feel alive.
      eye.addChild(new Graphics().circle(H * 0.014, -H * 0.018, H * 0.014).fill(0xffffff))
      eye.position.set(H * 0.055 + side * H * 0.075, -H * 0.02)
      this.eyes.push(eye)
      this.headGroup.addChild(eye)
    }

    this.headGroup.addChild(
      new Graphics().poly([H * 0.17, H * 0.05, H * 0.23, H * 0.05, H * 0.2, H * 0.09]).fill(accent),
    )

    const whiskers = new Graphics()
    for (const dy of [-0.02, 0.01, 0.04]) {
      whiskers
        .moveTo(H * 0.19, H * (0.05 + dy))
        .lineTo(H * 0.42, H * (0.03 + dy * 2.2))
    }
    whiskers.stroke({ width: Math.max(1, H * 0.012), color: accent, alpha: 0.55 })
    this.headGroup.addChild(whiskers)

    this.headGroup.position.set(H * 0.22, -H * 0.62)

    // --- front paw, animated separately for scratching and waving ---
    const paw = new Graphics()
      .roundRect(-H * 0.045, 0, H * 0.09, H * 0.2, H * 0.045)
      .fill(coat)
    this.frontPawGroup.position.set(H * 0.21, -H * 0.34)
    this.frontPawGroup.addChild(paw)
    this.frontPawGroup.visible = false

    // --- sleep glyphs ---
    for (let i = 0; i < 3; i++) {
      const z = new Graphics()
        .moveTo(0, 0)
        .lineTo(H * 0.08, 0)
        .lineTo(0, H * 0.08)
        .lineTo(H * 0.08, H * 0.08)
        .stroke({ width: Math.max(1.5, H * 0.02), color: 0xffffff })
      z.alpha = 0
      this.zGlyphs.push(z)
      this.zzz.addChild(z)
    }
    this.zzz.position.set(H * 0.34, -H * 0.85)

    this.root.addChild(this.tailRoot, ...backLegs, this.bodyGroup, ...frontLegs, this.frontPawGroup, this.headGroup, this.zzz)
  }

  /**
   * @param facing  1 faces right, -1 faces left
   * @param speed   horizontal speed in points/sec, used to drive gait timing
   */
  update(dt: number, anim: AnimState, facing: 1 | -1, speed: number, scale: number): void {
    this.time += dt

    const target = { ...REST, ...POSES[anim] }
    // Lerp rate tuned so transitions land in roughly a fifth of a second — fast
    // enough to feel responsive, slow enough to read as a movement.
    const k = 1 - Math.exp(-12 * dt)
    for (const key of Object.keys(this.pose) as (keyof Pose)[]) {
      this.pose[key] += (target[key] - this.pose[key]) * k
    }

    this.updateBlink(dt, target.eyeOpen)
    this.updateSquash(dt)

    const H = PET_HEIGHT
    const breathRate = anim === 'sleep' ? 1.1 : 2.4
    const breath = Math.sin(this.time * breathRate) * (anim === 'sleep' ? 0.05 : 0.022)

    this.root.scale.set(facing * scale, scale)

    // Gait phase advances with actual speed so walking and running share one
    // cycle and never look like they are sliding.
    const rate = this.pose.legRate > 0 ? this.pose.legRate : 0
    this.legPhase += (rate + Math.abs(speed) * 0.04) * dt

    const bob = this.pose.legSwing > 0.05 ? Math.abs(Math.sin(this.legPhase)) * H * 0.02 : 0

    this.bodyGroup.position.y = -H * 0.38 + this.pose.bodyY - bob
    this.bodyGroup.rotation = this.pose.bodyRot + (anim === 'dance' ? Math.sin(this.time * 6) * 0.12 : 0)
    this.bodyGroup.scale.set(
      this.pose.bodyScaleX * (1 - this.squash * 0.35),
      (this.pose.bodyScaleY + breath) * (1 + this.squash * 0.45),
    )

    this.headGroup.position.set(H * 0.22, -H * 0.62 + this.pose.headY - bob * 1.4)
    this.headGroup.rotation =
      this.pose.headRot + (anim === 'look' ? Math.sin(this.time * 1.6) * 0.18 : 0) + breath * 0.6

    for (let i = 0; i < this.legs.length; i++) {
      const leg = this.legs[i]!
      // Diagonal pairs move together, which is what makes a four-legged gait
      // read correctly rather than looking like a hopping toy.
      const offset = i === 0 || i === 3 ? 0 : Math.PI
      leg.rotation = Math.sin(this.legPhase + offset) * this.pose.legSwing
      leg.position.y = -H * 0.19 + this.pose.bodyY * 0.35
    }

    for (let i = 0; i < this.tailJoints.length; i++) {
      const joint = this.tailJoints[i]!
      // Phase offset per joint makes the wag travel along the tail as a wave
      // rather than swinging it rigidly from the base.
      const wag = Math.sin(this.time * this.pose.tailRate + i * 0.5) * this.pose.tailWag
      // The root joint carries the base angle; every joint adds a constant curl
      // that accumulates down the chain into a natural arc.
      const curl = i === 0 ? this.pose.tailBase - speed * 0.0012 : 0.17
      joint.rotation = curl + wag
    }

    for (const eye of this.eyes) eye.scale.y = Math.max(0.08, this.blinkAmount)
    for (let i = 0; i < this.ears.length; i++) {
      const dir = i === 0 ? -1 : 1
      this.ears[i]!.rotation = dir * this.pose.earPerk * 0.5
    }

    const pawUp = this.pose.frontPaw
    this.frontPawGroup.visible = pawUp > 0.02
    if (this.frontPawGroup.visible) {
      const wave = anim === 'scratch' ? Math.sin(this.time * 14) * 0.5 : Math.sin(this.time * 7) * 0.3
      this.frontPawGroup.rotation = -pawUp * 1.1 + wave * pawUp
      this.frontPawGroup.position.y = -H * 0.34 - pawUp * H * 0.08
    }

    this.updateZs(anim === 'sleep')
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

  private updateZs(sleeping: boolean): void {
    this.zzz.visible = sleeping
    if (!sleeping) return
    for (let i = 0; i < this.zGlyphs.length; i++) {
      const z = this.zGlyphs[i]!
      const phase = (this.time * 0.42 + i / this.zGlyphs.length) % 1
      z.position.set(phase * PET_HEIGHT * 0.18, -phase * PET_HEIGHT * 0.5)
      z.scale.set(0.6 + phase * 0.7)
      // Fade in then out so glyphs do not pop at the start or end of the loop.
      z.alpha = Math.sin(phase * Math.PI) * 0.75
    }
  }
}
