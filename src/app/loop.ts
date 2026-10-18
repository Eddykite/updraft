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
 * MAX_CATCH_UP_STEPS already bounds the work per frame; this bounds how much
 * time a stalled frame can *bank* for the frames after it, so a one-second hitch
 * cannot leave the game running fast for the next second trying to repay it.
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

    // Hit the cap with time still owed: drop the backlog rather than carry it
    // into the next frame, which is exactly how a spiral of death starts.
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
