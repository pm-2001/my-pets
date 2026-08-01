import type { DesktopWindow, DisplayInfo, Rect, WorldEnv, WorldPulse } from '@shared/types'

/**
 * The desktop, modelled as a platformer level.
 *
 * The floor is the bottom of the work area (just above the dock) and every
 * on-screen window contributes its top edge as a standable ledge. Occlusion
 * matters: a ledge belonging to a window that is buried behind another is not
 * standable where it is covered, otherwise the pet appears to stand on thin air
 * in front of whatever is actually on top.
 *
 * One `Desktop` exists per overlay window, each pinned to a single display via
 * `setDisplay`. Its floor and walls come from *that* display's geometry, but the
 * window list is global, so a pet can still stand on a window that straddles two
 * screens. Where a neighbouring display abuts an edge, that edge is a soft wall:
 * the pet may walk off it and the stage hands it to the neighbour.
 */

export interface Surface {
  y: number
  x1: number
  x2: number
  /** Owning app, or null for the desktop floor. */
  app: string | null
}

/** A window's vertical edge the pet can scale to reach a top edge out of jump range. */
export interface Wall {
  /** X of the wall itself (a window's left or right edge). */
  edgeX: number
  /** Y of the top edge the climb arrives at. */
  topY: number
  /** -1 for the window's left edge, +1 for its right edge. */
  side: -1 | 1
  /** Where the pet stands, just outside the wall, before it starts climbing. */
  approachX: number
  /** Where the pet steps to on the top edge once it has mounted. */
  mountX: number
  /** Which way the pet faces while climbing: +1 when the wall is on its right. */
  climbFacing: 1 | -1
  /** The top edge, as a standable surface, for after the mount. */
  surface: Surface
}

/** The tallest single hop, shared by jump-reachability and climb-necessity checks. */
const JUMP_REACH = 260
/** The tallest wall worth attempting; beyond this a climb reads as a stunt. */
const CLIMB_CEILING = 1200

const EMPTY_RECT: Rect = { x: 0, y: 0, w: 1440, h: 900 }

export class Desktop {
  windows: DesktopWindow[] = []
  displays: DisplayInfo[] = []
  cursor = { x: 0, y: 0 }
  idleSeconds = 0
  onBattery = false
  batteryLevel: number | null = null
  hour = 12
  /** This window's display rect — the overlay window's own geometry. */
  bounds: Rect = EMPTY_RECT
  /** Excludes menu bar and dock; the pet's floor and ceiling come from this. */
  workArea: Rect = EMPTY_RECT
  useWindows = true

  /** Which display this overlay belongs to; -1 until main assigns one. */
  private displayId = -1

  /** Pin this desktop to a display id. Bounds refresh on the next env. */
  setDisplay(id: number): void {
    this.displayId = id
    this.applyDisplay()
  }

  updateEnv(env: WorldEnv): void {
    this.windows = env.windows
    this.displays = env.displays
    this.onBattery = env.onBattery
    this.batteryLevel = env.batteryLevel
    this.hour = env.hour
    this.applyDisplay()
  }

  private applyDisplay(): void {
    const display =
      this.displays.find((d) => d.id === this.displayId) ?? this.displays[0]
    if (display) {
      this.bounds = display.bounds
      this.workArea = display.workArea
    }
  }

  updatePulse(pulse: WorldPulse): void {
    this.cursor = pulse.cursor
    this.idleSeconds = pulse.idleSeconds
  }

  get floorY(): number {
    return this.workArea.y + this.workArea.h
  }

  get leftEdge(): number {
    return this.bounds.x
  }

  get rightEdge(): number {
    return this.bounds.x + this.bounds.w
  }

  /** The app whose window is frontmost, used for the pet's daily-routine memory. */
  get frontApp(): string | null {
    return this.windows[0]?.app ?? null
  }

  /**
   * Whether another display abuts this one on a given side at height `y`. A pet
   * reaching that edge is handed across rather than turned back; with no
   * neighbour the edge is a hard wall so the pet never wanders out of view.
   */
  hasNeighbour(side: -1 | 1, y: number): boolean {
    return this.neighbourAt(side, y) !== null
  }

  private neighbourAt(side: -1 | 1, y: number): DisplayInfo | null {
    for (const d of this.displays) {
      if (d.id === this.displayId) continue
      const abuts = side < 0 ? d.bounds.x < this.bounds.x : d.bounds.x >= this.rightEdge - 1
      const overlapsY = y >= d.bounds.y && y <= d.bounds.y + d.bounds.h
      if (abuts && overlapsY) return d
    }
    return null
  }

  /** The display whose bounds contain a global point, if any. Handoff target. */
  displayContaining(x: number, y: number): DisplayInfo | null {
    for (const d of this.displays) {
      if (x >= d.bounds.x && x < d.bounds.x + d.bounds.w && y >= d.bounds.y && y < d.bounds.y + d.bounds.h) {
        return d
      }
    }
    return null
  }

