import type { Needs } from './needs'
import type { Traits } from './personality'

/**
 * Utility AI.
 *
 * Every action scores itself against the pet's current drives, and the highest
 * score wins. There is no state machine listing which action may follow which —
 * that is what makes long-run behaviour feel organic rather than looped.
 *
 * Three mechanisms keep a pure argmax from degenerating into a two-action
 * oscillation, which is the classic failure of naive utility AI:
 *
 *  1. cooldowns    — an action cannot immediately re-run
 *  2. recency      — recently used actions are penalised on a sliding scale
 *  3. momentum     — the running action gets a bonus until its minimum duration
 *                    elapses, so the pet commits instead of twitching
 *
 * Plus a little noise, so identical world states do not always produce the same
 * choice.
 */

export type ActionId =
  | 'idle'
  | 'lookAround'
  | 'walk'
  | 'run'
  | 'sit'
  | 'sleep'
  | 'stretch'
  | 'dance'
  | 'chase'
  | 'explore'
  | 'watch'
  | 'celebrate'
  | 'scratch'
  | 'follow'
  | 'play'
  | 'climb'

export interface ActionContext {
  needs: Needs
  traits: Traits
  /** Distance in points from the pet to the cursor. */
  cursorDistance: number
  /** Seconds since the user last touched an input device. */
  idleSeconds: number
  hour: number
  /** Ledges the pet could plausibly jump to right now. */
  ledgeCount: number
  /** Window edges the pet could scale to a top edge out of jump range. */
  wallCount: number
  /** True when the pet is standing on an application window rather than the floor. */
  onWindow: boolean
  asleep: boolean
  onBattery: boolean
  /** Other pets sharing this display; 0 means the pet is on its own. */
  petCount: number
  /** Distance in points to the nearest other pet; Infinity when alone. */
  nearestPetDistance: number
  /** Whether that nearest pet is currently asleep, for pile-sleeping. */
  nearestPetSleeping: boolean
}

export interface ActionDef {
  id: ActionId
  score(ctx: ActionContext): number
  /** Seconds the pet commits to this action before reconsidering. */
  minDuration: number
  maxDuration: number
  /** Seconds before this action may be chosen again. */
  cooldown: number
}

const n = (v: number) => Math.max(0, v)

export const ACTIONS: ActionDef[] = [
  {
    id: 'idle',
    // The baseline. Deliberately low and flat so anything with an actual drive
    // behind it wins, but never zero — the pet always has something to fall to.
    score: () => 12,
    minDuration: 1.5,
    maxDuration: 5,
    cooldown: 0,
  },
  {
    id: 'lookAround',
    score: (c) => 14 + c.needs.curiosity * 0.16 + c.traits.curiosity * 12,
    minDuration: 2,
    maxDuration: 4.5,
    cooldown: 6,
  },
  {
    id: 'sit',
    score: (c) => 16 + c.traits.laziness * 26 + c.needs.sleepiness * 0.12,
    minDuration: 4,
    maxDuration: 14,
    cooldown: 8,
  },
  {
    id: 'sleep',
    // Dominates once sleep pressure is genuinely high; below that it should not
    // compete at all, or a lazy pet would never do anything else.
    score: (c) => {
      const pressure = n(c.needs.sleepiness - 55) * 2.4
      const invited = c.idleSeconds > 90 ? 22 : 0
      const nightBonus = c.hour >= 23 || c.hour < 6 ? 18 : 0
      const batteryCare = c.onBattery ? 8 : 0
      return pressure + invited + nightBonus + batteryCare
    },
    minDuration: 20,
    maxDuration: 240,
    cooldown: 25,
  },
  {
    id: 'stretch',
    // Naturally follows waking, which is exactly when sleepiness has just fallen.
    score: (c) => (c.needs.sleepiness < 30 ? 26 : 8) + c.traits.energy * 8,
    minDuration: 1.6,
    maxDuration: 2.6,
    cooldown: 40,
  },
  {
    id: 'walk',
    score: (c) =>
      18 +
      c.needs.boredom * 0.28 +
      c.traits.energy * 18 -
      c.needs.sleepiness * 0.18 -
      (c.onBattery ? 6 : 0),
    minDuration: 2.5,
    maxDuration: 8,
    cooldown: 2,
  },
  {
    id: 'run',
    score: (c) =>
      n(c.needs.excitement - 45) * 0.9 +
      c.traits.energy * 26 +
      n(c.needs.boredom - 60) * 0.4 -
      c.needs.sleepiness * 0.3 -
      (c.onBattery ? 14 : 0),
    minDuration: 1.4,
    maxDuration: 3.5,
    cooldown: 14,
  },
  {
    id: 'chase',
    // Wanting company plus a cursor within reach. Shy pets barely register it.
    score: (c) => {
      if (c.cursorDistance > 700) return 0
      const proximity = 1 - Math.min(1, c.cursorDistance / 700)
      return (
        (c.needs.loneliness * 0.5 + c.traits.sociability * 34) * proximity -
        c.needs.sleepiness * 0.25
      )
    },
    minDuration: 2.5,
    maxDuration: 7,
    cooldown: 10,
  },
  {
    id: 'watch',
    // Quietly observing the user typing. The polite alternative to chasing.
    score: (c) => {
      if (c.idleSeconds > 6) return 0
      return 16 + c.traits.sociability * 20 + c.traits.curiosity * 10 - c.traits.energy * 8
    },
    minDuration: 3,
    maxDuration: 9,
    cooldown: 12,
  },
  {
    id: 'explore',
    // Jumping between windows. Needs somewhere to jump to and the nerve to try.
    score: (c) => {
      if (c.ledgeCount === 0) return 0
      return (
        c.needs.curiosity * 0.42 +
        c.traits.curiosity * 22 +
        c.traits.boldness * 18 -
        c.needs.sleepiness * 0.35
      )
    },
    minDuration: 2,
    maxDuration: 6,
    cooldown: 9,
  },
  {
    id: 'dance',
    score: (c) => n(c.needs.excitement - 40) * 0.8 + c.traits.energy * 14 + c.traits.mischief * 10,
    minDuration: 3,
    maxDuration: 6,
    cooldown: 30,
  },
  {
    id: 'celebrate',
    score: (c) => n(c.needs.excitement - 65) * 1.3 + c.traits.sociability * 10,
    minDuration: 1.5,
    maxDuration: 3,
    cooldown: 45,
  },
  {
    id: 'scratch',
    // Cheeky: only worth doing on someone else's window, and only if the pet is
    // the sort to do it.
    score: (c) => (c.onWindow ? c.traits.mischief * 34 + c.needs.boredom * 0.2 : 4),
    minDuration: 1.8,
    maxDuration: 3.2,
    cooldown: 35,
  },
  {
    id: 'follow',
    // Trailing another pet across the desktop. Wants company and a companion far
    // enough away to be worth walking to; a sociable pet gravitates hard.
    score: (c) => {
      if (c.petCount === 0 || c.nearestPetDistance > 650) return 0
      // Already snuggled up — no need to keep closing the gap.
      if (c.nearestPetDistance < 70) return 0
      const proximity = 1 - Math.min(1, c.nearestPetDistance / 650)
      return (c.needs.loneliness * 0.4 + c.traits.sociability * 30) * proximity - c.needs.sleepiness * 0.2
    },
    minDuration: 2.5,
    maxDuration: 7,
    cooldown: 8,
  },
  {
    id: 'play',
    // Two pets close together with energy to burn tumble about. Reads as the
    // pair actually interacting rather than just standing near each other.
    score: (c) => {
      if (c.petCount === 0 || c.nearestPetDistance > 170 || c.nearestPetSleeping) return 0
      return n(c.needs.excitement - 25) * 0.6 + c.traits.energy * 20 + c.traits.mischief * 12 + c.traits.sociability * 8
    },
    minDuration: 2,
    maxDuration: 4.5,
    cooldown: 12,
  },
  {
    id: 'climb',
    // Scaling the side of a tall window to reach a title bar it could never jump
    // to. Personality-gated: a bold, energetic cat scales walls readily; a timid
    // one stays on the floor and only takes the low jumps. Needs a wall to climb.
    score: (c) => {
      if (c.wallCount === 0) return 0
      return (
        c.traits.boldness * 34 +
        c.traits.energy * 12 +
        c.needs.curiosity * 0.25 -
        c.needs.sleepiness * 0.3 -
        (c.onBattery ? 8 : 0)
      )
    },
    // Long enough to walk to the wall and make the ascent before reconsidering.
    minDuration: 5,
    maxDuration: 14,
    cooldown: 16,
  },
]

