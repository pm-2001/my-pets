import { app, BrowserWindow, ipcMain, Menu, Tray, nativeImage, screen, dialog } from 'electron'
import { join } from 'node:path'
import { existsSync, writeFileSync } from 'node:fs'
import { createOverlay, refitOverlay } from './overlay'
import { Sensors } from './sensors'
import { store } from './store'
import { chat } from './chat'
import type { PetMemory, Settings, WorldEnv } from '../src/shared/types'

let overlay: BrowserWindow | null = null
let tray: Tray | null = null
let sensors: Sensors | null = null
let settings: Settings = { scale: 1, fps: 30, useWindows: true, aiChat: false, aiModel: 'claude-opus-5' }

/** Cached so the chat handler can describe the pet's surroundings. */
let lastEnv: WorldEnv | null = null

// A second copy would mean two pets fighting over the same memory file.
if (!app.requestSingleInstanceLock()) app.exit(0)

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
  tray.setToolTip('desktop-pet')
  refreshTrayMenu()
}

function refreshTrayMenu(): void {
  if (!tray) return
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Say hi', click: () => overlay?.webContents.send('pet:poke') },
      { type: 'separator' },
      {
        label: 'AI conversation',
        type: 'checkbox',
        checked: settings.aiChat,
        click: (item) => {
          settings = { ...settings, aiChat: item.checked }
          store.saveSettings(settings)
          overlay?.webContents.send('settings', settings)
        },
      },
      {
        label: 'Size',
        submenu: (['Small', 'Normal', 'Large'] as const).map((label, index) => {
          const scale = [0.7, 1, 1.5][index]!
          return {
            label,
            type: 'radio' as const,
            checked: settings.scale === scale,
            click: () => {
              settings = { ...settings, scale }
              store.saveSettings(settings)
              overlay?.webContents.send('settings', settings)
            },
          }
        }),
      },
      {
        label: 'Stand on windows',
        type: 'checkbox',
        checked: settings.useWindows,
        click: (item) => {
          settings = { ...settings, useWindows: item.checked }
          store.saveSettings(settings)
          overlay?.webContents.send('settings', settings)
        },
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
            message: 'Reset your pet?',
            detail:
              'This erases its name, personality, memories and conversation history. A new pet will be born with a different personality. This cannot be undone.',
          })
          if (response !== 1) return
          store.resetMemory()
          overlay?.webContents.send('pet:reset')
        },
      },
      { label: 'Quit', accelerator: 'Command+Q', click: () => app.quit() },
    ]),
  )
}

function wireIpc(): void {
  ipcMain.handle('memory:load', () => store.loadMemory())
  ipcMain.on('memory:save', (_e, memory: PetMemory) => store.saveMemory(memory))

  ipcMain.handle('settings:load', () => settings)
  ipcMain.on('settings:save', (_e, next: Settings) => {
    settings = next
    store.saveSettings(next)
    refreshTrayMenu()
  })

  // Hit-testing lives in the renderer, which is the only side that knows the
  // pet's exact silhouette. It tells us when to stop being click-through.
  ipcMain.on('pet:interactive', (_e, interactive: boolean) => {
    if (!overlay || overlay.isDestroyed()) return
    overlay.setIgnoreMouseEvents(!interactive, { forward: true })
  })

  // The chat input needs real keystrokes, which a non-focusable window cannot
  // receive. Focus is borrowed for exactly as long as the bubble is open.
  ipcMain.on('pet:chat-focus', (_e, focused: boolean) => {
    if (!overlay || overlay.isDestroyed()) return
    overlay.setFocusable(focused)
    if (focused) overlay.focus()
  })

  ipcMain.handle('pet:chat', async (_e, prompt: string, memory: PetMemory) => {
    const front = lastEnv?.windows[0]?.app ?? null
    return chat(prompt, {
      memory,
      settings,
      nearApp: front,
      mood: 'happy',
      hour: new Date().getHours(),
    })
  })

  ipcMain.on('pet:quit', () => app.quit())
}

/**
 * Dev affordance: a transparent, always-on-top overlay cannot be inspected with
 * a normal screenshot (that needs Screen Recording permission, and it would
 * capture the desktop behind us anyway). capturePage renders just this window's
 * own output, alpha included.
 *
 *   PET_CAPTURE=/tmp/pet.png PET_CAPTURE_DELAY=6 npx electron .
 */
function scheduleCapture(win: BrowserWindow): void {
  const target = process.env.PET_CAPTURE
  if (!target) return
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

app.whenReady().then(() => {
  settings = store.loadSettings()

  // Accessory activation policy: no dock icon, and the app never becomes the
  // active application, so the pet cannot steal focus from real work.
  app.dock?.hide()

  overlay = createOverlay()
  wireIpc()
  buildTray()

  overlay.webContents.once('did-finish-load', () => {
    overlay?.webContents.send('settings', settings)
  })

  // The overlay has no visible devtools affordance, so surface renderer logs on
  // the terminal when debugging.
  if (process.env.PET_DEBUG === '1') {
    overlay.webContents.on('console-message', (_e, _level, message) => console.log(message))
  }

  scheduleCapture(overlay)

  const send = (channel: string, payload: unknown) => {
    if (overlay && !overlay.isDestroyed()) overlay.webContents.send(channel, payload)
  }

  sensors = new Sensors({
    env: (env) => {
      lastEnv = env
      send('world:env', env)
    },
    pulse: (pulse) => send('world:pulse', pulse),
  })
  sensors.start()

  const onDisplaysChanged = () => {
    if (overlay) refitOverlay(overlay)
    sensors?.refreshDisplays()
  }
  screen.on('display-metrics-changed', onDisplaysChanged)
  screen.on('display-added', onDisplaysChanged)
  screen.on('display-removed', onDisplaysChanged)
})

// The pet has no windows to reopen and no dock icon — closing everything means
// quitting, not idling in the background.
app.on('window-all-closed', () => app.quit())
app.on('before-quit', () => sensors?.stop())
