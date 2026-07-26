#!/usr/bin/env node
// CLI entry point: `npx meowverlay` or, after `npm i -g meowverlay`, just
// `meowverlay`. Launches the prebuilt app under Electron. The app is shipped
// already built (dist/ + dist-electron/ with a universal deskscan helper), so no
// Xcode or compile step is needed to run it.

import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { createRequire } from 'node:module'

const appRoot = join(dirname(fileURLToPath(import.meta.url)), '..')

if (process.platform !== 'darwin') {
  console.error(
    'meowverlay currently runs on macOS only.\n' +
      'It relies on macOS window enumeration and a macOS-specific overlay; Windows\n' +
      'and Linux support is on the roadmap. Nothing was launched.',
  )
  process.exit(0)
}

let electron
try {
  // The electron package exports the path to its executable.
  electron = createRequire(import.meta.url)('electron')
} catch {
  console.error('Could not find the electron runtime. Try reinstalling: npm i -g meowverlay')
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
