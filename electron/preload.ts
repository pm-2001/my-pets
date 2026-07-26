import { contextBridge, ipcRenderer } from 'electron'
import type { PetBridge, PetMemory, Settings, WorldEnv, WorldPulse } from '../src/shared/types'

/**
 * The only surface the renderer gets. Node integration is off and context
 * isolation is on, so everything the pet can do to the machine passes through
 * this list.
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

  loadMemory: () => ipcRenderer.invoke('memory:load') as Promise<PetMemory>,
  saveMemory: (memory) => ipcRenderer.send('memory:save', memory),
  loadSettings: () => ipcRenderer.invoke('settings:load') as Promise<Settings>,
  saveSettings: (settings) => ipcRenderer.send('settings:save', settings),
  chat: (prompt, memory) => ipcRenderer.invoke('pet:chat', prompt, memory) as Promise<string>,
  quit: () => ipcRenderer.send('pet:quit'),
  debug: process.env.PET_DEBUG === '1',
}

contextBridge.exposeInMainWorld('pet', bridge)
