#!/usr/bin/env node
// CLI entry point: `npx meowverlay` or, after `npm i -g meowverlay`, just
// `meowverlay`. Launches the prebuilt app under Electron. The app is shipped
// already built (dist/ + dist-electron/ with a universal deskscan helper), so no
// Xcode or compile step is needed to run it.

import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const appRoot = join(dirname(fileURLToPath(import.meta.url)), '..')

if (process.platform !== 'darwin') {
  console.error(
    'meowverlay currently runs on macOS only.\n' +
      'It relies on macOS window enumeration and a macOS-specific overlay; Windows\n' +
      'and Linux support is on the roadmap. Nothing was launched.',
  )
  process.exit(0)
}

// The electron package exports the path to its executable — but only once its
// postinstall has downloaded the binary.
function resolveElectron() {
  try {
    const p = require('electron')
    return typeof p === 'string' ? p : null
  } catch {
    return null
  }
}

// Where the electron package lives, or null if it is not installed at all.
function electronDir() {
  try {
    return dirname(require.resolve('electron/package.json'))
  } catch {
    return null
  }
}

// Which package manager, if any, is actually available — so recovery advice is
// never "run npm" on a machine that has pnpm/yarn/bun instead, or no npm at all.
function detectManager() {
  const ua = process.env.npm_config_user_agent || ''
  for (const name of ['pnpm', 'yarn', 'bun', 'npm']) if (ua.startsWith(name)) return name
  for (const name of ['npm', 'pnpm', 'yarn', 'bun']) {
    try {
      if (spawnSync(name, ['--version'], { stdio: 'ignore' }).status === 0) return name
    } catch {
      // not on PATH — keep looking
    }
  }
  return null
}

let electron = resolveElectron()

// Electron ships its ~100MB binary via a postinstall step. Some machines block
// install scripts for security, leaving the binary un-downloaded. We run as a
// user-invoked command (not an install hook) and drive Electron's own installer
// directly with Node — so this recovery needs no package manager at all.
if (!electron) {
  const dir = electronDir()
  if (dir) {
    console.error('meowverlay: first-run setup — downloading the Electron runtime…')
    try {
      // Force the real download even when the environment tells Electron's
      // installer to skip it. ELECTRON_SKIP_BINARY_DOWNLOAD (set by some CI and
      // security tooling) makes install.js exit 0 without fetching the binary,
      // which is exactly the "installed but no runtime" state we are recovering
      // from — so strip it (and the mirror override) for this run.
      const env = { ...process.env }
      delete env.ELECTRON_SKIP_BINARY_DOWNLOAD
      delete env.ELECTRON_OVERRIDE_DIST_PATH
      const res = spawnSync(process.execPath, [join(dir, 'install.js')], { stdio: 'inherit', cwd: dir, env })
      if (res.status === 0) electron = resolveElectron()
    } catch {
      // fall through to guidance
    }
  }
}

if (!electron) {
  const pm = detectManager()
  const installedButBroken = electronDir() !== null
  const advice = {
    npm: 'npm i -g meowverlay --allow-scripts=electron',
    pnpm: 'pnpm add -g meowverlay && pnpm approve-builds -g',
    yarn: 'yarn global add meowverlay',
    bun: 'bun add -g --trust meowverlay',
  }
  const npmRootHint = 'env -u ELECTRON_SKIP_BINARY_DOWNLOAD node "$(npm root -g)/meowverlay/node_modules/electron/install.js"'
  console.error(
    '\nCould not set up the Electron runtime automatically' +
      (installedButBroken ? ' (its binary is missing).' : ' (electron is not installed).') +
      '\n\nIf ELECTRON_SKIP_BINARY_DOWNLOAD is set in your environment, it blocks the\n' +
      'download. Fetch the runtime once with it unset:\n\n' +
      `  ${npmRootHint}\n\n` +
      'Otherwise reinstall so the setup script can run:\n\n' +
      `  ${pm ? advice[pm] : advice.npm}\n` +
      (pm ? '' : '\n(Install Node.js 20+ from https://nodejs.org if you have no package manager.)\n'),
  )
  process.exit(1)
}

// Hand off to Electron, pointing it at this package (its package.json "main").
const forwarded = process.argv.slice(2)

// Stay attached to the terminal only for dev/capture flows or when asked; those
// need stdio and a foreground process. Otherwise detach, so the pet keeps living
// after the terminal closes — you quit it from the menu-bar icon, like any GUI
// app — and the prompt returns immediately.
const foreground =
  forwarded.includes('--foreground') ||
  forwarded.includes('-f') ||
  process.env.PET_DEBUG === '1' ||
  Boolean(process.env.PET_CAPTURE) ||
  Boolean(process.env.PET_POSE)

const args = [appRoot, ...forwarded.filter((a) => a !== '--foreground' && a !== '-f')]

if (foreground) {
  const child = spawn(electron, args, { stdio: 'inherit' })
  child.on('close', (code) => process.exit(code ?? 0))
  child.on('error', (err) => {
    console.error('Failed to launch meowverlay:', err.message)
    process.exit(1)
  })
} else {
  const child = spawn(electron, args, { stdio: 'ignore', detached: true })
  child.on('error', (err) => {
    console.error('Failed to launch meowverlay:', err.message)
    process.exit(1)
  })
  child.unref()
  console.log('meowverlay is running — quit it from the 🐱 icon in your menu bar.')
}
