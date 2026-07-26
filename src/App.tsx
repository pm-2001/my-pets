import { useCallback, useEffect, useRef, useState } from 'react'
import type { Settings } from '@shared/types'
import { Stage, type StageState } from './render/stage'
import { Bubble } from './ui/Bubble'
import './ui/ui.css'

/**
 * Glue: drives the stage for this window's display and renders the DOM speech
 * bubble on top of the canvas.
 *
 * Long-term memory no longer lives here — main owns it, so this component is
 * almost entirely about the one pet a bubble is currently attached to. The
 * simulation runs at up to 30fps inside the stage's own loop; React only sees a
 * small per-frame summary, and only while a bubble is actually open.
 */

/**
 * Turn something the user typed into a command the pet can act on. Matched on
 * simple keywords so it works with the local voice and without a network round
 * trip — the point is that saying "jump" makes the cat jump, right now. Returns
 * the stage intent plus a short in-character acknowledgement, or null when the
 * message is just conversation.
 */
const COMMANDS: [RegExp, string, string][] = [
  [/\b(jump|hop|leap|boing)\b/, 'hop', '*boing!*'],
  [/\b(come|here|follow me|to me)\b/, 'chase', 'coming!'],
  [/\b(wake|get up|wake up)\b/, 'wake', '*perks up*'],
  [/\b(sleep|nap|goodnight|good night|bed|bedtime)\b/, 'sleep', '*curls up* zzz…'],
  [/\b(sit|sit down)\b/, 'sit', '*sits*'],
  [/\b(dance|boogie)\b/, 'dance', '*busts a move*'],
  [/\b(run|zoom|zoomies|sprint)\b/, 'run', '*zoomies!*'],
  [/\b(climb|scale)\b/, 'climb', '*finds a wall to climb*'],
  [/\b(explore|adventure|windows)\b/, 'explore', '*off exploring*'],
  [/\b(stretch)\b/, 'stretch', '*big stretch*'],
  [/\b(play|celebrate|party|yay)\b/, 'celebrate', 'yay!'],
  [/\b(scratch)\b/, 'scratch', '*scratch scratch*'],
  [/\b(look|watch|scan)\b/, 'lookAround', '*looks around*'],
  [/\b(walk|wander|stroll)\b/, 'walk', '*wanders off*'],
  [/\b(stop|stay|chill|relax|rest|calm)\b/, 'idle', '*settles down*'],
]

function parseIntent(text: string): { intent: string; ack: string } | null {
  const t = text.toLowerCase()
  for (const [re, intent, ack] of COMMANDS) if (re.test(t)) return { intent, ack }
  return null
}

