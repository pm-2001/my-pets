import { contextBridge, ipcRenderer } from 'electron'
import type { PetAssignment, PetBridge, PetSpawn, Settings, WorldEnv, WorldPulse } from '../src/shared/types'

/**
 * The only surface the renderer gets. Node integration is off and context
 * isolation is on, so everything the pet can do to the machine passes through
 * this list. Memory now lives in main, so the renderer can no longer read or
 * write it directly — it only asks main to record interactions.
 */
const bridge: PetBridge = {
  onEnv(cb) {
    const listener = (_event: unknown, env: WorldEnv) => cb(env)
    ipcRenderer.on('world:env', listener)
    return () => ipcRenderer.removeListener('world:env', listener)
  },

  onPulse(cb) {
    const listener = (_event: unknown, pulse: WorldPulse) => cb(pulse)
    ipcRenderer.on('world:pulse', listener)
    return () => ipcRenderer.removeListener('world:pulse', listener)
  },

  onAssign(cb) {
    const listener = (_event: unknown, assignment: PetAssignment) => cb(assignment)
    ipcRenderer.on('pet:assign', listener)
    return () => ipcRenderer.removeListener('pet:assign', listener)
  },

  onReceive(cb) {
    const listener = (_event: unknown, spawn: PetSpawn) => cb(spawn)
    ipcRenderer.on('pet:receive', listener)
    return () => ipcRenderer.removeListener('pet:receive', listener)
  },

  onPoke(cb) {
    const listener = () => cb()
    ipcRenderer.on('pet:poke', listener)
    return () => ipcRenderer.removeListener('pet:poke', listener)
  },

  onSettings(cb) {
    const listener = (_event: unknown, settings: Settings) => cb(settings)
    ipcRenderer.on('settings', listener)
    return () => ipcRenderer.removeListener('settings', listener)
  },

  onReset(cb) {
    const listener = () => cb()
    ipcRenderer.on('pet:reset', listener)
    return () => ipcRenderer.removeListener('pet:reset', listener)
  },

  setInteractive(interactive) {
    ipcRenderer.send('pet:interactive', interactive)
  },

  setChatFocus(focused) {
    ipcRenderer.send('pet:chat-focus', focused)
  },

  handoff(spawn) {
    ipcRenderer.send('pet:handoff', spawn)
  },

  poked(petId) {
    ipcRenderer.send('pet:poked', petId)
  },

  loadSettings: () => ipcRenderer.invoke('settings:load') as Promise<Settings>,
  loadAssignment: () => ipcRenderer.invoke('assign:load') as Promise<PetAssignment>,
  loadEnv: () => ipcRenderer.invoke('env:load') as Promise<WorldEnv | null>,
  chat: (petId, prompt) => ipcRenderer.invoke('pet:chat', petId, prompt) as Promise<string>,
  quit: () => ipcRenderer.send('pet:quit'),
  debug: process.env.PET_DEBUG === '1',
  posePreview: process.env.PET_POSE ?? null,
  emotePreview: process.env.PET_EMOTE ?? null,
}

contextBridge.exposeInMainWorld('pet', bridge)
