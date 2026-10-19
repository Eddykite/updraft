import { describe, expect, it } from 'vitest'
import * as C from '../src/game/constants.js'
import {
  createInitialState,
  drainEvents,
  multiplierFor,
  pause,
  resume,
  type GameEvent,
} from '../src/game/state.js'
import { step } from '../src/game/update.js'

/**
 * The frozen contract (GOK-3).
 *
 * The simulation and shell tasks are both written against these values and
 * shapes, in parallel, before either exists. This file is what makes "frozen"
 * mean something: drift in a constant or in the state shape fails CI instead of
 * silently desynchronising two people's work.
 *
 * Game-feel constants ARE expected to be retuned later (spec §8.1) — when that
 * happens, the number changes here too, deliberately and visibly in review.
 */

describe('constants match the signed-off spec §2 table', () => {
  it('field and kite', () => {
    expect(C.FIELD_WIDTH).toBe(540)
    expect(C.FIELD_HEIGHT).toBe(960)
    expect(C.KITE_X).toBe(150)
    expect(C.KITE_RADIUS).toBe(16)
  })

  it('vertical motion', () => {
    expect(C.GRAVITY).toBe(1500)
    expect(C.LIFT_ACCEL).toBe(-2900)
    // The net upward acceleration the reachability maths depends on.
    expect(C.NET_LIFT_ACCEL).toBe(1400)
    expect(C.VY_CLAMP).toBe(560)
    expect(C.CEILING_Y).toBe(30)
    expect(C.GROUND_Y).toBe(930)
  })

  it('gates', () => {
    expect(C.GATE_WIDTH).toBe(70)
    expect(C.GAP_Y_MIN).toBe(80)
    expect(C.GAP_Y_MAX_EDGE).toBe(870)
    expect(C.FIRST_GATE_DELAY).toBe(1.2)
    // 540 + THERMAL_LEAD: the ring rides ahead of its column, so a gate is
    // created far enough off-screen that the ring enters from off-screen too.
    expect(C.GATE_SPAWN_X).toBe(604)
  })

  it('thermals sit outside the gap and lead their column (spec v2 §2.2)', () => {
    expect(C.THERMAL_RADIUS).toBe(22)
    expect(C.THERMAL_LEAD).toBe(64)
    // The ring's disc clears each column by 7 px of horizontal daylight.
    expect(C.THERMAL_LEAD - C.THERMAL_RADIUS - C.GATE_WIDTH / 2).toBe(7)
    // E(t) = 22 + 54(1 - p)^2: 76 px at t = 0, 22 px from t = 90 s on.
    expect(C.THERMAL_OUTSET_FLOOR).toBe(22)
    expect(C.THERMAL_OUTSET_FLOOR + C.THERMAL_OUTSET_RANGE).toBe(76)
    // The floor IS the radius. That equivalence is the replacement invariant.
    expect(C.THERMAL_OUTSET_FLOOR).toBe(C.THERMAL_RADIUS)
    expect(C.THERMAL_FIELD_MARGIN).toBe(20)
    expect(C.THERMAL_Y_MIN).toBe(72)
    expect(C.THERMAL_Y_MAX).toBe(872)
  })

  it('difficulty endpoints: speed 180->420->560, gap 260->150->110, interval 1.6->0.9->0.68', () => {
    expect(C.DIFFICULTY_RAMP_SECONDS).toBe(90)
    expect(C.SECOND_RAMP_HALF_LIFE).toBe(60)
    expect(C.SPEED_BASE).toBe(180)
    expect(C.SPEED_BASE + C.SPEED_RANGE).toBe(420)
    expect(C.SPEED_LIMIT).toBe(560)
    expect(C.GAP_BASE).toBe(260)
    expect(C.GAP_BASE - C.GAP_RANGE).toBe(150)
    expect(C.GAP_FLOOR).toBe(110)
    expect(C.INTERVAL_BASE).toBe(1.6)
    expect(C.INTERVAL_BASE - C.INTERVAL_RANGE).toBeCloseTo(0.9, 10)
    expect(C.INTERVAL_FLOOR).toBeCloseTo(0.68, 10)
    // The speed ceiling is also exactly the kite's own vertical clamp: the world
    // never comes at you faster than you can climb.
    expect(C.SPEED_LIMIT).toBe(C.VY_CLAMP)
  })

  it('reachability headroom and clamps', () => {
    expect(C.REACH_HEADROOM).toBe(0.5)
    // 60, not v1's 120 — at 120 the guard starts overriding the formula below
    // T = 0.828 s, which the v2 interval floor of 0.68 s reaches.
    expect(C.MAX_CENTRE_DELTA_MIN).toBe(60)
    expect(C.MAX_CENTRE_DELTA_MAX).toBe(420)
    expect(C.THERMAL_TOWARD_DELTA).toBe(30)
  })

  it('scoring and loop', () => {
    expect(C.SCORE_PER_GATE).toBe(10)
    expect(C.SCORE_PER_THERMAL).toBe(5)
    expect(C.STREAK_PER_MULTIPLIER).toBe(2)
    expect(C.MULTIPLIER_CAP).toBe(5)
    expect(C.STREAK_MAX).toBe(8)
    // A miss costs exactly one multiplier step, and two rings to earn it back.
    expect(C.STREAK_MISS_PENALTY).toBe(C.STREAK_PER_MULTIPLIER)
    // STREAK_MAX is exactly the streak that reaches the cap — no dead ladder.
    expect(multiplierFor(C.STREAK_MAX)).toBe(C.MULTIPLIER_CAP)
    expect(multiplierFor(C.STREAK_MAX - 1)).toBeLessThan(C.MULTIPLIER_CAP)
    expect(C.FIXED_DT).toBeCloseTo(1 / 60, 12)
    expect(C.MAX_CATCH_UP_STEPS).toBe(5)
  })
})

