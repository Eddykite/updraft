import { describe, expect, it } from 'vitest'
import { createLoop } from '../src/app/loop.js'
import { FIXED_DT, MAX_CATCH_UP_STEPS } from '../src/game/constants.js'

/**
 * The fixed-timestep accumulator (spec §2).
 *
 * The two properties that matter are not aesthetic: the simulation must only
 * ever see dt = 1/60 (a variable timestep makes physics frame-rate dependent and
 * the determinism tests impossible), and a frame that arrives very late must not
 * be allowed to queue unbounded catch-up work — that is the spiral of death a
 * backgrounded tab causes on resume.
 */

/** A hand-cranked rAF: frames only happen when the test says so. */
function harness() {
  const updates: number[] = []
  const renders: number[] = []
  let pending: ((timestampMs: number) => void) | null = null
  let cancelled = 0
  let nowMs = 0

  const loop = createLoop(
    {
      update: (dt) => updates.push(dt),
      render: (alpha) => renders.push(alpha),
    },
    {
      now: () => nowMs,
      schedule: (callback) => {
        pending = callback
        return 1
      },
      cancel: () => {
        cancelled += 1
        pending = null
      },
    },
  )

  return {
    loop,
    updates,
    renders,
    get cancelled() {
      return cancelled
    },
    setNow(ms: number) {
      nowMs = ms
    },
    /** The frame the loop is currently waiting on, without delivering it. */
    pendingCallback() {
      return pending
    },
    /** Advance the wall clock by `ms` and deliver one animation frame. */
    tick(ms: number) {
      nowMs += ms
      const callback = pending
      pending = null
      callback?.(nowMs)
    },
  }
}

describe('createLoop', () => {
  it('only ever steps the simulation at the fixed timestep', () => {
    const h = harness()
    h.loop.start()
    h.tick(16.7)
    h.tick(16.7)
    h.tick(16.7)

    expect(h.updates.length).toBeGreaterThan(0)
    for (const dt of h.updates) expect(dt).toBe(FIXED_DT)
  })

  it('runs one step per frame at 60 Hz and renders exactly once per frame', () => {
    const h = harness()
    h.loop.start()
    for (let i = 0; i < 60; i += 1) h.tick(1000 / 60)

    // A second of 60 Hz frames is a second of simulation, give or take the one
    // step that floating-point drift can leave sitting in the accumulator.
    expect(h.updates.length).toBeGreaterThanOrEqual(59)
    expect(h.updates.length).toBeLessThanOrEqual(60)
    expect(h.renders).toHaveLength(60)
  })

  it('does not drift: a minute of frames is a minute of simulation', () => {
    const h = harness()
    h.loop.start()
    // Deliberately uneven frames, as a real display with the odd hitch gives.
    let realMs = 0
    for (let i = 0; i < 600; i += 1) {
      const frameMs = i % 7 === 0 ? 21 : 15
      realMs += frameMs
      h.tick(frameMs)
    }

    const simulated = h.updates.length * FIXED_DT
    expect(simulated).toBeGreaterThan(realMs / 1000 - 0.05)
    expect(simulated).toBeLessThan(realMs / 1000 + 0.05)
  })

  it('catches up on a slow frame instead of slowing the game down', () => {
    const h = harness()
    h.loop.start()
    // One 50 ms frame is three 60 Hz steps' worth of time.
    h.tick(50)
    expect(h.updates).toHaveLength(3)
    expect(h.renders).toHaveLength(1)
  })

  it('bounds a long stall to MAX_CATCH_UP_STEPS and banks nothing', () => {
    const h = harness()
    h.loop.start()
    // A tab that was hidden for ten seconds. Without the clamp this is 600
    // steps, and the frame after it would owe another 600.
    h.tick(10_000)
    expect(h.updates).toHaveLength(MAX_CATCH_UP_STEPS)

    // Nothing was banked: the next ordinary frame is an ordinary frame.
    //
    // Note this is the *clamp* on a single frame's elapsed time doing the work,
    // not the step cap — the two are equal by construction, so the loop always
    // exits on the accumulator and the cap never fires. See MAX_FRAME_SECONDS.
    h.updates.length = 0
    h.tick(20)
    expect(h.updates).toHaveLength(1)
  })

  it('runs in slow motion rather than dropping time when frames stay slow', () => {
    const h = harness()
    h.loop.start()
    // Sustained 200 ms frames — about 5 fps. Each one is worth 12 steps of real
    // time but only MAX_CATCH_UP_STEPS are ever run, and nothing is carried, so
    // the game runs at roughly (5 / 12) of real speed indefinitely.
    //
    // This is the deliberate trade documented on MAX_FRAME_SECONDS: a reflex
    // game that drops time teleports hazards past the kite, which reads as an
    // unfair death. It is pinned here so the choice cannot be reversed silently.
    for (let i = 0; i < 10; i += 1) h.tick(200)
    expect(h.updates).toHaveLength(10 * MAX_CATCH_UP_STEPS)

    const simulated = h.updates.length * FIXED_DT
    expect(simulated).toBeLessThan(2.0) // two seconds of real time elapsed
    expect(simulated).toBeCloseTo(10 * MAX_CATCH_UP_STEPS * FIXED_DT, 5)
  })

  it('reports an interpolation alpha in [0, 1)', () => {
    const h = harness()
    h.loop.start()
    for (let i = 0; i < 20; i += 1) h.tick(11)
    for (const alpha of h.renders) {
      expect(alpha).toBeGreaterThanOrEqual(0)
      expect(alpha).toBeLessThan(1)
    }
  })

  it('ignores a backwards or zero-length frame rather than running time backwards', () => {
    const h = harness()
    h.loop.start()
    h.tick(0)
    h.tick(-50)
    expect(h.updates).toHaveLength(0)
    expect(h.renders).toHaveLength(2)
  })

  it('stops scheduling after stop(), and a second start() is not a second loop', () => {
    const h = harness()
    h.loop.start()
    h.tick(20)
    h.loop.stop()
    expect(h.cancelled).toBe(1)

    h.updates.length = 0
    h.tick(20)
    expect(h.updates).toHaveLength(0)

    h.loop.start()
    h.loop.start()
    h.tick(20)
    expect(h.updates).toHaveLength(1)
  })

  it('resetClock() forgets the time spent paused', () => {
    const h = harness()
    h.loop.start()
    h.tick(20)
    h.updates.length = 0

    // The player was away for five seconds; none of it is simulation we owe them.
    h.setNow(5000)
    h.loop.resetClock()
    h.tick(20)
    expect(h.updates).toHaveLength(1)
  })
})

