import { app, BrowserWindow, ipcMain, Menu, Tray, nativeImage, screen, dialog } from 'electron'
import { join } from 'node:path'
import { existsSync, writeFileSync } from 'node:fs'
import { createOverlay, refitOverlay } from './overlay'
import { Sensors } from './sensors'
import { store, freshMemory } from './store'
import { chat, learnName } from './chat'
import { coatIndexForSeed } from '../src/brain/personality'
import type { PetIdentity, PetMemory, PetSpawn, Settings, WorldEnv } from '../src/shared/types'

/**
 * Main process: perception, the tray, and — new for multi-pet / multi-monitor —
 * the authority over which pets exist and which display each one lives on.
 *
 * There is one overlay window per display. Each window simulates only the pets
 * currently assigned to it, so pets on the same screen are aware of each other
 * while the render cost stays per-display. When a pet walks off a display edge,
 * its window ships the live state here and we route it to the neighbour's window
 * (`pet:handoff` -> `pet:receive`). Because all coordinates are global, the pet
 * simply keeps walking.
 *
 * Main is also the single writer of pet memory, which removes any race between
 * windows over the memory file and lets long-term learning (favourite apps,
 * daily routine, the human's name) live in one place.
 */

let tray: Tray | null = null
let sensors: Sensors | null = null
let settings: Settings = { scale: 1.5, fps: 30, useWindows: true, pets: 1, aiChat: false, aiModel: 'claude-opus-5' }

/** Authoritative long-term memory, one entry per pet. Persisted from here only. */
let pets: PetMemory[] = []
/** petId (== seed) -> displayId of the window that owns it. */
const assignment = new Map<number, number>()
/** displayId -> its overlay window. */
const windows = new Map<number, BrowserWindow>()

let frontApp: string | null = null
let idleSeconds = 0
let dirty = false
/** Latest world snapshot, so a booting window can pull it instead of racing. */
let lastEnv: WorldEnv | null = null

// A second copy would mean two apps fighting over the same memory file.
if (!app.requestSingleInstanceLock()) app.exit(0)

// --- pets & displays -------------------------------------------------------

const identityOf = (m: PetMemory): PetIdentity => ({ id: m.seed, personality: m.personality, seed: m.seed })
const memoryById = (id: number): PetMemory | undefined => pets.find((p) => p.seed === id)
const primaryId = (): number => screen.getPrimaryDisplay().id

/** Grow or shrink the population to match the desired count in settings. */
function reconcilePetCount(): void {
  const want = Math.max(1, Math.min(6, settings.pets))
  while (pets.length < want) {
    pets.push(freshMemory(pets.length, pets.map((p) => coatIndexForSeed(p.seed))))
  }
  if (pets.length > want) {
    for (const removed of pets.splice(want)) assignment.delete(removed.seed)
  }
  dirty = true
}

/** Every pet must point at a display we actually have a window for. */
function ensureAssignments(): void {
  const petIds = new Set(pets.map((p) => p.seed))
  for (const id of [...assignment.keys()]) if (!petIds.has(id)) assignment.delete(id)

  const prim = primaryId()
  for (const p of pets) {
    const current = assignment.get(p.seed)
    if (current === undefined || !windows.has(current)) assignment.set(p.seed, prim)
  }
}

function assignmentFor(displayId: number): PetIdentity[] {
  return pets.filter((p) => assignment.get(p.seed) === displayId).map(identityOf)
}

function sendAssignment(win: BrowserWindow, displayId: number): void {
  if (win.isDestroyed()) return
  win.webContents.send('pet:assign', { displayId, pets: assignmentFor(displayId) })
}

function broadcastAssignments(): void {
  for (const [displayId, win] of windows) sendAssignment(win, displayId)
}

function broadcast(channel: string, payload?: unknown): void {
  for (const win of windows.values()) {
    if (!win.isDestroyed()) win.webContents.send(channel, payload)
  }
}

/** Create/refit/destroy overlay windows to match the current display layout. */
function syncWindows(): void {
  const displays = screen.getAllDisplays()
  const liveIds = new Set(displays.map((d) => d.id))

  // Displays that went away: send their pets home to the primary, drop the window.
  for (const [id, win] of [...windows]) {
    if (liveIds.has(id)) continue
    for (const [petId, dispId] of assignment) if (dispId === id) assignment.set(petId, primaryId())
    if (!win.isDestroyed()) win.destroy()
    windows.delete(id)
  }

  for (const display of displays) {
    const existing = windows.get(display.id)
    if (existing && !existing.isDestroyed()) {
      refitOverlay(existing, display)
      continue
    }
    const win = createOverlay(display)
    windows.set(display.id, win)
    wireWindow(win, display.id)
  }

  ensureAssignments()
  broadcastAssignments()
}

