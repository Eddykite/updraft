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

  it('gates and thermals', () => {
    expect(C.GATE_WIDTH).toBe(70)
    expect(C.GAP_Y_MIN).toBe(80)
    expect(C.GAP_Y_MAX_EDGE).toBe(870)
    expect(C.THERMAL_RADIUS).toBe(22)
    expect(C.THERMAL_EDGE_INSET).toBe(45)
    expect(C.FIRST_GATE_DELAY).toBe(1.2)
  })

  it('difficulty endpoints: speed 180->420, gap 260->150, interval 1.6->0.9', () => {
    expect(C.DIFFICULTY_RAMP_SECONDS).toBe(90)
    expect(C.SPEED_BASE).toBe(180)
    expect(C.SPEED_BASE + C.SPEED_RANGE).toBe(420)
    expect(C.GAP_BASE).toBe(260)
    expect(C.GAP_BASE - C.GAP_RANGE).toBe(150)
    expect(C.INTERVAL_BASE).toBe(1.6)
    expect(C.INTERVAL_BASE - C.INTERVAL_RANGE).toBeCloseTo(0.9, 10)
  })

  it('reachability headroom and clamps', () => {
    expect(C.REACH_HEADROOM).toBe(0.5)
    expect(C.MAX_CENTRE_DELTA_MIN).toBe(120)
    expect(C.MAX_CENTRE_DELTA_MAX).toBe(420)
  })

  it('scoring and loop', () => {
    expect(C.SCORE_PER_GATE).toBe(10)
    expect(C.SCORE_PER_THERMAL).toBe(5)
    expect(C.STREAK_PER_MULTIPLIER).toBe(2)
    expect(C.MULTIPLIER_CAP).toBe(5)
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
  it('has the frozen signature and is not implemented yet', () => {
    // The simulation task (GOK-3 follow-up) replaces this expectation with the
    // physics, spawner, collision, scoring and determinism suites from spec §3.
    expect(step).toHaveLength(3)
    expect(() =>
      step(createInitialState(1), { holding: false, confirmPressed: false }, C.FIXED_DT),
    ).toThrowError('not implemented')
  })
})
