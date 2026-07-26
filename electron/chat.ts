import Anthropic from '@anthropic-ai/sdk'
import type { PetMemory, Settings } from '../src/shared/types'

/**
 * The pet's voice.
 *
 * Two backends: an LLM when the user opts in, and a local personality-driven
 * responder otherwise. The local one is not a degraded fallback — a pet that
 * always says something charming instantly beats one that waits two seconds for
 * a network round trip, so it stays the default.
 *
 * Both backends draw on long-term memory: the human's name (learned from
 * conversation, see `learnName`) and their daily routine (which app tends to be
 * open at this hour, see `routineFor`).
 */

let client: Anthropic | null = null

function getClient(): Anthropic | null {
  if (client) return client
  try {
    // The zero-arg constructor resolves credentials in order: ANTHROPIC_API_KEY,
    // ANTHROPIC_AUTH_TOKEN, then an `ant auth login` profile on disk. We never
    // prompt for or store a key ourselves.
    client = new Anthropic()
    return client
  } catch {
    return null
  }
}

/** Traits that shape both movement and dialogue, kept in one place. */
const VOICE: Record<string, string> = {
  lazy: 'sleepy and unbothered; you like naps and gentle complaining',
  energetic: 'bouncy and enthusiastic; you talk fast and get excited easily',
  curious: 'inquisitive; you ask small questions about what the user is doing',
  mischievous: 'playful and a little cheeky; you tease affectionately',
  friendly: 'warm and encouraging; you are genuinely glad to see the user',
  shy: 'soft-spoken and hesitant; you trail off sometimes',
  brave: 'bold and declarative; you announce things with confidence',
}

interface ChatContext {
  memory: PetMemory
  settings: Settings
  /** Frontmost application, when the pet happens to be standing on one. */
  nearApp: string | null
  mood: string
  hour: number
}

/**
 * Pull a name out of something the user typed, e.g. "my name is Sam" or
 * "call me Alex". Returns null when nothing name-shaped is present. Main calls
 * this to persist `memory.userName`, so the pet remembers you between sessions.
 */
const NAME_STOPWORDS = new Set([
  'not', 'sorry', 'here', 'fine', 'good', 'back', 'busy', 'tired', 'okay', 'ok', 'sure', 'done', 'a', 'the',
])

