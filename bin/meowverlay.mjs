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

let electron = resolveElectron()

// Some machines block package install scripts for security, which leaves
// Electron's binary un-downloaded. We are a user-invoked command, not an install
// hook, so we can finish that setup ourselves on first run.
if (!electron) {
  try {
    const electronDir = dirname(require.resolve('electron/package.json'))
    console.error('meowverlay: first-run setup — downloading the Electron runtime…')
    const res = spawnSync(process.execPath, [join(electronDir, 'install.js')], {
      stdio: 'inherit',
      cwd: electronDir,
    })
    if (res.status === 0) electron = resolveElectron()
  } catch {
    // fall through to the guidance below
  }
}

if (!electron) {
  console.error(
    '\nCould not set up the Electron runtime automatically. Reinstall allowing its\n' +
      'setup script to run:\n\n' +
      '  npm i -g meowverlay --allow-scripts=electron\n\n' +
      'or, to allow it for all global installs:\n\n' +
      '  npm config set allow-scripts=electron --location=user && npm i -g meowverlay\n',
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
