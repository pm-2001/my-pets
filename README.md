# my-pets

An autonomous animated cat that lives on your macOS desktop. It isn't a widget — it walks
around your screen, stands on top of your application windows, chases your cursor, gets
bored when you ignore it, and falls asleep when you stop typing. Every few seconds it
decides for itself what to do next.

<p align="left">
  <img src="docs/pet-awake.png" alt="The pet, awake and idle" height="150">
  <img src="docs/pet-asleep.png" alt="The pet, asleep, with floating Z" height="150">
</p>

*Awake (tail up, blinking, whiskers) and asleep (flattened, eyes closed, floating Z). The
pet is drawn procedurally in code — there are no image assets.*

---

## Status

**Working end to end on macOS.** You can clone, install, run, and a cat appears on your
desktop and starts living there. Built and verified on macOS 26 (Darwin 25.5), Apple
Silicon, Node 25, Electron 33.

| Area | State |
|---|---|
| Transparent, click-through, always-on-top overlay | ✅ Done |
| Procedural cat: 12 animation states, smooth blending | ✅ Done |
| Utility-AI behaviour engine (needs → mood → action) | ✅ Done |
| 7 personalities, seeded traits + per-pet coat colour | ✅ Done |
| Desktop awareness: stands on / jumps between real windows | ✅ Done |
| Cursor chasing, idle detection, sleep, battery awareness | ✅ Done |
| Long-term memory (personality, favourite apps, chat history) | ✅ Done |
| Speech bubble + conversation | ✅ Done (LLM optional, off by default) |
| Menu-bar tray: size, sleep-on-windows, reset, quit | ✅ Done |
| Zero macOS permission prompts | ✅ Done |
| Multiple pets at once | ❌ Not built — see Roadmap |
| Audio / music reactivity | ❌ Not built — see Roadmap |
| Windows + Linux | ❌ macOS only |

---

## Requirements

- **macOS** (the window layer and the `deskscan` helper are macOS-specific)
- **Node.js 20+** (developed on 25.9)
- **Xcode Command Line Tools** — provides `swiftc`, needed to build the window-scanner
  helper. Install with `xcode-select --install`

## Setup

```bash
git clone git@github.com:pm-2001/my-pets.git
cd my-pets
npm install
npm start
```

`npm start` compiles the Swift helper, generates the tray icon, bundles everything, and
launches the app. A cat appears at the bottom of your screen and a small cat icon appears
in your menu bar. **Quit from the menu-bar icon** — there is no dock icon and no window
to close.

### Scripts

| Command | What it does |
|---|---|
| `npm start` | Full build, then run |
| `npm run dev` | Vite dev server + Electron with hot reload for the renderer |
| `npm run build` | Build everything into `dist/` and `dist-electron/` |
| `npm run typecheck` | `tsc --noEmit` across main, preload and renderer |
| `npm run native` | Rebuild just the Swift helper and the tray icon |

---

## No permission prompts

This was a deliberate design constraint: the app asks for **nothing** on first run — no
Accessibility, no Screen Recording, no input monitoring. Everything it perceives comes
from APIs that macOS grants freely:

| What it senses | How | Permission |
|---|---|---|
| Cursor position | Electron `screen.getCursorScreenPoint()` | none |
| Whether you're active | `powerMonitor.getSystemIdleTime()` | none |
| Window positions and sizes | `CGWindowListCopyWindowInfo` via a small Swift helper | none |
| Battery level | `pmset -g batt` | none |

The cost of that choice: window **titles** are unavailable (macOS redacts `kCGWindowName`
without Screen Recording), so the pet knows it is standing on "Terminal" but not which
file you have open. It also can't see individual keystrokes — only whether you are active.
Both are acceptable trades for an app that just works when you open it.

---

## Architecture