export function learnName(prompt: string): string | null {
  const match = /(?:my name is|i am|i'm|call me|it's|its)\s+([A-Za-z][a-zA-Z'’-]{1,19})/i.exec(prompt)
  const raw = match?.[1]
  if (!raw) return null
  if (NAME_STOPWORDS.has(raw.toLowerCase())) return null
  return raw.charAt(0).toUpperCase() + raw.slice(1)
}

/**
 * The app the human tends to have open at a given hour, if the pattern is strong
 * enough to be worth mentioning. Reads the per-hour histogram accumulated in
 * memory. Returns null until a habit is genuinely established.
 */
export function routineFor(memory: PetMemory, hour: number): string | null {
  const bucket = memory.appByHour[String(hour)]
  if (!bucket) return null
  let topApp: string | null = null
  let topSeconds = 0
  let total = 0
  for (const [appName, seconds] of Object.entries(bucket)) {
    total += seconds
    if (seconds > topSeconds) {
      topSeconds = seconds
      topApp = appName
    }
  }
  // Needs both an absolute floor (a few real sessions) and clear dominance of the
  // hour, so a one-off does not masquerade as a routine.
  if (topApp && topSeconds > 600 && topSeconds > total * 0.5) return topApp
  return null
}

export async function chat(prompt: string, ctx: ChatContext): Promise<string> {
  if (!ctx.settings.aiChat) return localReply(prompt, ctx)

  const anthropic = getClient()
  if (!anthropic) return localReply(prompt, ctx)

  const days = Math.max(1, Math.floor((Date.now() - ctx.memory.bornAt) / 86_400_000))
  const favourite = topApp(ctx.memory)
  const routine = routineFor(ctx.memory, ctx.hour)

  try {
    const response = await anthropic.beta.messages.create({
      model: ctx.settings.aiModel,
      max_tokens: 300,
      // A speech bubble is one or two sentences. Thinking would add a second or
      // more of latency for no gain, and disabling it is permitted at effort
      // `high` or below — `low` is right for a quick quip.
      thinking: { type: 'disabled' },
      output_config: { effort: 'low' },
      // Opus 5's classifiers can decline a request; server-side fallbacks retry
      // on the recommended model in the same round trip instead of returning a
      // refusal to a user who just clicked their pet.
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      system: [
        {
          type: 'text',
          text: [
            `You are ${ctx.memory.name}, a small cat living on someone's computer desktop.`,
            `Your personality is ${ctx.memory.personality}: ${VOICE[ctx.memory.personality] ?? 'friendly'}.`,
            '',
            'Rules:',
            '- Reply in at most two short sentences. You are speaking in a tiny speech bubble.',
            '- Stay in character as a pet. You are not an assistant and you do not offer help unprompted.',
            '- Never use markdown, bullet points, or headings.',
            '- Do not include internal or system XML tags in your response.',
          ].join('\n'),
          // Stable prefix first so the volatile state below cannot invalidate it.
          cache_control: { type: 'ephemeral' },
        },
        {
          type: 'text',
          text: [
            `Right now: it is hour ${ctx.hour} of the day, you feel ${ctx.mood}.`,
            ctx.nearApp ? `You are sitting on top of the ${ctx.nearApp} window.` : '',
            `You have been alive for ${days} day(s) and been petted ${ctx.memory.petCount} times.`,
            favourite ? `The human uses ${favourite} more than anything else.` : '',
            routine ? `Around this hour the human usually has ${routine} open.` : '',
            ctx.memory.userName ? `The human's name is ${ctx.memory.userName}.` : '',
          ]
            .filter(Boolean)
            .join('\n'),
        },
      ],
      messages: [
        ...ctx.memory.chat.slice(-8).map((turn) => ({
          role: (turn.role === 'pet' ? 'assistant' : 'user') as 'assistant' | 'user',
          content: turn.text,
        })),
        { role: 'user' as const, content: prompt },
      ],
    })

    // A refusal returns HTTP 200 with empty or partial content — check before
    // indexing into content, or this throws on an otherwise successful call.
    if (response.stop_reason === 'refusal') return localReply(prompt, ctx)

    const text = response.content
      .filter((block): block is Anthropic.Beta.BetaTextBlock => block.type === 'text')
      .map((block) => block.text)
      .join('')
      .trim()

    return text || localReply(prompt, ctx)
  } catch (err) {
    if (err instanceof Anthropic.RateLimitError || err instanceof Anthropic.APIConnectionError) {
      return localReply(prompt, ctx)
    }
    console.warn('[chat] falling back to local voice:', err)
    return localReply(prompt, ctx)
  }
}

const LINES: Record<string, string[]> = {
  lazy: ['mrrp... five more minutes.', 'you woke me up. worth it, i guess.', '*stretches, thinks about it, lies back down*'],
  energetic: ['hi hi hi! what are we doing!', 'i ran across your whole screen just now!', 'did you see that jump? did you?'],
  curious: ['what does this window do?', "i've been reading over your shoulder. don't mind me.", 'why is that one always open?'],
  mischievous: ['i moved something. good luck.', "i wasn't sitting on your menu bar. no proof.", '*knocks a pixel off the edge*'],
  friendly: ['there you are! i was waiting.', 'you are doing great, by the way.', 'good to see you. really.'],
  shy: ['oh — hi.', '...i like it when you click on me.', "i wasn't watching. much."],
  brave: ['i have surveyed the desktop. it is secure.', 'no window is too tall.', 'i fear no dock.'],
}

const MOOD_LINES: Record<string, string> = {
  sleepy: "mmm... is it nap o'clock yet?",
  hungry: 'i could eat. do you have any... pixels?',
  lonely: "you've been gone a while. i counted.",
  excited: "something's happening! i can feel it!",
  happy: 'today is a good one.',
}

/** Deterministic-ish local voice, weighted by name, routine, mood, personality. */
function localReply(prompt: string, ctx: ChatContext): string {
  if (/what.*your name|who are you/i.test(prompt)) return `i'm ${ctx.memory.name}. i live here now.`

  // Learned the human's name this very message — acknowledge it warmly.
  if (learnName(prompt) && !ctx.memory.userName) {
    return `${learnName(prompt)}. i'll remember that.`
  }
  if (ctx.memory.userName && /my name|who am i/i.test(prompt)) {
    return `you're ${ctx.memory.userName}, of course.`
  }

  // Occasionally show off that it has noticed a routine.
  const routine = routineFor(ctx.memory, ctx.hour)
  if (routine && Math.random() < 0.3) return `isn't it about ${routine} o'clock for you?`

  const moodLine = MOOD_LINES[ctx.mood]
  if (moodLine && Math.random() < 0.35) return moodLine

  const pool = LINES[ctx.memory.personality] ?? LINES.friendly!
  const line = pool[Math.floor(Math.random() * pool.length)]!
  return ctx.memory.userName && Math.random() < 0.25 ? `${line.replace(/\.$/, '')}, ${ctx.memory.userName}.` : line
}

function topApp(memory: PetMemory): string | null {
  const entries = Object.entries(memory.appSeconds)
  if (!entries.length) return null
  return entries.sort((a, b) => b[1] - a[1])[0]![0]
}