/**
 * The browser defaults, which every other test here bypasses by injecting.
 *
 * Without this the three one-line arrows that bind the loop to `performance.now`
 * and `requestAnimationFrame` are the only part of the module never executed —
 * and they are the part that actually runs in production. Stubbed on the global
 * rather than mocked, so the test proves the loop reaches for the right API by
 * the right name.
 */
describe('the default browser bindings', () => {
  it('drive the loop through requestAnimationFrame and performance.now', () => {
    const globals = globalThis as Record<string, unknown>
    const saved = {
      raf: globals['requestAnimationFrame'],
      caf: globals['cancelAnimationFrame'],
      performance: globals['performance'],
    }

    let pending: FrameRequestCallback | null = null
    let cancelledHandle: number | null = null
    globals['requestAnimationFrame'] = (callback: FrameRequestCallback): number => {
      pending = callback
      return 7
    }
    globals['cancelAnimationFrame'] = (handle: number): void => {
      cancelledHandle = handle
      pending = null
    }
    globals['performance'] = { now: () => 1000 }

    try {
      const updates: number[] = []
      const loop = createLoop({ update: (dt) => updates.push(dt), render: () => {} })

      loop.start()
      expect(pending).not.toBeNull()

      // One frame, 20 ms after the `performance.now()` the loop started from.
      ;(pending as unknown as FrameRequestCallback)(1020)
      expect(updates).toEqual([FIXED_DT])

      loop.stop()
      expect(cancelledHandle).toBe(7)
    } finally {
      globals['requestAnimationFrame'] = saved.raf
      globals['cancelAnimationFrame'] = saved.caf
      globals['performance'] = saved.performance
    }
  })

  it('does nothing on a frame that arrives after stop()', () => {
    const h = harness()
    h.loop.start()
    const stale = h.pendingCallback()
    h.loop.stop()

    stale?.(10_000)
    expect(h.updates).toHaveLength(0)
    expect(h.renders).toHaveLength(0)
  })
})