  /**
   * True when the point on `index`'s top edge is hidden behind a window that is
   * stacked in front of it. `windows` arrives front-to-back, so "in front"
   * simply means a lower index.
   */
  private occluded(index: number, x: number, y: number): boolean {
    for (let i = 0; i < index; i++) {
      const w = this.windows[i]!
      if (x >= w.x && x <= w.x + w.w && y > w.y && y < w.y + w.h) return true
    }
    return false
  }

  /**
   * True when column `x` is covered by some window (other than `exceptIndex`)
   * whose top rises to about `top` or above and which extends below it — i.e. the
   * spot is butted against a neighbouring/underlying window that stands just as
   * tall, so a side edge there is an internal seam, not an exposed climbable wall.
   */
  private columnBlockedFrom(x: number, top: number, exceptIndex: number): boolean {
    for (let i = 0; i < this.windows.length; i++) {
      if (i === exceptIndex) continue
      const w = this.windows[i]!
      if (x >= w.x && x <= w.x + w.w && w.y <= top + 8 && w.y + w.h > top + 8) return true
    }
    return false
  }

  /**
   * The highest standable surface at column `x` that is at or below `fromY`.
   * Always returns something — the floor is the surface of last resort.
   */
  surfaceUnder(x: number, fromY: number): Surface {
    let best: Surface = { y: this.floorY, x1: this.leftEdge, x2: this.rightEdge, app: null }

    if (!this.useWindows) return best

    for (let i = 0; i < this.windows.length; i++) {
      const w = this.windows[i]!
      if (x < w.x || x > w.x + w.w) continue
      // A ledge is only useful if the pet is above it and it beats the floor.
      if (w.y < fromY - 1 || w.y >= best.y) continue
      if (this.occluded(i, x, w.y)) continue
      best = { y: w.y, x1: w.x, x2: w.x + w.w, app: w.app }
    }

    return best
  }

  /** The surface the pet is currently resting on, if it is resting on one. */
  surfaceAt(x: number, y: number, tolerance = 2): Surface | null {
    const surface = this.surfaceUnder(x, y - tolerance)
    return Math.abs(surface.y - y) <= tolerance ? surface : null
  }

  /**
   * Ledges worth jumping to from the pet's position — near enough to reach and
   * high enough to be interesting. Used by the explore behaviour.
   */
  reachableLedges(x: number, y: number, reach = 320): Surface[] {
    if (!this.useWindows) return []
    const out: Surface[] = []
    for (let i = 0; i < this.windows.length; i++) {
      const w = this.windows[i]!
      if (w.y >= y - 20) continue // not meaningfully higher than we already are
      if (y - w.y > JUMP_REACH) continue // too tall to jump
      const nearestX = Math.max(w.x, Math.min(x, w.x + w.w))
      if (Math.abs(nearestX - x) > reach) continue
      if (this.occluded(i, nearestX, w.y)) continue
      out.push({ y: w.y, x1: w.x, x2: w.x + w.w, app: w.app })
    }
    return out
  }

  /**
   * Vertical window edges the pet could scale to reach a top edge that is too
   * high to jump to. A wall qualifies when its top is above jump range but not
   * absurdly high, its side reaches down to about the pet's feet (so there is a
   * continuous surface to grip), and the top it leads to is not buried behind a
   * window in front. Used by the climb behaviour.
   */
  climbableWalls(x: number, y: number, reach = 640): Wall[] {
    if (!this.useWindows) return []
    const out: Wall[] = []
    for (let i = 0; i < this.windows.length; i++) {
      const w = this.windows[i]!
      const top = w.y
      const bottom = w.y + w.h
      const rise = y - top
      if (rise <= JUMP_REACH || rise > CLIMB_CEILING) continue // jumpable, or too tall
      if (bottom < y - 60) continue // the side does not reach down near the pet's feet
      if (top >= this.floorY) continue // sanity: it must actually be above the floor

      for (const side of [-1, 1] as const) {
        const edgeX = side < 0 ? w.x : w.x + w.w
        if (Math.abs(edgeX - x) > reach) continue
        const approachX = side < 0 ? w.x - 6 : w.x + w.w + 6
        // The face must be a genuinely exposed side wall. Two ways it can fail:
        //  1. buried behind a window stacked in front (the pet would climb *through*
        //     whatever is on top of it), so sample the inside edge for occlusion;
        //  2. butted against a neighbouring or underlying window that rises just as
        //     high, so the column just *outside* the edge is not open air — that
        //     reads as the pet climbing up the middle of a window rather than a side.
        const mountProbe = side < 0 ? w.x + 12 : w.x + w.w - 12
        const reachDown = Math.min(bottom, y) - top
        const probeYs = [top, top + reachDown * 0.2, top + reachDown * 0.45]
        if (probeYs.some((py) => this.occluded(i, mountProbe, py))) continue
        if (this.columnBlockedFrom(approachX, top, i)) continue
        out.push({
          edgeX,
          topY: top,
          side,
          approachX,
          mountX: mountProbe,
          climbFacing: side < 0 ? 1 : -1,
          surface: { y: top, x1: w.x, x2: w.x + w.w, app: w.app },
        })
      }
    }
    return out
  }
}
