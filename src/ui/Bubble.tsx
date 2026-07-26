import { useEffect, useRef, useState } from 'react'

/**
 * The pet's speech bubble.
 *
 * Rendered as DOM rather than inside the canvas so text stays crisp and the
 * input field is a real input — Pixi text entry would be a reimplementation of
 * something the platform already does well.
 */

interface BubbleProps {
  /** Pet position in window-local coordinates (top of the pet's head). */
  x: number
  y: number
  text: string
  thinking: boolean
  onSend: (message: string) => void
  onClose: () => void
}

const WIDTH = 240

export function Bubble({ x, y, text, thinking, onSend, onClose }: BubbleProps) {
  const [draft, setDraft] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  // Keep the bubble on screen when the pet wanders to an edge.
  const left = Math.max(8, Math.min(window.innerWidth - WIDTH - 8, x - WIDTH / 2))
  const top = Math.max(8, y - 96)

  return (
    <div className="bubble" style={{ left, top, width: WIDTH }}>
      <div className="bubble-text">
        {thinking ? <span className="bubble-dots">•••</span> : text}
      </div>
      <form
        className="bubble-form"
        onSubmit={(event) => {
          event.preventDefault()
          const message = draft.trim()
          if (!message) return
          setDraft('')
          onSend(message)
        }}
      >
        <input
          ref={inputRef}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          placeholder="say something…"
          spellCheck={false}
          autoComplete="off"
        />
      </form>
      <button className="bubble-close" onClick={onClose} aria-label="Close">
        ×
      </button>
      <div className="bubble-tail" />
    </div>
  )
}