export function App() {
  const mountRef = useRef<HTMLDivElement>(null)
  const stageRef = useRef<Stage | null>(null)
  const stateRef = useRef<StageState | null>(null)
  /** The pet a bubble is currently attached to, read by callbacks. */
  const activePetRef = useRef<number | null>(null)
  /** Mirrors `bubble` for the render callback, which closes over stale state. */
  const bubbleOpenRef = useRef(false)

  const [petState, setPetState] = useState<StageState | null>(null)
  const [bubble, setBubble] = useState<{ text: string; thinking: boolean } | null>(null)

  const say = useCallback(async (petId: number, prompt: string) => {
    // A recognised command makes the cat act immediately, with a snappy ack and
    // no network round trip.
    const command = parseIntent(prompt)
    if (command) {
      stageRef.current?.command(petId, command.intent)
      setBubble({ text: command.ack, thinking: false })
      return
    }

    // Otherwise it perks up and answers in words.
    stageRef.current?.command(petId, 'acknowledge')
    setBubble({ text: '', thinking: true })
    const reply = await window.pet.chat(petId, prompt)
    // A different pet may have been clicked while we waited; ignore stale replies.
    if (activePetRef.current !== petId) return
    setBubble({ text: reply, thinking: false })
  }, [])

  const closeBubble = useCallback(() => {
    const stage = stageRef.current
    stage?.setForceInteractive(false)
    stage?.setActivePet(null)
    window.pet.setChatFocus(false)
    bubbleOpenRef.current = false
    activePetRef.current = null
    setBubble(null)
  }, [])

  const openBubbleFor = useCallback(
    (petId: number) => {
      const stage = stageRef.current
      if (!stage) return

      // Clicking the pet whose bubble is already open closes it; clicking a
      // different pet switches the bubble across to that one.
      if (bubbleOpenRef.current && activePetRef.current === petId) {
        closeBubble()
        return
      }

      stage.poke(petId)
      window.pet.poked(petId)
      stage.setActivePet(petId)
      activePetRef.current = petId
      stage.setForceInteractive(true)
      window.pet.setChatFocus(true)
      bubbleOpenRef.current = true
      if (stateRef.current) setPetState(stateRef.current)
      setBubble({ text: '', thinking: true })
      void say(petId, '*pets you on the head*')
    },
    [closeBubble, say],
  )

  // --- boot ---------------------------------------------------------------
  useEffect(() => {
    let disposed = false
    let stage: Stage | null = null

    void (async () => {
      const settings = await window.pet.loadSettings()
      if (disposed || !mountRef.current) return

      stage = new Stage(settings)
      stageRef.current = stage

      await stage.init(
        mountRef.current,
        (next) => {
          stateRef.current = next
          // Only push into React when a bubble is actually rendering it; otherwise
          // this would re-render the tree at the frame rate to feed nothing.
          if (bubbleOpenRef.current) setPetState(next)
        },
        (petId) => openBubbleFor(petId),
      )

      // Pull the opening world snapshot and assignment rather than waiting on a
      // pushed event, which a freshly-mounted window can miss. Live updates still
      // arrive via the event listeners below.
      const [env, assignment] = await Promise.all([window.pet.loadEnv(), window.pet.loadAssignment()])
      if (disposed) return
      if (env) stage.applyEnv(env)
      stage.applyAssignment(assignment)
    })()

    return () => {
      disposed = true
      stage?.destroy()
      stageRef.current = null
    }
    // Boot exactly once; callbacks read through refs so they need no deps.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // --- main-process events -------------------------------------------------
  useEffect(() => {
    const offEnv = window.pet.onEnv((env) => stageRef.current?.applyEnv(env))
    const offPulse = window.pet.onPulse((pulse) => stageRef.current?.applyPulse(pulse))
    const offAssign = window.pet.onAssign((a) => stageRef.current?.applyAssignment(a))
    const offReceive = window.pet.onReceive((spawn) => stageRef.current?.receivePet(spawn))
    const offSettings = window.pet.onSettings((settings: Settings) => stageRef.current?.setSettings(settings))
    // Tray "Say hi": greet whichever pet is on this display.
    const offPoke = window.pet.onPoke(() => {
      const id = stageRef.current?.pokeAny()
      if (id != null) openBubbleFor(id)
    })
    // A reset changes personalities, palettes and traits — a full reload is both
    // simpler and more correct than patching every pet in place.
    const offReset = window.pet.onReset(() => window.location.reload())

    return () => {
      offEnv()
      offPulse()
      offAssign()
      offReceive()
      offSettings()
      offPoke()
      offReset()
    }
  }, [openBubbleFor])

  return (
    <>
      <div ref={mountRef} className="stage" />
      {/* While a bubble is open the whole overlay is solid, so a click anywhere
          else would otherwise be silently swallowed. Catching it to dismiss
          makes that click mean something. */}
      {bubble && <div className="scrim" onPointerDown={closeBubble} />}
      {bubble && petState && (
        <Bubble
          x={petState.screenX}
          y={petState.screenY}
          text={bubble.text}
          thinking={bubble.thinking}
          onSend={(message) => activePetRef.current != null && void say(activePetRef.current, message)}
          onClose={closeBubble}
        />
      )}
    </>
  )
}
