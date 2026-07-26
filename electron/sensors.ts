import { screen, powerMonitor } from 'electron'
import { spawn, type ChildProcess, exec } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { DesktopWindow, DisplayInfo, WorldEnv, WorldPulse } from '../src/shared/types'

/**
 * Perception layer. Everything here is deliberately permission-free:
 *
 *  - cursor position  -> Electron `screen`             (no TCC prompt)
 *  - user activity    -> powerMonitor idle time        (no TCC prompt)
 *  - window layout    -> CGWindowList bounds via Swift (no TCC prompt)
 *
 * We never install a keyboard hook or request Screen Recording. That costs us
 * window *titles* and true keystroke rhythm, but it means the app runs the first
 * time it is opened with no scary dialogs, which matters far more for something
 * meant to be charming.
 *
 * The hot path is deliberately tiny: one `getCursorScreenPoint()` and a small
 * object. Display enumeration and the window list are cached and pushed on the
 * slow channel only when they change, because doing either at tick rate costs
 * several percent of a CPU core all day.
 */

/** ~30Hz — only while the mouse is actually moving. */
const MOVING_INTERVAL_MS = 33
/** ~10Hz — mouse parked but the user is still at the machine. */
const STILL_INTERVAL_MS = 100
/** 4Hz — nobody is here. */
const AWAY_INTERVAL_MS = 250
const AWAY_THRESHOLD_S = 45
/** Consecutive motionless polls before stepping down from the fast rate. */
const STILL_POLLS = 8

function resolveDeskscan(): string | null {
  const candidates = [
    join(__dirname, 'native', 'deskscan'),
    join(process.resourcesPath ?? '', 'native', 'deskscan'),
    join(__dirname, '..', 'dist-electron', 'native', 'deskscan'),
  ]
  return candidates.find((p) => p && existsSync(p)) ?? null
}

export interface SensorSinks {
  env(env: WorldEnv): void
  pulse(pulse: WorldPulse): void
}

export class Sensors {
  private windows: DesktopWindow[] = []
  private displays: DisplayInfo[] = []
  private idleSeconds = 0
  private onBattery = false
  private batteryLevel: number | null = null
  private hour = new Date().getHours()

  private scanner: ChildProcess | null = null
  private timer: NodeJS.Timeout | null = null
  private slowTimer: NodeJS.Timeout | null = null
  private batteryTimer: NodeJS.Timeout | null = null
  private currentInterval = MOVING_INTERVAL_MS
  private stopped = false
  /** Last cursor position sent, so a still cursor costs no IPC at all. */
  private lastCursor = { x: -1, y: -1 }
  private lastIdleSent = -1
  private motionlessPolls = 0

  constructor(private sinks: SensorSinks) {}

  start(): void {
    this.refreshDisplays()
    this.startScanner()

    // Idle time, power state and the clock all change slowly. 1Hz is plenty and
    // keeps the 30Hz path down to a single cheap cursor read.
    this.slowTimer = setInterval(() => {
      this.idleSeconds = powerMonitor.getSystemIdleTime()
      this.onBattery = powerMonitor.isOnBatteryPower()
      const hour = new Date().getHours()
      if (hour !== this.hour) {
        this.hour = hour
        this.emitEnv()
      }
      this.retune()
    }, 1000)

    this.readBattery()
    this.batteryTimer = setInterval(() => this.readBattery(), 60_000)

    this.schedule(MOVING_INTERVAL_MS)
    this.emitEnv()
  }

  stop(): void {
    this.stopped = true
    if (this.timer) clearInterval(this.timer)
    if (this.slowTimer) clearInterval(this.slowTimer)
    if (this.batteryTimer) clearInterval(this.batteryTimer)
    this.scanner?.kill()
  }

