import type { DesktopWindow, Rect, WorldEnv, WorldPulse } from '@shared/types'

/**
 * The desktop, modelled as a platformer level.
 *
 * The floor is the bottom of the work area (just above the dock) and every
 * on-screen window contributes its top edge as a standable ledge. Occlusion
 * matters: a ledge belonging to a window that is buried behind another is not
 * standable where it is covered, otherwise the pet appears to stand on thin air
 * in front of whatever is actually on top.
 */

export interface Surface {
  y: number
  x1: number
  x2: number
  /** Owning app, or null for the desktop floor. */
  app: string | null
}

const EMPTY_RECT: Rect = { x: 0, y: 0, w: 1440, h: 900 }

export class Desktop {
  windows: DesktopWindow[] = []
  cursor = { x: 0, y: 0 }
  idleSeconds = 0
  onBattery = false
  batteryLevel: number | null = null
  hour = 12
  /** Full display rect — the overlay window's own geometry. */
  bounds: Rect = EMPTY_RECT
  /** Excludes menu bar and dock; the pet's floor and ceiling come from this. */
  workArea: Rect = EMPTY_RECT
  useWindows = true

  updateEnv(env: WorldEnv): void {
    this.windows = env.windows
    this.onBattery = env.onBattery
    this.batteryLevel = env.batteryLevel
    this.hour = env.hour

    const display = env.displays[0]
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
      if (y - w.y > 260) continue // too tall to jump
      const nearestX = Math.max(w.x, Math.min(x, w.x + w.w))
      if (Math.abs(nearestX - x) > reach) continue
      if (this.occluded(i, nearestX, w.y)) continue
      out.push({ y: w.y, x1: w.x, x2: w.x + w.w, app: w.app })
    }
    return out
  }
}
