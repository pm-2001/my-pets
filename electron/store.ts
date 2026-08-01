import { app } from 'electron'
import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import type { PetMemory, Settings } from '../src/shared/types'
import { COATS, coatIndexForSeed } from '../src/brain/personality'

/**
 * Flat-file persistence. JSON rather than SQLite on purpose: the whole dataset is
 * a few kilobytes, and avoiding a native module keeps the build to a plain
 * `npm install` with no node-gyp toolchain.
 *
 * Writes go through a temp file + rename so a crash mid-save cannot leave a pet's
 * memory truncated. Main is the single writer — every renderer routes memory
 * changes through it — so there is no multi-window race over the file even with
 * one overlay per display.
 *
 * The on-disk shape is `{ pets: PetMemory[] }`. A pre-multi-pet file was a bare
 * PetMemory object; it is migrated transparently on load.
 */

const MAX_CHAT_HISTORY = 60
const PERSONALITIES = ['lazy', 'energetic', 'curious', 'mischievous', 'friendly', 'shy', 'brave']
const NAMES = ['Mochi', 'Biscuit', 'Pixel', 'Sol', 'Ziggy', 'Clover', 'Miso', 'Pesto']

function pathFor(file: string): string {
  return join(app.getPath('userData'), file)
}

function readRaw(file: string): unknown {
  try {
    return JSON.parse(readFileSync(pathFor(file), 'utf8'))
  } catch {
    return null
  }
}

function writeJson(file: string, value: unknown): void {
  const target = pathFor(file)
  mkdirSync(dirname(target), { recursive: true })
  const temp = `${target}.tmp`
  writeFileSync(temp, JSON.stringify(value, null, 2), 'utf8')
  renameSync(temp, target)
}

export function freshMemory(index = 0, takenCoats: Iterable<number> = []): PetMemory {
  // Pick a seed whose coat isn't already worn by a sibling pet, so a litter of
  // several cats is visually distinct. Once every coat is in use (more pets than
  // colours) we stop insisting and let them repeat.
  const taken = new Set(takenCoats)
  let seed = Math.floor(Math.random() * 2 ** 31)
  if (taken.size < COATS.length) {
    for (let tries = 0; tries < 64 && taken.has(coatIndexForSeed(seed)); tries++) {
      seed = Math.floor(Math.random() * 2 ** 31)
    }
  }
  return {
    name: NAMES[(seed + index) % NAMES.length]!,
    seed,
    // Derived from the seed so a given pet's nature is stable forever.
    personality: PERSONALITIES[seed % PERSONALITIES.length]!,
    bornAt: Date.now(),
    aliveSeconds: 0,
    petCount: 0,
    appSeconds: {},
    appByHour: {},
    userName: null,
    lastSeenAt: Date.now(),
    chat: [],
    notes: [],
  }
}

/** Backfill any fields a memory written by an older version is missing. */
function hydrate(raw: Partial<PetMemory>): PetMemory {
  return { ...freshMemory(), ...raw, appByHour: raw.appByHour ?? {} }
}

function trim(memory: PetMemory): PetMemory {
  return {
    ...memory,
    // Bound history so a long-lived pet cannot grow its file without limit.
    chat: memory.chat.slice(-MAX_CHAT_HISTORY),
    notes: memory.notes.slice(-40),
    lastSeenAt: Date.now(),
  }
}

const DEFAULT_SETTINGS: Settings = {
  scale: 1.5,
  fps: 30,
  useWindows: true,
  pets: 1,
  aiChat: false,
  aiModel: 'claude-opus-5',
}

export const store = {
  loadPets(): PetMemory[] {
    const raw = readRaw('memory.json')
    if (raw && typeof raw === 'object' && Array.isArray((raw as { pets?: unknown }).pets)) {
      const pets = (raw as { pets: Partial<PetMemory>[] }).pets.map(hydrate)
      return pets.length ? pets : [freshMemory()]
    }
    // Legacy single-pet file: wrap it as the first pet.
    if (raw && typeof raw === 'object') return [hydrate(raw as Partial<PetMemory>)]
    return [freshMemory()]
  },

  savePets(pets: PetMemory[]): void {
    writeJson('memory.json', { pets: pets.map(trim) })
  },

  loadSettings(): Settings {
    const raw = readRaw('settings.json')
    return { ...DEFAULT_SETTINGS, ...(raw && typeof raw === 'object' ? raw : {}) }
  },

  saveSettings(settings: Settings): void {
    writeJson('settings.json', settings)
  },
}
