/**
 * Fixed-timestep accumulator: separates update from render (spec §2).
 *
 * Run the simulation at exactly 60 Hz (FIXED_DT), stepping while the accumulator
 * allows and at most MAX_CATCH_UP_STEPS times per rendered frame. A variable
 * timestep would make physics frame-rate dependent — the same input giving
 * different results on a 144 Hz monitor and a throttled phone — and would make
 * the determinism tests impossible. The cap prevents a spiral of death when a
 * backgrounded tab resumes; the game also pauses on visibilitychange.
 *
 * This is where wall-clock time enters the program. It never reaches the
 * simulation: the loop converts elapsed real time into a whole number of fixed
 * steps and passes dt = FIXED_DT.
 */

import { FIXED_DT, MAX_CATCH_UP_STEPS } from '../game/constants.js'

export interface LoopHandle {
  start(): void
  stop(): void
  /**
   * Forget the time since the last frame.
   *
   * Called when resuming from a pause: the player was away for however long, and
   * none of that time is simulation the game owes them.
   */
  resetClock(): void
}

export interface LoopCallbacks {
  /** Called 0..MAX_CATCH_UP_STEPS times per frame, always with dt = FIXED_DT. */
  update(dt: number): void
  /** Called once per rendered frame. `alpha` is the interpolation fraction in [0, 1). */
  render(alpha: number): void
}

/** Seams for the unit test; production uses rAF and the monotonic clock. */
export interface LoopOptions {
  now?: () => number
  schedule?: (callback: (timestampMs: number) => void) => number
  cancel?: (handle: number) => void
}

/**
 * The largest real interval a single frame is allowed to represent.
 *
 * This is the load-bearing safeguard, and it is worth being precise about why,
 * because the two mechanisms here are easy to mistake for independent.
 *
 * Because this equals the catch-up budget exactly, the clamp alone guarantees
 * the step loop terminates on the accumulator: entering a frame the carried
 * accumulator is always < FIXED_DT, so it can never exceed
 * FIXED_DT + MAX_CATCH_UP_STEPS * FIXED_DT, and at most MAX_CATCH_UP_STEPS
 * steps are ever owed. The `steps < MAX_CATCH_UP_STEPS` guard below is
 * therefore a structural bound that never fires today — it is kept so that
 * raising this constant can never turn into an unbounded loop, not because it
 * does any work.
 *
 * The consequence worth being deliberate about: a device that *sustains* frames
 * longer than this runs the game in slow motion rather than dropping time. That
 * is the intended trade for a reflex game — dropping time teleports hazards
 * past the kite, which reads as an unfair death — and at under 12 fps the game
 * is unplayable either way. tests/loop.test.ts pins both behaviours.
 */
const MAX_FRAME_SECONDS = MAX_CATCH_UP_STEPS * FIXED_DT

export function createLoop(callbacks: LoopCallbacks, options: LoopOptions = {}): LoopHandle {
  const now = options.now ?? (() => performance.now())
  const schedule = options.schedule ?? ((callback) => requestAnimationFrame(callback))
  const cancel = options.cancel ?? ((handle: number) => cancelAnimationFrame(handle))

  let running = false
  let frameHandle: number | null = null
  let previousMs = 0
  let accumulator = 0

  function frame(timestampMs: number): void {
    if (!running) return
    frameHandle = schedule(frame)

    const elapsed = Math.min((timestampMs - previousMs) / 1000, MAX_FRAME_SECONDS)
    previousMs = timestampMs
    // A backwards or absurd timestamp is a clock problem, not simulation time.
    accumulator += elapsed > 0 ? elapsed : 0

    let steps = 0
    while (accumulator >= FIXED_DT && steps < MAX_CATCH_UP_STEPS) {
      callbacks.update(FIXED_DT)
      accumulator -= FIXED_DT
      steps += 1
    }

    // Unreachable while MAX_FRAME_SECONDS equals the catch-up budget (see the
    // note there). Kept as the backstop that makes raising either constant safe:
    // if the cap ever does bite, drop the backlog rather than carry it into the
    // next frame, which is exactly how a spiral of death starts.
    /* v8 ignore next -- structurally unreachable; see MAX_FRAME_SECONDS */
    if (accumulator >= FIXED_DT) accumulator = 0

    callbacks.render(accumulator / FIXED_DT)
  }

  return {
    start(): void {
      if (running) return
      running = true
      previousMs = now()
      accumulator = 0
      frameHandle = schedule(frame)
    },

    stop(): void {
      running = false
      if (frameHandle !== null) cancel(frameHandle)
      frameHandle = null
    },

    resetClock(): void {
      previousMs = now()
      accumulator = 0
    },
  }
}
