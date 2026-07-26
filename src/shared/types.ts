/**
 * Contract shared between the Electron main process and the renderer.
 *
 * All geometry is in *global desktop coordinates*: origin at the top-left of the
 * primary display, y increasing downwards. This is what both Electron's `screen`
 * module and Quartz's CGWindowList report, so the two sensor sources compose
 * without conversion. The renderer converts to window-local space exactly once,
 * when it draws.
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

/** Long-term state that survives restarts. */
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
  /** Tray "Say hi" — the user greeting the pet from the menu bar. */
  onPoke(cb: () => void): () => void
  onSettings(cb: (settings: Settings) => void): () => void
  /** Tray "Forget everything" — start a new pet with a new personality. */
  onReset(cb: () => void): () => void
  /** Toggle click-through. True while the cursor is over the pet's pixels. */
  setInteractive(interactive: boolean): void
  /** Take keyboard focus for the chat input, and give it back on close. */
  setChatFocus(focused: boolean): void
  loadMemory(): Promise<PetMemory>
  saveMemory(memory: PetMemory): void
  loadSettings(): Promise<Settings>
  saveSettings(settings: Settings): void
  chat(prompt: string, memory: PetMemory): Promise<string>
  /** True when PET_DEBUG is set; gates verbose renderer diagnostics. */
  debug: boolean
  quit(): void
}

declare global {
  interface Window {
    pet: PetBridge
  }
}
