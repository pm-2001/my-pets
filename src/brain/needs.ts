import type { Traits } from './personality'

/**
 * Internal drives, each 0..100.
 *
 * These are the only inputs to action scoring, which is what keeps behaviour
 * from feeling scripted: nothing schedules "sleep at 3pm", sleepiness simply
 * rises until it outweighs everything else. Personality changes the rates, so
 * a lazy pet reaches that threshold far sooner than an energetic one.
 */
export interface Needs {
  sleepiness: number
  boredom: number
  curiosity: number
  loneliness: number
  excitement: number
}

export type Mood = 'happy' | 'sleepy' | 'curious' | 'excited' | 'lonely' | 'relaxed' | 'bored'

export function freshNeeds(): Needs {
  return { sleepiness: 15, boredom: 20, curiosity: 30, loneliness: 10, excitement: 20 }
}

const clamp = (n: number) => Math.max(0, Math.min(100, n))

export interface NeedContext {
  /** Seconds since the user last touched the keyboard or mouse. */
  idleSeconds: number
  hour: number
  /** True while the pet is actually asleep. */
  asleep: boolean
  /** Distance in points from pet to cursor. */
  cursorDistance: number
  /** Distance to the nearest other pet on the same display; Infinity if alone. */
  nearestPetDistance: number
}

export function tickNeeds(needs: Needs, traits: Traits, ctx: NeedContext, dt: number): Needs {
  const night = ctx.hour >= 23 || ctx.hour < 6
  const userAway = ctx.idleSeconds > 60

  // Sleep pressure builds faster for lazy pets, faster at night, and faster when
  // there is nobody around to stay awake for.
  let sleepRate = (0.35 + traits.laziness * 1.4) * (night ? 2.2 : 1) * (userAway ? 1.6 : 1)
  if (ctx.asleep) sleepRate = -(6 + traits.energy * 5)

  // Boredom only accumulates when someone is around to be ignored by.
  const boredRate = userAway ? 0.15 : 0.5 + traits.energy * 0.7

  const curiosityRate = 0.3 + traits.curiosity * 1.1

  // Loneliness needs both absence and a sociable disposition to matter. Company
  // is company: a nearby cursor *or* another pet nearby soothes it, which is what
  // pulls a lonely pet towards its companions and lets them settle in a pile.
  const nearCompany = ctx.cursorDistance < 140 || ctx.nearestPetDistance < 150
  const lonelyRate = nearCompany ? -3.5 : (userAway ? 0.5 : 0.2) * (0.3 + traits.sociability * 1.8)

  // Excitement is spiky by nature: it is added to by events and always decays.
  const excitementRate = -1.4 + (ctx.idleSeconds < 2 ? 0.9 + traits.energy : 0)

  return {
    sleepiness: clamp(needs.sleepiness + sleepRate * dt),
    boredom: clamp(needs.boredom + boredRate * dt),
    curiosity: clamp(needs.curiosity + curiosityRate * dt),
    loneliness: clamp(needs.loneliness + lonelyRate * dt),
    excitement: clamp(needs.excitement + excitementRate * dt),
  }
}

/** The single strongest drive, used for dialogue and facial expression. */
export function moodFrom(needs: Needs, traits: Traits, asleep: boolean): Mood {
  if (asleep || needs.sleepiness > 78) return 'sleepy'
  if (needs.excitement > 70) return 'excited'
  if (needs.loneliness > 65) return 'lonely'
  if (needs.curiosity > 70 && traits.curiosity > 0.4) return 'curious'
  if (needs.boredom > 70) return 'bored'
  if (needs.sleepiness < 35 && needs.boredom < 40) return 'happy'
  return 'relaxed'
}
