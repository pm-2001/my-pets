import type { PetLiveState } from '@shared/types'
import type { Desktop, Surface, Wall } from '../world/desktop'
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
  | 'climb'

const GRAVITY = 1500
const JUMP_VY = -560
const JUMP_VX = 190
/** Vertical speed while scaling a wall, in points/sec. Slower than a walk — a climb should read as effort. */
const CLIMB_SPEED = 130
/** Height of the pet in points at scale 1; everything else is relative to it. */
export const PET_HEIGHT = 64

const VALID_ACTIONS = new Set<string>(ACTIONS.map((a) => a.id))

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
  /** Stable identity, shared with main and every window. Equals the seed. */
  readonly id: number
  readonly personality: string
  readonly seed: number

  private rand: () => number
  private selection: SelectionState = { current: 'idle', elapsed: 0, duration: 2, since: {} }
  /** Where the pet is currently trying to walk to, in global x. */
  private targetX: number | null = null
  private jumpTarget: Surface | null = null
  /** The wall being scaled, and whether the ascent has actually begun. */
  private climbTarget: Wall | null = null
  private climbing = false
  /** Seconds since the last action re-evaluation, for throttling. */
  private thinkAccumulator = 0

  // --- awareness of the other pets on this display, refreshed each update ---
  private petCount = 0
  private nearestPetX = 0
  private nearestPetDistance = Number.POSITIVE_INFINITY
  private nearestPetSleeping = false

  constructor(personality: string, seed: number) {
    this.id = seed
    this.personality = personality
    this.seed = seed
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
  spawn(desktop: Desktop, atX?: number): void {
    this.x = atX ?? desktop.leftEdge + desktop.bounds.w * 0.5
    this.y = desktop.floorY
    this.grounded = true
    this.surface = null
  }

  /** Freeze the pet's volatile state for a hand-off to another display's window. */
  serialize(): PetLiveState {
    return {
      x: this.x,
      y: this.y,
      vx: this.vx,
      vy: this.vy,
      facing: this.facing,
      needs: { ...this.needs },
      action: this.selection.current,
    }
  }

  /** Resume from a hand-off: keep walking with the same drives on the new screen. */
  restore(live: PetLiveState): void {
    this.x = live.x
    this.y = live.y
    this.vx = live.vx
    this.vy = live.vy
    this.facing = live.facing
    this.needs = { ...live.needs }
    // Hand-offs only happen on the floor, so land the pet and let the next frame
    // re-detect the surface under it on the new display.
    this.grounded = true
    this.surface = null
    this.climbing = false
    this.climbTarget = null
    const action: ActionId = VALID_ACTIONS.has(live.action) ? (live.action as ActionId) : 'walk'
    this.selection.current = action
    this.selection.elapsed = 0
    this.selection.duration = 3
  }

  /** The user clicked the pet: wake it, delight it, make it react. */
  poke(): void {
    this.needs.excitement = Math.min(100, this.needs.excitement + 45)
    this.needs.loneliness = Math.max(0, this.needs.loneliness - 40)
    this.needs.boredom = Math.max(0, this.needs.boredom - 30)
    if (this.asleep) this.needs.sleepiness = Math.max(0, this.needs.sleepiness - 25)
    this.enter('celebrate', 2.2)
  }

  /**
   * The user said something in the bubble: perk up and pay attention, even when
   * the message is not a command. Keeps every message producing a visible react.
   */
  acknowledge(): void {
    this.needs.excitement = Math.min(100, this.needs.excitement + 14)
    this.needs.loneliness = Math.max(0, this.needs.loneliness - 25)
    this.needs.boredom = Math.max(0, this.needs.boredom - 15)
  }

  /**
   * Carry out a spoken command by committing to an action for a few seconds. The
   * pet wakes, does the thing, then hands control back to its own drives. Mid-air
   * and mid-climb are left alone so a command cannot strand it.
   */
  command(id: ActionId): void {
    this.acknowledge()
    this.needs.sleepiness = Math.max(0, this.needs.sleepiness - 45)
    if (!this.grounded || this.climbing) return
    this.enter(id, id === 'climb' ? 12 : 4)
  }

  /** "Jump!" — a direct hop in the way the pet is facing. */
  hop(): void {
    this.acknowledge()
    this.needs.sleepiness = Math.max(0, this.needs.sleepiness - 30)
    if (!this.grounded || this.climbing) return
    this.vy = JUMP_VY * 0.75
    this.vx = this.facing * 70
    this.grounded = false
    this.enter('idle', 1)
  }

  /** "Wake up!" — shed sleep pressure and look alert. */
  wake(): void {
    this.acknowledge()
    this.needs.sleepiness = Math.max(0, this.needs.sleepiness - 65)
    this.needs.excitement = Math.min(100, this.needs.excitement + 25)
    if (this.grounded && !this.climbing) this.enter('lookAround', 3)
  }

  update(dt: number, desktop: Desktop, others: Pet[] = []): void {
    this.observeOthers(others)

    const cursorDistance = Math.hypot(desktop.cursor.x - this.x, desktop.cursor.y - (this.y - PET_HEIGHT / 2))

    this.needs = tickNeeds(this.needs, this.traits, {
      idleSeconds: desktop.idleSeconds,
      hour: desktop.hour,
      asleep: this.asleep,
      cursorDistance,
      nearestPetDistance: this.nearestPetDistance,
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

  /** Find the closest companion on this display; feeds needs and social actions. */
  private observeOthers(others: Pet[]): void {
    this.petCount = others.length
    let best = Number.POSITIVE_INFINITY
    let bestX = this.x
    let sleeping = false
    for (const o of others) {
      const d = Math.hypot(o.x - this.x, o.y - this.y)
      if (d < best) {
        best = d
        bestX = o.x
        sleeping = o.asleep
      }
    }
    this.nearestPetDistance = best
    this.nearestPetX = bestX
    this.nearestPetSleeping = sleeping
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
      wallCount: desktop.climbableWalls(this.x, this.y).length,
      onWindow: this.surface?.app != null,
      asleep: this.asleep,
      onBattery: desktop.onBattery,
      petCount: this.petCount,
      nearestPetDistance: this.nearestPetDistance,
      nearestPetSleeping: this.nearestPetSleeping,
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
    // Leaving climb for any other action lets go of the wall.
    if (id !== 'climb') {
      this.climbTarget = null
      this.climbing = false
    }

    if (id === 'sleep') this.needs.excitement = Math.min(this.needs.excitement, 25)
  }

  /** Turn the chosen action into velocity and an animation state. */
  private act(dt: number, desktop: Desktop, cursorDistance: number): void {
    // Airborne and not gripping a wall: the arc plays itself out. A climbing pet
    // is also off the ground, but it drives its own pose, so let it fall through.
    if (!this.grounded && !this.climbing) {
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
        // Pile up: if a companion is already asleep a short walk away, pad over
        // and curl up beside it before lying down.
        if (this.nearestPetSleeping && this.nearestPetDistance > 46 && this.nearestPetDistance < 260) {
          const spot = this.nearestPetX + (this.nearestPetX >= this.x ? -34 : 34)
          this.anim = 'walk'
          this.wanderTowards(spot, walkSpeed(this.traits) * 0.7, desktop)
        } else {
          this.vx = 0
          this.anim = 'sleep'
        }
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

      case 'follow': {
        // Trail the nearest companion; close the gap at a run, then sit near it.
        const target = this.nearestPetX
        if (this.nearestPetDistance < 66) {
          this.vx = 0
          this.anim = 'sit'
          this.facing = target >= this.x ? 1 : -1
        } else {
          const speed = this.nearestPetDistance > 300 ? runSpeed(this.traits) : walkSpeed(this.traits)
          this.anim = speed > walkSpeed(this.traits) ? 'run' : 'walk'
          this.wanderTowards(target, speed, desktop)
        }
        break
      }

      case 'play': {
        // Bounce and shuffle facing the companion — the pair reads as tussling.
        this.anim = 'dance'
        this.vx = Math.sin(this.selection.elapsed * 6) * 30
        this.facing = this.nearestPetX >= this.x ? 1 : -1
        if (this.selection.elapsed % 0.8 < dt && this.grounded) this.vy = -220
        break
      }

      case 'climb': {
        if (!this.climbTarget) {
          const walls = desktop.climbableWalls(this.x, this.y)
          if (!walls.length) {
            // The wall vanished (window moved/closed) before we could grab it.
            this.enter('walk', 3)
            break
          }
          this.climbTarget = walls[Math.floor(this.rand() * walls.length)]!
        }

        const wall = this.climbTarget
        if (!this.climbing) {
          // Walk to the foot of the wall, then grab on.
          if (Math.abs(wall.approachX - this.x) > 6) {
            this.anim = 'walk'
            this.wanderTowards(wall.approachX, walkSpeed(this.traits), desktop)
            break
          }
          this.climbing = true
          this.x = wall.approachX
          this.vx = 0
          this.vy = 0
          this.grounded = false
          this.surface = null
        }

        // Ascending: the vertical motion itself is applied in integrate().
        this.anim = 'climb'
        this.facing = wall.climbFacing
        this.x = wall.approachX
        this.vx = 0
        break
      }

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
    const onFloor = !surface || surface.app === null

    // Now and then, strike out for a neighbouring display. This is what makes a
    // pet migrate between screens on its own rather than only when chasing the
    // cursor across the seam. The stage picks it up at the edge and hands it off.
    if (onFloor) {
      const roll = this.rand()
      if (roll < 0.1 && desktop.hasNeighbour(1, this.y)) return (this.targetX = desktop.rightEdge + 40)
      if (roll < 0.2 && desktop.hasNeighbour(-1, this.y)) return (this.targetX = desktop.leftEdge - 40)
    }

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
    if (surface && surface.app != null) {
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

    // Screen edges are hard walls only where there is no neighbouring display to
    // step onto; with a neighbour the pet walks off and is handed across.
    const atLeft = this.x <= desktop.leftEdge + 6 && dir < 0 && !desktop.hasNeighbour(-1, this.y)
    const atRight = this.x >= desktop.rightEdge - 6 && dir > 0 && !desktop.hasNeighbour(1, this.y)
    if (atLeft || atRight) {
      this.targetX = null
      this.vx = 0
      return
    }

    this.vx = dir * speed
  }

  /** Apply velocity, gravity and surface collision. */
  private integrate(dt: number, desktop: Desktop): void {
    // Climbing overrides normal physics: no gravity, pinned to the wall, moving
    // straight up until it reaches the top edge and mounts onto it.
    if (this.climbing && this.climbTarget) {
      const wall = this.climbTarget
      this.x = wall.approachX
      this.y -= CLIMB_SPEED * dt
      if (this.y <= wall.topY) {
        // Reached the title bar — step over onto it and stand up.
        this.y = wall.topY
        this.x = wall.mountX
        this.vx = 0
        this.vy = 0
        this.grounded = true
        this.surface = wall.surface
        this.climbing = false
        this.climbTarget = null
        this.needs.curiosity = Math.max(0, this.needs.curiosity - 30)
        this.enter('lookAround', 3)
      }
      return
    }

    const previousY = this.y

    this.x += this.vx * dt
    // Clamp to a display edge only where it is a hard wall. Where a neighbour
    // abuts, the pet is allowed past the edge so the stage can hand it across.
    if (!desktop.hasNeighbour(-1, this.y)) this.x = Math.max(desktop.leftEdge + 4, this.x)
    if (!desktop.hasNeighbour(1, this.y)) this.x = Math.min(desktop.rightEdge - 4, this.x)

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