```
electron/                  main process (Node)
  main.ts                  lifecycle, tray menu, IPC, dev capture hook
  overlay.ts               the transparent always-on-top window
  sensors.ts               perception: cursor, idle, windows, power
  store.ts                 atomic JSON persistence for memory + settings
  chat.ts                  Anthropic API + local personality-driven fallback
  preload.ts               the entire renderer-facing API surface
  native/deskscan.swift    streams window geometry as JSON lines

src/
  shared/types.ts          the contract between the two processes
  world/desktop.ts         the desktop as a platformer level (ledges, occlusion)
  brain/
    personality.ts         traits + seeded per-pet variation, coat palette
    needs.ts               internal drives and mood derivation
    actions.ts             utility AI: scoring, cooldowns, recency, momentum
    pet.ts                 the entity: physics, action execution, animation state
  render/
    cat.ts                 procedural cat geometry + pose-based animation
    stage.ts               render loop, coordinate mapping, hit-testing, throttling
  ui/Bubble.tsx            speech bubble (DOM, not canvas)
  App.tsx                  wiring + long-term memory accumulation
```

### How the behaviour works

Nothing is scripted. Three layers feed each other:

1. **Needs** (`needs.ts`) — `sleepiness`, `boredom`, `curiosity`, `loneliness`,
   `excitement`, each 0–100, drifting continuously. Personality sets the rates: a lazy
   pet's sleepiness climbs four times faster than an energetic one's.

2. **Actions** (`actions.ts`) — each of the 13 actions scores itself against the current
   needs, and the highest score wins. There is no state machine saying which action may
   follow which.

3. **Execution** (`pet.ts`) — the winning action becomes velocity and an animation state,
   then gravity and surface collision are applied.

A naive "highest score wins" loop oscillates between two actions and reads as *more*
robotic than a script, so four mechanisms guard against it: per-action **cooldowns**, a
sliding **recency penalty**, **momentum** (the running action gets a bonus until its
minimum duration elapses), and score-scaled **noise**.

### The desktop as a platformer

`desktop.ts` treats every on-screen window's top edge as a standable ledge, with the
bottom of the work area as the floor. Occlusion is handled properly — a ledge belonging to
a buried window is not standable where another window covers it, so the pet never appears
to stand on thin air in front of whatever is actually on top. Stage Manager's strip
thumbnails are filtered out in the Swift helper, since they are real layer-0 windows that
would otherwise become fake platforms.

### Conversation

Off by default. With **AI conversation** ticked in the tray menu, clicking the pet opens a
speech bubble backed by the Anthropic API (`claude-opus-5`, thinking disabled and effort
`low` for latency, server-side refusal fallbacks enabled). It picks up credentials the
standard way — `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, or an `ant auth login`
profile. No key is ever stored by this app.

With it off — or if no credentials are found, or the API errors — the pet falls back to a
local personality-driven voice that responds instantly. That fallback is the default on
purpose: a pet that always says something charming immediately beats one that waits two
seconds for a network round trip.

---

## Performance

Measured on this machine (Apple Silicon, 120Hz display) as CPU-time deltas over 60-second
windows. **Percentages are of one core**, which is how `top` and `ps` report on macOS — so
8% of one core is roughly 1% of an 8-core machine.

| State | CPU (of one core) |
|---|---|
| Pet asleep, machine idle | ~8% |
| Pet sitting, user present | ~8% |
| Swift `deskscan` helper | ~0.0% (2.8 MB RSS) |
| Main process | ~0.3% |
| Memory, all processes | ~310 MB RSS |

Optimisations already applied, in order of what they were worth:

- **Split the IPC channels.** Window layout, displays and power go on a slow channel that
  only fires on change; only the cursor and idle time go at tick rate. Previously the full
  window list was re-serialised 30 times a second. Main process: 3.5% → 0.3%.
- **Adaptive cursor polling.** 30Hz only while the mouse is actually moving; 10Hz when
  parked, 4Hz when you're away, snapping back instantly on movement.
- **Shrank the canvas.** The overlay window is fullscreen so the pet can walk anywhere, but
  the canvas is a 320×300 viewport moved with a compositor-only transform. GPU memory:
  301 MB → 78 MB.
- **Frame-rate throttling by motion, not by action.** The pet spends most of its life in
  static poses where only breathing and blinking move; those run at 8–12fps and only
  actual movement gets 24–30.
- **Replaced Pixi's ticker.** Its `maxFPS` throttles the *update* but still requests an
  animation frame every display refresh — 120 wakeups/sec on a ProMotion panel regardless
  of the animation rate. The loop is now a timer plus one vsync-aligned rAF per frame.

### The remaining ~8%, and why

Profiling bisected this to something no amount of tuning in this codebase fixes: **a live
WebGL context inside a transparent Electron window has a large frame-rate-independent
cost.** A bare window with a Pixi canvas rendering *twice per second* and nothing else
costs 5.1% of a core — essentially the same as the entire finished app. Confirmed by
elimination:

| Test | Renderer | GPU |
|---|---|---|
| Empty transparent fullscreen window, no canvas | 0.0% | 0.0% |
| Same window + Pixi/WebGL canvas @ **2fps** | 3.3% | 1.8% |
| Same window + Canvas2D @ **12fps** | 2.0% | 3.1% |

So Canvas2D draws roughly 6× cheaper per frame, but a per-frame compositing cost remains
that appears to scale with the size of the transparent window being recomposited.

Two known ways forward, neither implemented:

1. **Drop Pixi for Canvas2D.** The pose-based animation system carries over directly; only
   `cat.ts` geometry needs rewriting from Pixi `Graphics` to `ctx` paths. Expect a few
   points of CPU back.
2. **Use a small window that moves, instead of a fullscreen overlay.** This is what Shimeji
   and Desktop Goose do, and it should remove most of the compositing cost. The trade is
   jitter — macOS window moves aren't synced to content updates — plus extra work for the
   speech bubble and hit-testing.

The honest summary: ~8% of one core is fine for occasional use and noticeable on battery
over a full day. Fixing it properly means option 2.

---

## Dev tooling

A transparent always-on-top window can't be inspected with a normal screenshot, so there
are two env-gated hooks:

```bash
# Per-frame stats (actual fps vs the cap, current action, idle time, window count)
PET_DEBUG=1 npx electron .

