import { BrowserWindow, screen } from 'electron'
import { join } from 'node:path'

const DEV_URL = 'http://localhost:5173'

/**
 * Creates the transparent, click-through, always-on-top window the pet lives in.
 *
 * The window spans one display's full bounds (not its work area) so the pet can
 * walk over the menu bar and dock; the *floor* is constrained to the work area by
 * the behaviour engine instead, which keeps the policy in one place.
 */
export function createOverlay(): BrowserWindow {
  const display = screen.getPrimaryDisplay()
  const { x, y, width, height } = display.bounds

  const win = new BrowserWindow({
    x,
    y,
    width,
    height,
    transparent: true,
    frame: false,
    hasShadow: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    // Never steal key focus from whatever the user is actually working in.
    // Temporarily flipped to true only while the chat input is open.
    focusable: false,
    acceptFirstMouse: true,
    webPreferences: {
      preload: join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // Critical: Chromium throttles rAF and timers in windows it considers
      // backgrounded. Our window is never focused, so without this the pet would
      // animate at ~1fps the moment the user clicked anything else.
      backgroundThrottling: false,
    },
  })

  // 'screen-saver' is the highest standard level — it keeps the pet visible over
  // fullscreen apps, which a plain alwaysOnTop does not.
  win.setAlwaysOnTop(true, 'screen-saver')
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })

  // Start fully click-through. The renderer flips this on when the cursor enters
  // the pet's actual silhouette, which is the only way to have a fullscreen
  // overlay that is simultaneously invisible to clicks and clickable on the pet.
  win.setIgnoreMouseEvents(true, { forward: true })

  if (process.env.VITE_DEV) {
    void win.loadURL(DEV_URL)
  } else {
    void win.loadFile(join(__dirname, '../dist/index.html'))
  }

  return win
}

/** Resize the overlay to follow display changes (resolution, docking, etc). */
export function refitOverlay(win: BrowserWindow): void {
  if (win.isDestroyed()) return
  const { x, y, width, height } = screen.getPrimaryDisplay().bounds
  win.setBounds({ x, y, width, height })
}
