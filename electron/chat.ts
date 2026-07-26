import Anthropic from '@anthropic-ai/sdk'
import type { PetMemory, Settings } from '../src/shared/types'

/**
 * The pet's voice.
 *
 * Two backends: an LLM when the user opts in, and a local personality-driven
 * responder otherwise. The local one is not a degraded fallback — a pet that
 * always says something charming instantly beats one that waits two seconds for
 * a network round trip, so it stays the default.
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

export async function chat(prompt: string, ctx: ChatContext): Promise<string> {
  if (!ctx.settings.aiChat) return localReply(prompt, ctx)

  const anthropic = getClient()
  if (!anthropic) return localReply(prompt, ctx)

  const days = Math.max(1, Math.floor((Date.now() - ctx.memory.bornAt) / 86_400_000))
  const favourite = topApp(ctx.memory)

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

/** Deterministic-ish local voice, weighted by mood then personality. */
function localReply(prompt: string, ctx: ChatContext): string {
  const name = /what.*your name|who are you/i.test(prompt)
  if (name) return `i'm ${ctx.memory.name}. i live here now.`

  const moodLine = MOOD_LINES[ctx.mood]
  if (moodLine && Math.random() < 0.4) return moodLine

  const pool = LINES[ctx.memory.personality] ?? LINES.friendly!
  return pool[Math.floor(Math.random() * pool.length)]!
}

function topApp(memory: PetMemory): string | null {
  const entries = Object.entries(memory.appSeconds)
  if (!entries.length) return null
  return entries.sort((a, b) => b[1] - a[1])[0]![0]
}