# Capture the window's own output — alpha included, no Screen Recording permission needed
PET_CAPTURE=/tmp/pet.png PET_CAPTURE_DELAY=6 PET_CAPTURE_QUIT=1 npx electron .
```

Pet state lives in `~/Library/Application Support/desktop-pet/` (`memory.json`,
`settings.json`). Delete them, or use **Forget everything…** in the tray menu, to be born
as a new pet with a different personality and coat.

---

## Known limitations

- **macOS only.** The overlay flags, `CGWindowList` and the Swift helper are all
  platform-specific. Windows would need `EnumWindows` + layered windows; Linux works on
  X11 but is largely impossible on GNOME Wayland, which forbids absolute window
  positioning and window enumeration.
- **Multi-monitor is single-display today.** The overlay attaches to the primary display.
  The geometry model is already in global screen coordinates, so extending it is mostly a
  matter of one overlay window per display plus edge hand-off.
- **Window titles are unavailable** by design — see the permissions section.
- **Fullscreen apps hide the pet.** The window sits at `screen-saver` level with
  `visibleOnFullScreen`, which covers most cases, but true exclusive-fullscreen apps will
  cover it.
- **Not code-signed.** Running a distributable build on another Mac would need signing and
  notarisation; running from source as documented here does not.
- **~8% of one core.** See Performance above.

---

## Roadmap

Roughly in order of value per unit effort:

1. **Canvas2D renderer** to reclaim CPU (see Performance).
2. **Multiple pets.** The `Pet` class is already fully self-contained — one instance per
   pet, each with its own seed, needs and memory. The work is pet-to-pet awareness
   (following, playing, sleeping in a pile) and one shared render loop.
3. **Multi-monitor** — one overlay per display, hand off at screen edges.
4. **Audio reactivity.** macOS has no native loopback; needs ScreenCaptureKit audio
   (Screen Recording permission) or a virtual device like BlackHole. Would break the
   zero-permissions property, so it should be strictly opt-in.
5. **Richer memory** — daily routine detection ("you always open Slack at 9"), pet
   remembering your name from conversation.
6. **Sprite-sheet support.** `cat.ts` sits behind a clean interface; a sprite renderer
   could be swapped in without touching the behaviour engine.

---

## Licence

Unlicensed / private project.