function wireWindow(win: BrowserWindow, displayId: number): void {
  win.webContents.once('did-finish-load', () => {
    if (win.isDestroyed()) return
    win.webContents.send('settings', settings)
    sendAssignment(win, displayId)
  })
  if (process.env.PET_DEBUG === '1') {
    win.webContents.on('console-message', (_e, _level, message) => console.log(message))
  }
}

// --- tray ------------------------------------------------------------------

function trayIcon() {
  const candidates = [
    join(__dirname, 'assets', 'trayTemplate.png'),
    join(process.resourcesPath ?? '', 'assets', 'trayTemplate.png'),
  ]
  const path = candidates.find((p) => p && existsSync(p))
  if (!path) return nativeImage.createEmpty()
  const image = nativeImage.createFromPath(path)
  // Template images are recoloured by macOS to match the menu bar.
  image.setTemplateImage(true)
  return image
}

function buildTray(): void {
  tray = new Tray(trayIcon())
  tray.setToolTip('meowverlay — click for menu')
  // A bare template icon is easy to lose among menu-bar items (and can hide
  // behind the notch). A short text title makes it unmistakable and clickable.
  tray.setTitle(' 🐱')
  refreshTrayMenu()
}

function updateSettings(patch: Partial<Settings>): void {
  settings = { ...settings, ...patch }
  store.saveSettings(settings)
  broadcast('settings', settings)
  refreshTrayMenu()
}

function refreshTrayMenu(): void {
  if (!tray) return
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Say hi', click: () => broadcast('pet:poke') },
      { type: 'separator' },
      {
        label: 'Number of pets',
        submenu: [1, 2, 3, 4].map((count) => ({
          label: String(count),
          type: 'radio' as const,
          checked: settings.pets === count,
          click: () => {
            updateSettings({ pets: count })
            reconcilePetCount()
            ensureAssignments()
            broadcastAssignments()
            scheduleSave()
            if (process.env.PET_DEBUG === '1') {
              console.log(`[pets] requested=${count} total=${pets.length} assignment=${[...assignment.entries()].map(([p, d]) => `${p}:${d}`).join(' ')}`)
            }
          },
        })),
      },
      {
        label: 'AI conversation',
        type: 'checkbox',
        checked: settings.aiChat,
        click: (item) => updateSettings({ aiChat: item.checked }),
      },
      {
        label: 'Size',
        submenu: (['Small', 'Normal', 'Large'] as const).map((label, index) => {
          const scale = [1, 1.5, 2.3][index]!
          return {
            label,
            type: 'radio' as const,
            checked: settings.scale === scale,
            click: () => updateSettings({ scale }),
          }
        }),
      },
      {
        label: 'Stand on windows',
        type: 'checkbox',
        checked: settings.useWindows,
        click: (item) => updateSettings({ useWindows: item.checked }),
      },
      { type: 'separator' },
      {
        label: 'Forget everything…',
        click: async () => {
          const { response } = await dialog.showMessageBox({
            type: 'warning',
            buttons: ['Cancel', 'Forget'],
            defaultId: 0,
            cancelId: 0,
            message: settings.pets > 1 ? 'Reset your pets?' : 'Reset your pet?',
            detail:
              'This erases their names, personalities, memories and conversation history. New pets will be born with different personalities. This cannot be undone.',
          })
          if (response !== 1) return
          resetPets()
          broadcast('pet:reset')
        },
      },
      { label: 'Quit', accelerator: 'Command+Q', click: () => app.quit() },
    ]),
  )
}

function resetPets(): void {
  pets = []
  for (let i = 0; i < Math.max(1, settings.pets); i++) {
    pets.push(freshMemory(i, pets.map((p) => coatIndexForSeed(p.seed))))
  }
  assignment.clear()
  ensureAssignments()
  store.savePets(pets)
}

// --- persistence -----------------------------------------------------------

function scheduleSave(): void {
  dirty = true
}

// --- ipc -------------------------------------------------------------------

function windowOf(sender: Electron.WebContents): BrowserWindow | null {
  return BrowserWindow.fromWebContents(sender)
}

/** Which display's window a message came from; primary if it cannot be matched. */
function displayIdOf(sender: Electron.WebContents): number {
  for (const [id, win] of windows) {
    if (!win.isDestroyed() && win.webContents === sender) return id
  }
  return primaryId()
}

