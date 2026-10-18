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

  it('caps catch-up at MAX_CATCH_UP_STEPS and drops the backlog', () => {
    const h = harness()
    h.loop.start()
    // A tab that was hidden for ten seconds. Without the cap this is 600 steps,
    // and the frame after it would owe another 600.
    h.tick(10_000)
    expect(h.updates).toHaveLength(MAX_CATCH_UP_STEPS)

    // The backlog is gone: the next ordinary frame is an ordinary frame.
    h.updates.length = 0
    h.tick(20)
    expect(h.updates).toHaveLength(1)
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