describe('multiplierFor', () => {
  it('is 1 + floor(streak / 2), capped at 5', () => {
    expect([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 20].map(multiplierFor)).toEqual([
      1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 5,
    ])
  })
})

describe('createInitialState', () => {
  it('starts at the title screen with a scored-from-zero world', () => {
    const state = createInitialState(1234)
    expect(state.phase).toBe('title')
    expect(state.seed).toBe(1234)
    expect(state.tick).toBe(0)
    expect(state.elapsed).toBe(0)
    expect(state.kite).toEqual({ y: C.FIELD_HEIGHT / 2, vy: 0 })
    expect(state.gates).toEqual([])
    expect(state.nextGateId).toBe(0)
    // The player always gets a free moment before the first gate.
    expect(state.spawnTimer).toBe(C.FIRST_GATE_DELAY)
    expect(state.distance).toBe(0)
    expect(state.score).toBe(0)
    expect(state.streak).toBe(0)
    expect(state.multiplier).toBe(1)
    expect(state.crashCause).toBeNull()
    expect(state.events).toEqual([])
  })

  it('is deterministic in the seed, and different seeds differ', () => {
    expect(createInitialState(7)).toEqual(createInitialState(7))
    expect(createInitialState(7).rng).not.toEqual(createInitialState(8).rng)
  })
})

describe('event channel and pause helpers', () => {
  it('drainEvents returns the queue and empties it without mutating the input', () => {
    const base = createInitialState(1)
    const events: GameEvent[] = [{ type: 'run_started' }]
    const withEvents = { ...base, events }
    const [drained, taken] = drainEvents(withEvents)
    expect(taken).toEqual(events)
    expect(drained.events).toEqual([])
    expect(withEvents.events).toEqual(events)
  })

  it('pause/resume only move between playing and paused', () => {
    const title = createInitialState(1)
    expect(pause(title).phase).toBe('title')
    const playing = { ...title, phase: 'playing' as const }
    expect(pause(playing).phase).toBe('paused')
    expect(resume(pause(playing)).phase).toBe('playing')
    expect(resume(playing).phase).toBe('playing')
  })
})

describe('step', () => {
  it('still has the frozen signature', () => {
    expect(step).toHaveLength(3)
  })

  it('is implemented, and leaves the title screen alone until something is pressed', () => {
    // The full simulation suites live in physics / spawner / collision /
    // scoring / determinism / soak. This is only the shell-facing contract:
    // step is callable, total, and does not start a run by itself.
    const title = createInitialState(1)
    const stepped = step(title, { holding: false, confirmPressed: false }, C.FIXED_DT)
    expect(stepped).toBe(title)
  })

  it('starts a run on confirm and reports it through the event channel', () => {
    const started = step(
      createInitialState(1),
      { holding: false, confirmPressed: true },
      C.FIXED_DT,
    )
    expect(started.phase).toBe('playing')
    expect(started.events).toEqual([{ type: 'run_started' }])
  })
})