function wireIpc(): void {
  ipcMain.handle('settings:load', () => settings)

  // Pulled at boot instead of pushed, so a window can never miss its opening
  // assignment or the world snapshot to a listener-registration race.
  ipcMain.handle('assign:load', (event) => {
    const displayId = displayIdOf(event.sender)
    return { displayId, pets: assignmentFor(displayId) }
  })
  ipcMain.handle('env:load', () => lastEnv)

  // Hit-testing lives in the renderer, which is the only side that knows a pet's
  // exact silhouette. It tells its own window when to stop being click-through.
  ipcMain.on('pet:interactive', (event, interactive: boolean) => {
    const win = windowOf(event.sender)
    if (win && !win.isDestroyed()) win.setIgnoreMouseEvents(!interactive, { forward: true })
  })

  // The chat input needs real keystrokes, which a non-focusable window cannot
  // receive. Focus is borrowed for exactly as long as the bubble is open.
  ipcMain.on('pet:chat-focus', (event, focused: boolean) => {
    const win = windowOf(event.sender)
    if (!win || win.isDestroyed()) return
    win.setFocusable(focused)
    if (focused) win.focus()
  })

  ipcMain.on('pet:poked', (_e, petId: number) => {
    const memory = memoryById(petId)
    if (!memory) return
    memory.petCount += 1
    scheduleSave()
  })

  ipcMain.handle('pet:chat', async (_e, petId: number, prompt: string) => {
    const memory = memoryById(petId) ?? pets[0]
    if (!memory) return '...'

    // Learn and keep the human's name from what they type, once.
    const learned = learnName(prompt)
    if (learned && !memory.userName) {
      memory.userName = learned
      scheduleSave()
    }

    const reply = await chat(prompt, {
      memory,
      settings,
      nearApp: frontApp,
      mood: 'happy',
      hour: new Date().getHours(),
    })

    memory.chat.push({ role: 'user', text: prompt, at: Date.now() })
    memory.chat.push({ role: 'pet', text: reply, at: Date.now() })
    scheduleSave()
    return reply
  })

  // A pet walked off a display edge: route it to whichever display now contains
  // it, preserving its live state so it keeps walking.
  ipcMain.on('pet:handoff', (_e, spawn: PetSpawn) => {
    if (!spawn.live) return
    const target = screen.getDisplayNearestPoint({
      x: Math.round(spawn.live.x),
      y: Math.round(spawn.live.y),
    })
    assignment.set(spawn.id, target.id)
    const win = windows.get(target.id)
    if (win && !win.isDestroyed()) win.webContents.send('pet:receive', spawn)
  })

  ipcMain.on('pet:quit', () => app.quit())
}

// --- dev capture -----------------------------------------------------------

/**
 * A transparent, always-on-top overlay cannot be inspected with a normal
 * screenshot (that needs Screen Recording permission, and it would capture the
 * desktop behind us anyway). capturePage renders just this window's own output,
 * alpha included.
 *
 *   PET_CAPTURE=/tmp/pet.png PET_CAPTURE_DELAY=6 npx electron .
 */
function scheduleCapture(win: BrowserWindow | undefined): void {
  const target = process.env.PET_CAPTURE
  if (!target || !win) return
  const delay = Number(process.env.PET_CAPTURE_DELAY ?? 5) * 1000

  setTimeout(async () => {
    try {
      const image = await win.webContents.capturePage()
      writeFileSync(target, image.toPNG())
      console.log(`[capture] wrote ${target}`)
    } catch (err) {
      console.error('[capture] failed:', err)
    }
    if (process.env.PET_CAPTURE_QUIT) app.quit()
  }, delay)
}

// --- lifecycle -------------------------------------------------------------

app.whenReady().then(() => {
  settings = store.loadSettings()
  pets = store.loadPets()
  reconcilePetCount()

  // Accessory activation policy: no dock icon, and the app never becomes the
  // active application, so the pets cannot steal focus from real work.
  app.dock?.hide()

  wireIpc()
  syncWindows()
  buildTray()
  scheduleCapture(windows.get(primaryId()))

  sensors = new Sensors({
    env: (env) => {
      lastEnv = env
      frontApp = env.windows[0]?.app ?? null
      broadcast('world:env', env)
    },
    pulse: (pulse) => {
      idleSeconds = pulse.idleSeconds
      broadcast('world:pulse', pulse)
    },
  })
  sensors.start()

  // Long-term memory accumulation lives here now that main owns the store.
  // Attribute the user's foreground time to every pet's habit model, so the
  // pack slowly learns the human's favourites and daily routine.
  setInterval(() => {
    if (idleSeconds >= 60 || !frontApp) return
    const hourKey = String(new Date().getHours())
    for (const memory of pets) {
      memory.aliveSeconds += 5
      memory.appSeconds[frontApp] = (memory.appSeconds[frontApp] ?? 0) + 5
      const bucket = (memory.appByHour[hourKey] ??= {})
      bucket[frontApp] = (bucket[frontApp] ?? 0) + 5
    }
    scheduleSave()
  }, 5000)

  setInterval(() => {
    if (!dirty) return
    store.savePets(pets)
    dirty = false
  }, 10_000)

  const onDisplaysChanged = () => {
    syncWindows()
    sensors?.refreshDisplays()
  }
  screen.on('display-metrics-changed', onDisplaysChanged)
  screen.on('display-added', onDisplaysChanged)
  screen.on('display-removed', onDisplaysChanged)
})

// The pet has no windows to reopen and no dock icon — closing everything means
// quitting, not idling in the background.
app.on('window-all-closed', () => app.quit())
app.on('before-quit', () => {
  if (dirty) store.savePets(pets)
  sensors?.stop()
})
