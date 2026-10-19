import { describe, expect, it } from 'vitest'
import {
  FIXED_DT,
  GATE_WIDTH,
  KITE_RADIUS,
  KITE_X,
  MULTIPLIER_CAP,
  SCORE_PER_GATE,
  SCORE_PER_THERMAL,
  STREAK_MAX,
  THERMAL_LEAD,
  STREAK_MISS_PENALTY,
  THERMAL_RADIUS,
} from '../src/game/constants.js'
import { gateAward, thermalAward } from '../src/game/scoring.js'
import { createInitialState, multiplierFor, type Gate, type GameState } from '../src/game/state.js'
import { step } from '../src/game/update.js'

/**
 * Scoring (spec §3): streak increments, reset on a miss, the 5× cap, and the
 * arithmetic — both as pure functions and as it actually comes out of step().
 */

const RELEASED = { holding: false, confirmPressed: false } as const

/**
 * A zero-length step. The scoring rules are evaluated against exactly the
 * geometry the test sets up — no scroll and no integration in between — so the
 * one-pixel boundary cases below are exact rather than nearly exact. Scoring
 * under real motion is covered by the golden replay and the soak test.
 */
const STILL = 0

/**
 * Gate x at which the kite is exactly level with the ring.
 *
 * The ring leads its column by THERMAL_LEAD, so this is 29 px *ahead* of the
 * gate rather than on its centre line — in v1 it was `KITE_X - GATE_WIDTH / 2`.
 * At this x the columns are still 13 px clear of the kite's rim, which is the
 * geometry that makes collecting a detour you then have to pay for.
 */
const ON_THE_RING = KITE_X + THERMAL_LEAD - GATE_WIDTH / 2

/** A gate placed so that its thermal is exactly on the kite, about to be passed. */
function gateAt(x: number, overrides: Partial<Gate> = {}): Gate {
  return {
    id: 0,
    x,
    gapY: 300,
    gapHeight: 300,
    thermal: { y: 450, radius: THERMAL_RADIUS, collected: false },
    passed: false,
    ...overrides,
  }
}

/** The gate under test. Indexing is checked, so this keeps the assertions readable. */
function onlyGate(state: GameState): Gate {
  const gate = state.gates.at(0)
  if (gate === undefined) throw new Error('expected the scenario to still have its gate')
  return gate
}

/** A playing state with the kite parked, no spawns due, and the given gates. */
function playing(gates: readonly Gate[], overrides: Partial<GameState> = {}): GameState {
  return {
    ...createInitialState(1),
    phase: 'playing',
    kite: { y: 450, vy: 0 },
    // Far enough away that nothing spawns during these short scenarios.
    spawnTimer: 1_000,
    gates,
    nextGateId: gates.length,
    ...overrides,
  }
}

describe('award arithmetic', () => {
  it('pays 10 and 5 per multiplier step', () => {
    expect(gateAward(1)).toBe(SCORE_PER_GATE)
    expect(thermalAward(1)).toBe(SCORE_PER_THERMAL)
    expect([1, 2, 3, 4, 5].map(gateAward)).toEqual([10, 20, 30, 40, 50])
    expect([1, 2, 3, 4, 5].map(thermalAward)).toEqual([5, 10, 15, 20, 25])
  })

  it('a gate is always worth twice its thermal', () => {
    for (let m = 1; m <= MULTIPLIER_CAP; m += 1) expect(gateAward(m)).toBe(2 * thermalAward(m))
  })
})

describe('multiplier ladder', () => {
  it('steps up every second thermal and caps at 5x', () => {
    const ladder = Array.from({ length: 12 }, (_, streak) => multiplierFor(streak))
    expect(ladder).toEqual([1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 5, 5])
  })
})

describe('collecting a thermal', () => {
  it('scores at the multiplier you had going in, then steps the streak up', () => {
    // streak 1 -> 2 is the step that takes the multiplier from 1x to 2x.
    const before = playing([gateAt(ON_THE_RING)], { streak: 1, multiplier: 1 })
    const after = step(before, RELEASED, STILL)

    expect(after.score).toBe(5) // paid at 1x, not at the 2x it just earned
    expect(after.streak).toBe(2)
    expect(after.multiplier).toBe(2)
    expect(onlyGate(after).thermal.collected).toBe(true)
    expect(after.events).toEqual([
      { type: 'thermal_collected', gateId: 0, points: 5 },
      { type: 'multiplier_up', multiplier: 2 },
    ])
  })

  it('does not announce a multiplier step on the thermals between steps', () => {
    const before = playing([gateAt(ON_THE_RING)], { streak: 0, multiplier: 1 })
    const after = step(before, RELEASED, STILL)
    expect(after.multiplier).toBe(1)
    expect(after.events).toEqual([{ type: 'thermal_collected', gateId: 0, points: 5 }])
  })

  it('collects each thermal exactly once', () => {
    let state = playing([gateAt(ON_THE_RING)])
    state = step(state, RELEASED, STILL)
    const afterFirst = state.score
    state = step({ ...state, events: [] }, RELEASED, STILL)
    expect(state.score).toBe(afterFirst)
    expect(state.streak).toBe(1)
    expect(state.events).toEqual([])
  })

  it('stops paying more at the cap', () => {
    const before = playing([gateAt(ON_THE_RING)], { streak: 20, multiplier: 5 })
    const after = step(before, RELEASED, STILL)
    expect(after.multiplier).toBe(MULTIPLIER_CAP)
    expect(after.score).toBe(25)
    expect(after.events).toEqual([{ type: 'thermal_collected', gateId: 0, points: 25 }])
  })
})

