/* eslint-disable @typescript-eslint/no-unused-vars -- contract stub; remove when implemented */
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

export interface LoopHandle {
  start(): void
  stop(): void
}

export interface LoopCallbacks {
  /** Called 0..MAX_CATCH_UP_STEPS times per frame, always with dt = FIXED_DT. */
  update(dt: number): void
  /** Called once per rendered frame. `alpha` is the interpolation fraction in [0, 1). */
  render(alpha: number): void
}

export function createLoop(callbacks: LoopCallbacks): LoopHandle {
  throw new Error('not implemented')
}
