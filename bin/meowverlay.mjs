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
      const res = spawnSync(process.execPath, [join(dir, 'install.js')], { stdio: 'inherit', cwd: dir })
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
  console.error(
    '\nCould not set up the Electron runtime automatically' +
      (installedButBroken ? ' (its binary is missing).' : ' (electron is not installed).') +
      '\n' +
      (pm
        ? `Reinstall so its setup script is allowed to run:\n\n  ${advice[pm]}\n`
        : 'No package manager (npm/pnpm/yarn/bun) was found on your PATH.\n' +
          'Install Node.js 20+ (which includes npm) from https://nodejs.org, then:\n\n' +
          '  npm i -g meowverlay --allow-scripts=electron\n'),
  )
  process.exit(1)
}

// Hand off to Electron, pointing it at this package (its package.json "main").
// argv is forwarded so env-gated dev flags still work.
const child = spawn(electron, [appRoot, ...process.argv.slice(2)], { stdio: 'inherit' })
child.on('close', (code) => process.exit(code ?? 0))
child.on('error', (err) => {
  console.error('Failed to launch meowverlay:', err.message)
  process.exit(1)
})
