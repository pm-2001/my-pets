import { app } from 'electron'
import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import type { PetMemory, Settings } from '../src/shared/types'

/**
 * Flat-file persistence. JSON rather than SQLite on purpose: the whole dataset is
 * a few kilobytes, and avoiding a native module keeps the build to a plain
 * `npm install` with no node-gyp toolchain.
 *
 * Writes go through a temp file + rename so a crash mid-save cannot leave the
 * pet's memory truncated.
 */

const MAX_CHAT_HISTORY = 60

function pathFor(file: string): string {
  return join(app.getPath('userData'), file)
}

function readJson<T>(file: string, fallback: T): T {
  try {
    return { ...fallback, ...(JSON.parse(readFileSync(pathFor(file), 'utf8')) as object) } as T
  } catch {
    return fallback
  }
}

function writeJson(file: string, value: unknown): void {
  const target = pathFor(file)
  mkdirSync(dirname(target), { recursive: true })
  const temp = `${target}.tmp`
  writeFileSync(temp, JSON.stringify(value, null, 2), 'utf8')
  renameSync(temp, target)
}

const PERSONALITIES = ['lazy', 'energetic', 'curious', 'mischievous', 'friendly', 'shy', 'brave']

function freshMemory(): PetMemory {
  const seed = Math.floor(Math.random() * 2 ** 31)
  return {
    name: 'Mochi',
    seed,
    // Derived from the seed so a given pet's nature is stable forever.
    personality: PERSONALITIES[seed % PERSONALITIES.length]!,
    bornAt: Date.now(),
    aliveSeconds: 0,
    petCount: 0,
    appSeconds: {},
    userName: null,
    lastSeenAt: Date.now(),
    chat: [],
    notes: [],
  }
}

const DEFAULT_SETTINGS: Settings = {
  scale: 1,
  fps: 30,
  useWindows: true,
  aiChat: false,
  aiModel: 'claude-opus-5',
}

export const store = {
  loadMemory(): PetMemory {
    return readJson<PetMemory>('memory.json', freshMemory())
  },

  saveMemory(memory: PetMemory): void {
    // Bound the history so a long-lived pet cannot grow its file without limit.
    const trimmed: PetMemory = {
      ...memory,
      chat: memory.chat.slice(-MAX_CHAT_HISTORY),
      notes: memory.notes.slice(-40),
      lastSeenAt: Date.now(),
    }
    writeJson('memory.json', trimmed)
  },

  /** Wipe the pet: a new personality, a new name, no history. */
  resetMemory(): PetMemory {
    const born = freshMemory()
    writeJson('memory.json', born)
    return born
  },

  loadSettings(): Settings {
    return readJson<Settings>('settings.json', DEFAULT_SETTINGS)
  },

  saveSettings(settings: Settings): void {
    writeJson('settings.json', settings)
  },
}
