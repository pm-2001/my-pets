import type { Desktop, Surface } from '../world/desktop'
import { ACTIONS, chooseAction, type ActionContext, type ActionId, type SelectionState } from './actions'
import { freshNeeds, moodFrom, tickNeeds, type Mood, type Needs } from './needs'
import { buildPalette, buildTraits, mulberry32, runSpeed, walkSpeed, type Traits } from './personality'

/** What the renderer draws. Decoupled from action ids so art and AI can differ. */
export type AnimState =
  | 'idle'
  | 'walk'
  | 'run'
  | 'sit'
  | 'sleep'
  | 'jump'
  | 'fall'
  | 'stretch'
  | 'dance'
  | 'celebrate'
  | 'scratch'
  | 'look'

const GRAVITY = 1500
const JUMP_VY = -560
const JUMP_VX = 190
/** Height of the pet in points at scale 1; everything else is relative to it. */
export const PET_HEIGHT = 64

export class Pet {
  x = 0
  y = 0
  vx = 0
  vy = 0
  grounded = true
  facing: 1 | -1 = 1
  anim: AnimState = 'idle'
  needs: Needs = freshNeeds()
  mood: Mood = 'relaxed'
  traits: Traits
  palette: { coat: number; belly: number; accent: number }
  /** The surface it is standing on, or null while airborne. */
  surface: Surface | null = null

  private rand: () => number
  private selection: SelectionState = { current: 'idle', elapsed: 0, duration: 2, since: {} }
  /** Where the pet is currently trying to walk to, in global x. */
  private targetX: number | null = null
  private jumpTarget: Surface | null = null
  /** Seconds since the last action re-evaluation, for throttling. */
  private thinkAccumulator = 0

  constructor(personality: string, seed: number) {
    this.traits = buildTraits(personality, seed)
    this.palette = buildPalette(seed)
    this.rand = mulberry32(seed ^ 0x51ed270b)
    for (const action of ACTIONS) this.selection.since[action.id] = 999
  }

  get action(): ActionId {
    return this.selection.current
  }

  get asleep(): boolean {
    return this.selection.current === 'sleep'
  }

  /** Drop the pet onto the floor at a sensible starting spot. */
  spawn(desktop: Desktop): void {
    this.x = desktop.leftEdge + desktop.bounds.w * 0.5
    this.y = desktop.floorY
    this.grounded = true
  }

  /** The user clicked the pet: wake it, delight it, make it react. */
  poke(): void {
    this.needs.excitement = Math.min(100, this.needs.excitement + 45)
    this.needs.loneliness = Math.max(0, this.needs.loneliness - 40)
    this.needs.boredom = Math.max(0, this.needs.boredom - 30)
    if (this.asleep) this.needs.sleepiness = Math.max(0, this.needs.sleepiness - 25)
    this.enter('celebrate', 2.2)
  }

  update(dt: number, desktop: Desktop): void {
    const cursorDistance = Math.hypot(desktop.cursor.x - this.x, desktop.cursor.y - (this.y - PET_HEIGHT / 2))

    this.needs = tickNeeds(this.needs, this.traits, {
      idleSeconds: desktop.idleSeconds,
      hour: desktop.hour,
      asleep: this.asleep,
      cursorDistance,
    }, dt)

    this.mood = moodFrom(this.needs, this.traits, this.asleep)

    this.selection.elapsed += dt
    for (const id of Object.keys(this.selection.since) as ActionId[]) {
      this.selection.since[id] = (this.selection.since[id] ?? 0) + dt
    }

    // Re-evaluate a few times a second rather than every frame: the inputs move
    // slowly and it keeps the decision cost off the render budget.
    this.thinkAccumulator += dt
    if (this.thinkAccumulator >= 0.25) {
      this.thinkAccumulator = 0
      this.think(desktop, cursorDistance)
    }

    this.act(dt, desktop, cursorDistance)
    this.integrate(dt, desktop)
  }

  private think(desktop: Desktop, cursorDistance: number): void {
    // Never interrupt a jump — the pet would freeze mid-air.
    if (!this.grounded) return

    const ctx: ActionContext = {
      needs: this.needs,
      traits: this.traits,
      cursorDistance,
      idleSeconds: desktop.idleSeconds,
      hour: desktop.hour,
      ledgeCount: desktop.reachableLedges(this.x, this.y).length,
      onWindow: this.surface?.app != null,
      asleep: this.asleep,
      onBattery: desktop.onBattery,
    }

    const next = chooseAction(ctx, this.selection, this.rand)
    if (next && next.id !== this.selection.current) this.enter(next.id, next.duration)
    else if (next) this.selection.duration = next.duration
  }

  private enter(id: ActionId, duration: number): void {
    this.selection.since[this.selection.current] = 0
    this.selection.current = id
    this.selection.elapsed = 0
    this.selection.duration = duration
    this.targetX = null
    this.jumpTarget = null

    if (id === 'sleep') this.needs.excitement = Math.min(this.needs.excitement, 25)
  }