describe('passing a gate', () => {
  /** x at which the gate's trailing edge is one pixel clear of the kite. */
  const CLEARED = KITE_X - KITE_RADIUS - GATE_WIDTH - 1

  it('scores 10 x multiplier once the kite is fully clear', () => {
    const before = playing(
      [gateAt(CLEARED, { thermal: { y: -100, radius: 1, collected: true } })],
      {
        multiplier: 3,
        streak: 4,
      },
    )
    const after = step(before, RELEASED, STILL)
    expect(after.score).toBe(30)
    expect(onlyGate(after).passed).toBe(true)
    expect(after.streak).toBe(4)
    expect(after.events).toEqual([{ type: 'gate_passed', gateId: 0, points: 30 }])
  })

  it('does not score a gate the kite is still level with', () => {
    // One pixel earlier: the trailing edge is exactly on the kite's left rim.
    const before = playing([gateAt(CLEARED + 1, { gapY: 100, gapHeight: 800 })])
    const after = step(before, RELEASED, STILL)
    expect(after.score).toBe(0)
    expect(onlyGate(after).passed).toBe(false)
  })

  it('scores a gate only once', () => {
    let state = playing([gateAt(CLEARED, { thermal: { y: -100, radius: 1, collected: true } })])
    state = step(state, RELEASED, STILL)
    expect(state.score).toBe(10)
    state = step({ ...state, events: [] }, RELEASED, STILL)
    expect(state.score).toBe(10)
    expect(state.events).toEqual([])
  })

  /**
   * The v2 rule, and the test that fails on v1's. A missed ring costs exactly
   * one multiplier step, not the whole ladder — reset-to-zero priced a single
   * cautious decision at about 325 points and so removed the choice at every
   * streak above zero, which is a cliff rather than a decision.
   */
  it('steps the streak down by two when the thermal was missed, rather than resetting it', () => {
    const missed = gateAt(CLEARED, { thermal: { y: -100, radius: 1, collected: false } })
    const before = playing([missed], { streak: 7, multiplier: 4 })
    const after = step(before, RELEASED, STILL)

    // The gate still pays at the multiplier you arrived with; the step lands after.
    expect(after.score).toBe(40)
    expect(after.streak).toBe(7 - STREAK_MISS_PENALTY)
    expect(after.multiplier).toBe(3)
    expect(after.events).toEqual([
      { type: 'gate_passed', gateId: 0, points: 40 },
      { type: 'streak_dropped', gateId: 0, streak: 5 },
    ])
  })

  it('floors the streak at zero rather than going negative', () => {
    const missed = gateAt(CLEARED, { thermal: { y: -100, radius: 1, collected: false } })
    for (const streak of [0, 1, 2]) {
      const after = step(
        playing([missed], { streak, multiplier: multiplierFor(streak) }),
        RELEASED,
        STILL,
      )
      expect(after.streak).toBe(Math.max(0, streak - STREAK_MISS_PENALTY))
      expect(after.multiplier).toBe(multiplierFor(after.streak))
    }
  })

  /**
   * The rule stated as the thing it is actually for: the multiplier is a
   * measurement of how many rings you are taking, not a record of never having
   * missed one. At +1/-2 the streak drifts by `3c - 2` per gate, so it holds
   * above zero only while more than two thirds of the rings are taken.
   */
  it('holds a multiplier above 1x at a 70% collect rate and loses it at 60%', () => {
    /**
     * Fly `gates` gates, collecting the ring on the ones the pattern names.
     *
     * Two steps per collected gate, because a ring is only banked by actually
     * touching it: handing `step` a gate whose thermal is already flagged
     * collected looks like a collect and is not one — it skips the award and
     * the streak increment both.
     */
    const flyPattern = (pattern: readonly boolean[], gates: number): number => {
      let state = playing([], { streak: 0, multiplier: 1 })
      for (let i = 0; i < gates; i += 1) {
        if (pattern[i % pattern.length] === true) {
          state = { ...state, events: [], gates: [gateAt(ON_THE_RING, { id: i })] }
          state = step(state, RELEASED, STILL)
          state = { ...state, events: [], gates: [{ ...onlyGate(state), x: CLEARED }] }
        } else {
          state = { ...state, events: [], gates: [gateAt(CLEARED, { id: i })] }
        }
        state = step(state, RELEASED, STILL)
      }
      return state.multiplier
    }

    // 7 of every 10 — above the two-thirds line, so the streak climbs and the
    // multiplier survives the misses indefinitely.
    expect(
      flyPattern([true, true, true, false, true, true, true, false, true, false], 200),
    ).toBeGreaterThan(1)
    // 6 of every 10 — below it, so it drains to zero however long you fly, and
    // no amount of patience buys a multiplier.
    expect(flyPattern([true, true, false, true, true, false, true, false, true, false], 200)).toBe(
      1,
    )
  })

  it('caps the streak so the ladder has no dead rungs above the 5x cap', () => {
    const taken = gateAt(ON_THE_RING)
    let state = playing([], { streak: 0, multiplier: 1 })
    for (let i = 0; i < 30; i += 1) {
      state = { ...state, events: [], gates: [{ ...taken, id: i }] }
      state = step(state, RELEASED, STILL)
    }
    expect(state.streak).toBe(STREAK_MAX)
    expect(state.multiplier).toBe(MULTIPLIER_CAP)

    // And one miss from the cap costs exactly one step, not a cliff: that is
    // the whole point of capping the streak rather than letting it run away.
    const missed = gateAt(KITE_X - KITE_RADIUS - GATE_WIDTH - 1, {
      id: 99,
      thermal: { y: -100, radius: 1, collected: false },
    })
    const after = step({ ...state, events: [], gates: [missed] }, RELEASED, STILL)
    expect(after.streak).toBe(STREAK_MAX - STREAK_MISS_PENALTY)
    expect(after.multiplier).toBe(MULTIPLIER_CAP - 1)
  })

  it('keeps the streak when the thermal was taken', () => {
    const taken = gateAt(CLEARED, { thermal: { y: -100, radius: 1, collected: true } })
    const after = step(playing([taken], { streak: 7, multiplier: 4 }), RELEASED, STILL)
    expect(after.streak).toBe(7)
    expect(after.multiplier).toBe(4)
  })
})

