import { useCallback, useEffect, useRef, useState } from 'react'
import type { PetMemory, Settings } from '@shared/types'
import { Stage, type StageState } from './render/stage'
import { Bubble } from './ui/Bubble'
import './ui/ui.css'

/**
 * Glue: owns the pet's long-term memory, drives the stage, and renders the DOM
 * layer on top of the canvas.
 *
 * The simulation deliberately does not live in React state — it runs at 30fps
 * inside the Pixi ticker, and re-rendering a component tree that often would
 * dwarf the cost of the pet itself. React only sees a small summary each frame.
 */

const MEMORY_TICK_MS = 5000
const SAVE_EVERY_TICKS = 4

export function App() {
  const mountRef = useRef<HTMLDivElement>(null)
  const stageRef = useRef<Stage | null>(null)
  const memoryRef = useRef<PetMemory | null>(null)
  const stateRef = useRef<StageState | null>(null)

  const [ready, setReady] = useState(false)
  const [petState, setPetState] = useState<StageState | null>(null)
  const [bubble, setBubble] = useState<{ text: string; thinking: boolean } | null>(null)
  /** Mirrors `bubble` for the render callback, which closes over stale state. */
  const bubbleOpenRef = useRef(false)

  // --- boot ---------------------------------------------------------------
  useEffect(() => {
    let disposed = false
    let stage: Stage | null = null

    void (async () => {
      const [memory, settings] = await Promise.all([
        window.pet.loadMemory(),
        window.pet.loadSettings(),
      ])
      if (disposed || !mountRef.current) return

      memoryRef.current = memory
      stage = new Stage(memory, settings)
      stageRef.current = stage

      await stage.init(
        mountRef.current,
        (next) => {
          stateRef.current = next
          // Only push into React when something is actually rendering it.
          // Otherwise this would re-render the tree at the frame rate to feed a
          // component that is not mounted.
          if (bubbleOpenRef.current) setPetState(next)
        },
        () => handlePetClick(),
      )
      setReady(true)
    })()

    return () => {
      disposed = true
      stage?.destroy()
      stageRef.current = null
    }
    // Boot exactly once; handlePetClick reads through refs so it needs no deps.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // --- main-process events -------------------------------------------------
  useEffect(() => {
    const offEnv = window.pet.onEnv((env) => stageRef.current?.applyEnv(env))
    const offPulse = window.pet.onPulse((pulse) => stageRef.current?.applyPulse(pulse))
    const offPoke = window.pet.onPoke(() => handlePetClick())
    const offSettings = window.pet.onSettings((settings: Settings) =>
      stageRef.current?.setSettings(settings),
    )
    // A reset changes personality, palette and traits — rebuilding the whole
    // renderer is both simpler and more correct than patching them in place.
    const offReset = window.pet.onReset(() => window.location.reload())

    return () => {
      offEnv()
      offPulse()
      offPoke()
      offSettings()
      offReset()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // --- long-term memory ----------------------------------------------------
  useEffect(() => {
    if (!ready) return
    let ticks = 0

    const timer = setInterval(() => {
      const memory = memoryRef.current
      const stage = stageRef.current
      if (!memory || !stage) return

      const seconds = MEMORY_TICK_MS / 1000
      memory.aliveSeconds += seconds

      // Attribute time to whatever the user actually had in front of them, so
      // the pet slowly learns which app is "theirs".
      const front = stage.desktop.frontApp
      if (front && stage.desktop.idleSeconds < 60) {
        memory.appSeconds[front] = (memory.appSeconds[front] ?? 0) + seconds
      }

      if (++ticks % SAVE_EVERY_TICKS === 0) window.pet.saveMemory(memory)
    }, MEMORY_TICK_MS)

    // Never lose the session's memories to a quit.
    const flush = () => memoryRef.current && window.pet.saveMemory(memoryRef.current)
    window.addEventListener('beforeunload', flush)

    return () => {
      clearInterval(timer)
      window.removeEventListener('beforeunload', flush)
      flush()
    }
  }, [ready])

  // --- interaction ---------------------------------------------------------
  const say = useCallback(async (prompt: string) => {
    const memory = memoryRef.current
    if (!memory) return

    setBubble({ text: '', thinking: true })
    const reply = await window.pet.chat(prompt, memory)

    memory.chat.push({ role: 'user', text: prompt, at: Date.now() })
    memory.chat.push({ role: 'pet', text: reply, at: Date.now() })
    window.pet.saveMemory(memory)

    setBubble({ text: reply, thinking: false })
  }, [])

  const handlePetClick = useCallback(() => {
    const memory = memoryRef.current
    const stage = stageRef.current
    if (!memory || !stage) return

    stage.poke()
    memory.petCount += 1

    // Clicking an already-open bubble closes it; otherwise the pet greets you.
    setBubble((current) => {
      if (current) {
        stage.setForceInteractive(false)
        window.pet.setChatFocus(false)
        bubbleOpenRef.current = false
        return null
      }
      stage.setForceInteractive(true)
      window.pet.setChatFocus(true)
      bubbleOpenRef.current = true
      // Seed React with the current position so the bubble has somewhere to go
      // on its very first render.
      if (stateRef.current) setPetState(stateRef.current)
      void say('*pets you on the head*')
      return { text: '', thinking: true }
    })
  }, [say])

  const closeBubble = useCallback(() => {
    stageRef.current?.setForceInteractive(false)
    window.pet.setChatFocus(false)
    bubbleOpenRef.current = false
    setBubble(null)
  }, [])

  return (
    <>
      <div ref={mountRef} className="stage" />
      {/* While the bubble is open the whole overlay is solid, so a click
          anywhere else would otherwise be silently swallowed. Catching it to
          dismiss makes that click mean something. */}
      {bubble && <div className="scrim" onPointerDown={closeBubble} />}
      {bubble && petState && (
        <Bubble
          x={petState.screenX}
          y={petState.screenY}
          text={bubble.text}
          thinking={bubble.thinking}
          onSend={(message) => void say(message)}
          onClose={closeBubble}
        />
      )}
    </>
  )
}