  /** Turn the chosen action into velocity and an animation state. */
  private act(dt: number, desktop: Desktop, cursorDistance: number): void {
    if (!this.grounded) {
      this.anim = this.vy < 0 ? 'jump' : 'fall'
      return
    }

    switch (this.selection.current) {
      case 'idle':
        this.vx = 0
        this.anim = 'idle'
        break

      case 'lookAround':
        this.vx = 0
        this.anim = 'look'
        // Glance one way then the other, so it reads as scanning.
        this.facing = Math.sin(this.selection.elapsed * 1.6) > 0 ? 1 : -1
        break

      case 'sit':
        this.vx = 0
        this.anim = 'sit'
        break

      case 'sleep':
        this.vx = 0
        this.anim = 'sleep'
        break

      case 'stretch':
        this.vx = 0
        this.anim = 'stretch'
        break

      case 'scratch':
        this.vx = 0
        this.anim = 'scratch'
        break

      case 'dance':
        this.anim = 'dance'
        // Shuffle side to side rather than standing still.
        this.vx = Math.sin(this.selection.elapsed * 5) * 22
        this.facing = this.vx >= 0 ? 1 : -1
        break

      case 'celebrate':
        this.vx = 0
        this.anim = 'celebrate'
        // A couple of little hops.
        if (this.selection.elapsed % 0.7 < dt && this.grounded) this.vy = -230
        break

      case 'watch':
        this.vx = 0
        this.anim = 'sit'
        this.facing = desktop.cursor.x >= this.x ? 1 : -1
        break

      case 'walk':
      case 'run': {
        const running = this.selection.current === 'run'
        this.anim = running ? 'run' : 'walk'
        const speed = running ? runSpeed(this.traits) : walkSpeed(this.traits)
        this.wanderTowards(this.pickWanderTarget(desktop), speed, desktop)
        break
      }

      case 'chase': {
        const target = desktop.cursor.x
        const speed = cursorDistance > 250 ? runSpeed(this.traits) : walkSpeed(this.traits)
        this.anim = speed > walkSpeed(this.traits) ? 'run' : 'walk'
        if (Math.abs(target - this.x) < 26) {
          this.vx = 0
          this.anim = 'idle'
          this.facing = desktop.cursor.x >= this.x ? 1 : -1
        } else {
          this.wanderTowards(target, speed, desktop)
        }
        break
      }

      case 'explore': {
        this.anim = 'walk'
        if (!this.jumpTarget) {
          const ledges = desktop.reachableLedges(this.x, this.y)
          if (!ledges.length) {
            this.enter('walk', 3)
            break
          }
          this.jumpTarget = ledges[Math.floor(this.rand() * ledges.length)]!
        }

        const ledge = this.jumpTarget
        // Aim for a point a little inside the ledge so the landing is not on the
        // very corner, which usually means sliding straight back off.
        const aim = Math.max(ledge.x1 + 30, Math.min(this.x, ledge.x2 - 30))
        if (Math.abs(aim - this.x) > 24) {
          this.wanderTowards(aim, walkSpeed(this.traits), desktop)
        } else {
          this.vy = JUMP_VY
          this.vx = Math.sign(aim - this.x || 1) * JUMP_VX * 0.4
          this.grounded = false
          this.anim = 'jump'
        }
        break
      }
    }
  }

  private pickWanderTarget(desktop: Desktop): number {
    if (this.targetX !== null && Math.abs(this.targetX - this.x) > 16) return this.targetX

    const surface = this.surface
    const min = surface ? surface.x1 + 20 : desktop.leftEdge + 20
    const max = surface ? surface.x2 - 20 : desktop.rightEdge - 20
    const span = Math.max(40, max - min)
    this.targetX = min + this.rand() * span
    return this.targetX
  }

  private wanderTowards(targetX: number, speed: number, desktop: Desktop): void {
    const dir = Math.sign(targetX - this.x)
    if (dir === 0) {
      this.vx = 0
      return
    }
    this.facing = dir > 0 ? 1 : -1

    // Would this step take the pet off the end of its current ledge? Bold pets
    // step off and drop; cautious ones turn back. Either way it never walks on
    // empty space.
    const surface = this.surface
    if (surface) {
      const nextX = this.x + dir * speed * 0.12
      const offEdge = nextX < surface.x1 || nextX > surface.x2
      if (offEdge) {
        const drop = desktop.surfaceUnder(nextX, this.y + 2).y - this.y
        const willing = this.traits.boldness > 0.45 || drop < 90
        if (!willing) {
          this.targetX = null
          this.vx = 0
          return
        }
      }
    }

    // Screen edges are hard walls; the pet should never wander out of view.
    if ((this.x <= desktop.leftEdge + 6 && dir < 0) || (this.x >= desktop.rightEdge - 6 && dir > 0)) {
      this.targetX = null
      this.vx = 0
      return
    }

    this.vx = dir * speed
  }

  /** Apply velocity, gravity and surface collision. */
  private integrate(dt: number, desktop: Desktop): void {
    const previousY = this.y

    this.x += this.vx * dt
    this.x = Math.max(desktop.leftEdge + 4, Math.min(desktop.rightEdge - 4, this.x))

    if (!this.grounded) {
      this.vy += GRAVITY * dt
      this.y += this.vy * dt
    }

    if (this.grounded) {
      // Walking across a boundary can leave the pet hanging over nothing.
      const under = desktop.surfaceUnder(this.x, this.y - 1)
      if (Math.abs(under.y - this.y) > 3) {
        if (under.y > this.y) {
          this.grounded = false
          this.vy = 0
          this.surface = null
        } else {
          // A window moved up underneath the pet — ride it rather than clip in.
          this.y = under.y
          this.surface = under
        }
      } else {
        this.surface = under
      }
      return
    }

    if (this.vy <= 0) return // still rising; nothing to land on yet

    const landing = desktop.surfaceUnder(this.x, previousY)
    if (this.y >= landing.y) {
      this.y = landing.y
      this.vy = 0
      this.vx = 0
      this.grounded = true
      this.surface = landing
      this.jumpTarget = null
      // Landing somewhere new is inherently interesting.
      if (landing.app) this.needs.curiosity = Math.max(0, this.needs.curiosity - 25)
    }
  }
}
