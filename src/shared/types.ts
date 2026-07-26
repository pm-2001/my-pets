/**
 * Contract shared between the Electron main process and the renderer.
 *
 * All geometry is in *global desktop coordinates*: origin at the top-left of the
 * primary display, y increasing downwards. This is what both Electron's `screen`
 * module and Quartz's CGWindowList report, so the two sensor sources compose
 * without conversion. The renderer converts to window-local space exactly once,
 * when it draws.
 *
 * Because positions are global, a pet's coordinates stay continuous as it walks
 * from one display into another — which is what makes multi-monitor hand-off
 * (below) almost free: the source window just ships the pet's live state and the
 * target window keeps simulating from the same numbers.
 */

export interface Rect {
  x: number
  y: number
  w: number
  h: number
}

/** A window belonging to some other application, usable as a platform. */
export interface DesktopWindow extends Rect {
  id: number
  /** Owning application name, e.g. "Terminal". Titles are deliberately not read. */
  app: string
}

export interface DisplayInfo {
  id: number
  /** Full display rect including menu bar and dock. */
  bounds: Rect
  /** Usable rect excluding menu bar and dock — where the pet's floor sits. */
  workArea: Rect
  scaleFactor: number
}

/**
 * Perception is split across two channels because they change at wildly
 * different rates, and sending them together meant re-serialising the whole
 * window list thirty times a second for the sake of a moving cursor.
 *
 * `WorldEnv` is the slow half — sent only when it actually changes.
 */
export interface WorldEnv {
  windows: DesktopWindow[]
  displays: DisplayInfo[]
  onBattery: boolean
  /** 0..1, or null when unknown / on a desktop machine. */
  batteryLevel: number | null
  /** Wall-clock hour 0..23, so the pet can have a daily routine. */
  hour: number
}

/** The fast half: two numbers and a point, sent at the tick rate. */
export interface WorldPulse {
  cursor: { x: number; y: number }
  /** Seconds since the last user input, from powerMonitor. No permission needed. */
  idleSeconds: number
}

/**
 * Everything a renderer needs to construct a `Pet`: its stable seed (which fixes
 * personality jitter and coat) plus the archetype. The `id` is the seed, reused
 * as a stable key so main and every window agree on which pet is which.
 */
export interface PetIdentity {
  id: number
  personality: string
  seed: number
}

/** The five internal drives, as they travel across the wire for a hand-off. */
export interface NeedsSnapshot {
  sleepiness: number
  boredom: number
  curiosity: number
  loneliness: number
  excitement: number
}

/**
 * The volatile physics/AI state a pet carries when it crosses a display edge, so
 * it keeps walking in the same direction with the same drives rather than
 * re-spawning as a fresh pet on the new screen.
 */
export interface PetLiveState {
  x: number
  y: number
  vx: number
  vy: number
  facing: 1 | -1
  needs: NeedsSnapshot
  /** Current action id, so momentum survives the hop. */
  action: string
}

/** A pet arriving at a window: its identity plus, for a hand-off, its live state. */
export interface PetSpawn extends PetIdentity {
  live?: PetLiveState
}

/**
 * Main tells each window which display it is and which pets it currently owns.
 * A window derives its own bounds from `displayId` against `WorldEnv.displays`,
 * so the assignment itself stays tiny.
 */
export interface PetAssignment {
  displayId: number
  pets: PetIdentity[]
}

/** Long-term state that survives restarts. One of these per pet. */
export interface PetMemory {
  name: string
  /** Stable seed so a pet's personality is reproducible across launches. */
  seed: number
  personality: string
  bornAt: number
  /** Cumulative seconds the pet has been alive and rendering. */
  aliveSeconds: number
  petCount: number
  /** Seconds of foreground time per app, used to infer favourites. */
  appSeconds: Record<string, number>
  /**
   * Seconds of foreground time per app, bucketed by wall-clock hour ("0".."23").
   * This is what lets the pet notice "you always open Slack around 9".
   */
  appByHour: Record<string, Record<string, number>>
  userName: string | null
  lastSeenAt: number
  /** Rolling conversation history, trimmed to a bounded length. */
  chat: { role: 'user' | 'pet'; text: string; at: number }[]
  notes: string[]
}

export interface Settings {
  /** Pet scale multiplier, 1 = default ~72px tall. */
  scale: number
  /** Cap on render frames per second while the pet is active. */
  fps: number
  /** Allow the pet to stand on other applications' windows. */
  useWindows: boolean
  /** How many pets live on the desktop at once. */
  pets: number
  /** Enable LLM-backed conversation. Off means canned, personality-driven lines. */
  aiChat: boolean
  aiModel: string
}

/** API surface the preload script exposes to the renderer. */
export interface PetBridge {
  /** Slow channel: window layout, displays, power. Fires only on change. */
  onEnv(cb: (env: WorldEnv) => void): () => void
  /** Fast channel: cursor and idle time. */
  onPulse(cb: (pulse: WorldPulse) => void): () => void
  /** Which display this window is, and the full set of pets it owns. */
  onAssign(cb: (assignment: PetAssignment) => void): () => void
  /** A single pet handed off from another display's window, with its live state. */
  onReceive(cb: (spawn: PetSpawn) => void): () => void
  /** Tray "Say hi" — the user greeting the pet from the menu bar. */
  onPoke(cb: () => void): () => void
  onSettings(cb: (settings: Settings) => void): () => void
  /** Tray "Forget everything" — start new pets with new personalities. */
  onReset(cb: () => void): () => void
  /** Toggle click-through. True while the cursor is over some pet's pixels. */
  setInteractive(interactive: boolean): void
  /** Take keyboard focus for the chat input, and give it back on close. */
  setChatFocus(focused: boolean): void
  /** This pet walked off the display edge; ask main to route it to a neighbour. */
  handoff(spawn: PetSpawn): void
  /** The user clicked this pet; main records the interaction. */
  poked(petId: number): void
  loadSettings(): Promise<Settings>
  /** Pull this window's initial assignment at boot, avoiding a push/listen race. */
  loadAssignment(): Promise<PetAssignment>
  /** Pull the latest world snapshot at boot, so bounds are known immediately. */
  loadEnv(): Promise<WorldEnv | null>
  chat(petId: number, prompt: string): Promise<string>
  /** True when PET_DEBUG is set; gates verbose renderer diagnostics. */
  debug: boolean
  /** PET_POSE=<anim> forces every pet to render that pose, for inspecting art. */
  posePreview: string | null
  quit(): void
}

declare global {
  interface Window {
    pet: PetBridge
  }
}