const BY_ID = new Map(ACTIONS.map((a) => [a.id, a]))

export function actionDef(id: ActionId): ActionDef {
  return BY_ID.get(id) ?? ACTIONS[0]!
}

export interface Selection {
  id: ActionId
  /** How long the pet intends to stay in it, sampled from the action's range. */
  duration: number
}

export interface SelectionState {
  current: ActionId
  /** Seconds spent in the current action. */
  elapsed: number
  /** Seconds the current action intends to last. */
  duration: number
  /** Seconds since each action last ran, keyed by id. */
  since: Partial<Record<ActionId, number>>
}

/** How long an action stays penalised after running, in seconds. */
const RECENCY_WINDOW = 45

export function chooseAction(
  ctx: ActionContext,
  state: SelectionState,
  rand: () => number,
): Selection | null {
  // Commit: while inside the minimum duration, do not even evaluate. This is
  // what stops the pet flickering between two near-equal options every tick.
  const currentDef = actionDef(state.current)
  if (state.elapsed < Math.min(currentDef.minDuration, state.duration)) return null
  if (state.elapsed < state.duration && state.current !== 'idle') {
    // Past the minimum but still within the intended duration: only a clearly
    // better option should interrupt.
    const challenger = best(ctx, state, rand)
    const incumbent = currentDef.score(ctx)
    if (!challenger || challenger.value < incumbent * 1.35) return null
    return { id: challenger.id, duration: sampleDuration(actionDef(challenger.id), rand) }
  }

  const picked = best(ctx, state, rand)
  if (!picked) return { id: 'idle', duration: sampleDuration(actionDef('idle'), rand) }
  return { id: picked.id, duration: sampleDuration(actionDef(picked.id), rand) }
}

function best(
  ctx: ActionContext,
  state: SelectionState,
  rand: () => number,
): { id: ActionId; value: number } | null {
  let winner: { id: ActionId; value: number } | null = null

  for (const def of ACTIONS) {
    const since = state.since[def.id] ?? Number.POSITIVE_INFINITY
    if (since < def.cooldown) continue

    let value = def.score(ctx)
    if (value <= 0) continue

    // Recency penalty: fades linearly back to no penalty over the window. Keeps
    // variety without banning an action outright the way a cooldown does.
    if (since < RECENCY_WINDOW) {
      value *= 0.45 + 0.55 * (since / RECENCY_WINDOW)
    }

    // Noise, scaled to the score so it perturbs ordering among near-equals
    // without letting a weak action beat a strongly-motivated one.
    value *= 0.85 + rand() * 0.3

    if (!winner || value > winner.value) winner = { id: def.id, value }
  }

  return winner
}

function sampleDuration(def: ActionDef, rand: () => number): number {
  return def.minDuration + rand() * (def.maxDuration - def.minDuration)
}
