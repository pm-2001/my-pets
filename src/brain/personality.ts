/**
 * Personality: a small vector of traits that every other system reads.
 *
 * Two pets with identical animations must behave differently, so nothing in the
 * behaviour engine hardcodes a speed, a frequency or a preference — it all comes
 * from here. Traits are derived from the archetype plus seeded jitter, so a
 * given pet is the same pet on every launch but no two "curious" pets are quite
 * alike.
 */

export interface Traits {
  /** Movement speed and how often it picks active behaviours. */
  energy: number
  /** Drive to explore windows and investigate changes. */
  curiosity: number
  /** Drive to be near the cursor and react to the user. */
  sociability: number
  /** Willingness to attempt long jumps and high ledges. */
  boldness: number
  /** How fast it tires and how readily it sleeps. */
  laziness: number
  /** Preference for cheeky behaviours over polite ones. */
  mischief: number
}

export type PersonalityName =
  | 'lazy'
  | 'energetic'
  | 'curious'
  | 'mischievous'
  | 'friendly'
  | 'shy'
  | 'brave'

const ARCHETYPES: Record<PersonalityName, Traits> = {
  lazy: { energy: 0.2, curiosity: 0.3, sociability: 0.4, boldness: 0.2, laziness: 0.9, mischief: 0.2 },
  energetic: { energy: 0.95, curiosity: 0.6, sociability: 0.6, boldness: 0.7, laziness: 0.1, mischief: 0.5 },
  curious: { energy: 0.6, curiosity: 0.95, sociability: 0.5, boldness: 0.6, laziness: 0.3, mischief: 0.4 },
  mischievous: { energy: 0.75, curiosity: 0.7, sociability: 0.5, boldness: 0.8, laziness: 0.2, mischief: 0.95 },
  friendly: { energy: 0.6, curiosity: 0.5, sociability: 0.95, boldness: 0.5, laziness: 0.3, mischief: 0.3 },
  shy: { energy: 0.4, curiosity: 0.6, sociability: 0.15, boldness: 0.15, laziness: 0.5, mischief: 0.2 },
  brave: { energy: 0.7, curiosity: 0.6, sociability: 0.5, boldness: 0.95, laziness: 0.2, mischief: 0.4 },
}

export const PERSONALITY_NAMES = Object.keys(ARCHETYPES) as PersonalityName[]

/** Small, fast, seedable PRNG so a pet's jitter is stable across launches. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const clamp01 = (n: number) => Math.max(0, Math.min(1, n))

export function buildTraits(personality: string, seed: number): Traits {
  const base = ARCHETYPES[personality as PersonalityName] ?? ARCHETYPES.friendly
  const rand = mulberry32(seed)
  const jitter = () => (rand() - 0.5) * 0.24

  return {
    energy: clamp01(base.energy + jitter()),
    curiosity: clamp01(base.curiosity + jitter()),
    sociability: clamp01(base.sociability + jitter()),
    boldness: clamp01(base.boldness + jitter()),
    laziness: clamp01(base.laziness + jitter()),
    mischief: clamp01(base.mischief + jitter()),
  }
}

/** Walking speed in points per second. */
export function walkSpeed(traits: Traits): number {
  return 26 + traits.energy * 48
}

export function runSpeed(traits: Traits): number {
  return 90 + traits.energy * 130
}

// Rich, natural cat coats — vivid enough to pop on the desktop while still
// reading as a real cat: ginger, blue-grey, cream, brown tabby, charcoal,
// cinnamon and silver.
export const COATS = [0xf59331, 0x6d84a6, 0xf4dcb0, 0x9a6532, 0x4d4c58, 0xc0743a, 0xa7b0bb]

/** Which coat a seed maps to. Exposed so pet creation can keep coats distinct. */
export function coatIndexForSeed(seed: number): number {
  return Math.floor(mulberry32(seed ^ 0x9e3779b9)() * COATS.length)
}

/** Colour palette derived from the seed, so pets are visually distinguishable. */
export function buildPalette(seed: number): { coat: number; belly: number; accent: number } {
  const coat = COATS[coatIndexForSeed(seed)]!
  return {
    coat,
    belly: lighten(coat, 0.35),
    accent: darken(coat, 0.45),
  }
}

function lighten(color: number, amount: number): number {
  const r = (color >> 16) & 0xff
  const g = (color >> 8) & 0xff
  const b = color & 0xff
  const mix = (c: number) => Math.round(c + (255 - c) * amount)
  return (mix(r) << 16) | (mix(g) << 8) | mix(b)
}

function darken(color: number, amount: number): number {
  const r = (color >> 16) & 0xff
  const g = (color >> 8) & 0xff
  const b = color & 0xff
  const mix = (c: number) => Math.round(c * (1 - amount))
  return (mix(r) << 16) | (mix(g) << 8) | mix(b)
}