describe('a whole scoring sequence', () => {
  it('four thermals and four gates compound exactly as the spec table says', () => {
    // Walk the ladder by hand: each gate is collected and then passed.
    let state = playing([])
    let expected = 0
    const expectedPerGate: ReadonlyArray<readonly [number, number]> = [
      // thermal award, gate award — the multiplier going in is 1, 1, 2, 2 and
      // steps up on the thermal of gates 1 and 3 (streak 2 and streak 4).
      [5, 10],
      [5, 20],
      [10, 20],
      [10, 30],
    ]

    for (const [index, [thermalPoints, gatePoints]] of expectedPerGate.entries()) {
      // Collect.
      state = {
        ...state,
        events: [],
        gates: [gateAt(ON_THE_RING, { id: index })],
      }
      state = step(state, RELEASED, STILL)
      expected += thermalPoints
      expect(state.score).toBe(expected)

      // Pass.
      state = {
        ...state,
        events: [],
        gates: [{ ...onlyGate(state), x: KITE_X - KITE_RADIUS - GATE_WIDTH - 1 }],
      }
      state = step(state, RELEASED, STILL)
      expected += gatePoints
      expect(state.score).toBe(expected)
    }

    expect(state.streak).toBe(4)
    expect(state.multiplier).toBe(3)
    expect(state.score).toBe(110)
  })

  it('scores the same way when the world is actually scrolling past', () => {
    // The same gate, approached at the real timestep: it is collected on the way
    // through and banked once its trailing edge clears the kite.
    let state = playing([gateAt(KITE_X + 40, { gapY: 100, gapHeight: 700 })])
    const seen: string[] = []
    for (let tick = 0; tick < 120 && state.phase === 'playing'; tick += 1) {
      state = step({ ...state, events: [] }, RELEASED, FIXED_DT)
      for (const event of state.events) seen.push(event.type)
      // Hold the kite on the thermal's line so this stays a test of scoring
      // rather than of whether a released kite can fly level.
      state = { ...state, kite: { y: 450, vy: 0 } }
    }
    expect(seen).toEqual(['thermal_collected', 'gate_passed'])
    expect(state.score).toBe(5 + 10)
    expect(state.streak).toBe(1)
  })
})