  /** Called by main on display-configuration events, not polled. */
  refreshDisplays(): void {
    this.displays = screen.getAllDisplays().map((d) => ({
      id: d.id,
      bounds: { x: d.bounds.x, y: d.bounds.y, w: d.bounds.width, h: d.bounds.height },
      workArea: { x: d.workArea.x, y: d.workArea.y, w: d.workArea.width, h: d.workArea.height },
      scaleFactor: d.scaleFactor,
    }))
    this.emitEnv()
  }

  private emitEnv(): void {
    if (this.stopped) return
    this.sinks.env({
      windows: this.windows,
      displays: this.displays,
      onBattery: this.onBattery,
      batteryLevel: this.batteryLevel,
      hour: this.hour,
    })
  }

  private schedule(ms: number): void {
    if (this.timer) clearInterval(this.timer)
    this.currentInterval = ms
    this.timer = setInterval(() => this.tick(), ms)
  }

  /**
   * Three-speed poll. Full rate is only needed while the mouse is in motion —
   * that is the only thing that changes at frame rate. A parked mouse steps down
   * to 10Hz and an absent user to 4Hz, which is most of why the app's idle cost
   * is negligible.
   */
  private retune(): void {
    let want: number
    if (this.idleSeconds > AWAY_THRESHOLD_S) want = AWAY_INTERVAL_MS
    else if (this.motionlessPolls >= STILL_POLLS) want = STILL_INTERVAL_MS
    else want = MOVING_INTERVAL_MS
    if (want !== this.currentInterval) this.schedule(want)
  }

  private tick(): void {
    if (this.stopped) return
    const cursor = screen.getCursorScreenPoint()

    // A motionless cursor is the common case while someone is reading or
    // typing; skipping the send makes that case free.
    if (
      cursor.x === this.lastCursor.x &&
      cursor.y === this.lastCursor.y &&
      this.idleSeconds === this.lastIdleSent
    ) {
      if (this.motionlessPolls < STILL_POLLS) {
        this.motionlessPolls++
        if (this.motionlessPolls >= STILL_POLLS) this.retune()
      }
      return
    }

    const wasSlow = this.motionlessPolls >= STILL_POLLS
    this.motionlessPolls = 0
    // Snap straight back to full rate on the first sign of movement, so the pet
    // never lags a moving cursor.
    if (wasSlow) this.retune()

    this.lastCursor = cursor
    this.lastIdleSent = this.idleSeconds
    this.sinks.pulse({ cursor, idleSeconds: this.idleSeconds })
  }

  /** Long-lived helper process; emits a JSON line only when the layout changes. */
  private startScanner(): void {
    const bin = resolveDeskscan()
    if (!bin) {
      console.warn('[sensors] deskscan helper not found — window awareness disabled')
      return
    }

    this.scanner = spawn(bin, ['400'], { stdio: ['ignore', 'pipe', 'pipe'] })

    let buffer = ''
    this.scanner.stdout?.on('data', (chunk: Buffer) => {
      buffer += chunk.toString()
      let newline: number
      while ((newline = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newline).trim()
        buffer = buffer.slice(newline + 1)
        if (!line) continue
        try {
          this.windows = JSON.parse(line) as DesktopWindow[]
          this.emitEnv()
        } catch {
          // A partial or malformed line is not worth crashing the pet over.
        }
      }
    })

    this.scanner.on('exit', () => {
      this.scanner = null
      // Respawn unless we are shutting down, so a helper crash self-heals.
      if (!this.stopped) setTimeout(() => this.startScanner(), 2000)
    })
  }

  /** Electron has no battery-level API; pmset is the cheapest way to get it. */
  private readBattery(): void {
    exec('pmset -g batt', { timeout: 3000 }, (err, stdout) => {
      if (err) return
      const match = /(\d+)%/.exec(stdout)
      const level = match?.[1] ? Number(match[1]) / 100 : null
      if (level !== this.batteryLevel) {
        this.batteryLevel = level
        this.emitEnv()
      }
    })
  }
}
