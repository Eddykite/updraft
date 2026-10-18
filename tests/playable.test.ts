import { describe, expect, it } from 'vitest'
import { latencyFrames, playRun, type PlayerProfile } from '../tools/feel/autopilot.js'
import { opportunistKnee, sampleCourse, searchForRiskyPlacement } from '../tools/feel/geometry.js'
import {
  CEILING_Y,
  DIFFICULTY_RAMP_SECONDS,
  FIXED_DT,
  GAP_Y_MIN,
  KITE_RADIUS,
  THERMAL_EDGE_INSET,
  THERMAL_RADIUS,
} from '../src/game/constants.js'
import { gapHeight } from '../src/game/difficulty.js'
import { DEFAULT_SEED as E2E_SEED, SCORING_TAPE } from '../e2e/game.js'
import { createInitialState } from '../src/game/state.js'
import { step } from '../src/game/update.js'

/**
 * Is the game actually playable, and is it playable the way the spec says?
 *
 * The browser suite proves the plumbing works; it cannot prove the game is
 * winnable without depending on wall-clock timing, which is why the e2e test
 * that used to claim "holding keeps the kite alive past 3 s" was both wrong and
 * fragile. These assertions are deterministic: same seeds, same answer, every
 * run, on every machine.
 *
 * The model player lives in tools/feel/ because its main job is the tuning
 * report. Here it earns its keep a second time as a regression guard: if a
 * future tuning change makes the course unflyable, this goes red.
 */

const FRAME_PERFECT: PlayerProfile = {
  strategy: 'collector',
  latency: 0,
  deadZone: 0,
  unanticipatedFrames: 0,
  aimJitter: 0,
  perception: 0,
  riskTolerance: 0,
}

const SEEDS = [20261018, 1234, 7, 999_983, 42]

describe('the course is flyable', () => {
  it.each(SEEDS)('a frame-perfect player survives 120 s on seed %i', (seed) => {
    const result = playRun(seed, FRAME_PERFECT, 120)
    expect(result.crashCause).toBeNull()
    expect(result.duration).toBeGreaterThanOrEqual(120)
  })

  it('and scores on the way — a run is not just survival', () => {
    const result = playRun(20261018, FRAME_PERFECT, 120)
    expect(result.gatesPassed).toBeGreaterThan(50)
    expect(result.peakMultiplier).toBe(5)
  })
})

describe('the ceiling', () => {
  /**
   * The concept doc promises the ceiling is a soft clamp, not a kill. It is —
   * but pinning the kite there is still fatal at the first gate, because a gap's
   * top edge can never be above GAP_Y_MIN. Both halves are pinned here so that
   * neither can quietly change: the ceiling must stay survivable, and holding
   * forever must stay a losing strategy.
   */
  it('cannot fit through any gate, so holding forever is never a winning strategy', () => {
    expect(GAP_Y_MIN).toBeGreaterThan(CEILING_Y - KITE_RADIUS)
  })

  it('is survivable on its own: a held climb is still alive at 1.5 s', () => {
    let state = step(
      createInitialState(20261018),
      { holding: false, confirmPressed: true },
      FIXED_DT,
    )
    while (state.elapsed < 1.5 && state.phase === 'playing') {
      state = step(state, { holding: true, confirmPressed: false }, FIXED_DT)
    }
    expect(state.phase).toBe('playing')
    expect(state.kite.y).toBe(CEILING_Y)
  })

  it('kills a held run only once a gate arrives, at the same moment on every seed', () => {
    const deaths = [1, 2, 3, 4, 5].map((seed) => {
      let state = step(createInitialState(seed), { holding: false, confirmPressed: true }, FIXED_DT)
      while (state.phase === 'playing' && state.elapsed < 30) {
        state = step(state, { holding: true, confirmPressed: false }, FIXED_DT)
      }
      return { cause: state.crashCause, at: Number(state.elapsed.toFixed(2)) }
    })
    expect(deaths.every((d) => d.cause === 'column')).toBe(true)
    expect(new Set(deaths.map((d) => d.at)).size).toBe(1)
  })
})

describe('the risk/reward layer', () => {
  /**
   * The headline finding of feel tuning (GOK-5), pinned as tests so that the day
   * someone changes the mechanic, these fail and tell them it is fixed.
   *
   * Two separate claims, weak and strong:
   */

  /**
   * Weak form. A thermal that must sit strictly inside the gap can always be
   * collected from an altitude that was already safe — for every gap height and
   * every radius, so no retune of the existing constants reaches it.
   */
  it('has no risk in the strong sense: a safe collecting altitude always exists', () => {
    const { tested, risky } = searchForRiskyPlacement()
    expect(tested).toBeGreaterThan(100_000)
    expect(risky).toBe(0)
  })

  /**
   * Strong form, and the one that actually sinks the layer. It is not merely
   * that *some* safe altitude collects — it is that past a point on the ramp the
   * single safest altitude in the gap, its exact centre, collects the ring
   * outright. From there on the reward is not a decision, it is a rebate.
   *
   * The crossover is where the collect reach (THERMAL_RADIUS + KITE_RADIUS)
   * overtakes the ring's offset from the centre (gapHeight/2 - THERMAL_EDGE_INSET).
   */
  it('and none at all once the gap tightens: the centre line collects the ring for free', () => {
    const reach = THERMAL_RADIUS + KITE_RADIUS
    const costAt = (elapsed: number): number =>
      Math.max(0, gapHeight(elapsed) / 2 - THERMAL_EDGE_INSET - reach)

    // Early in a run there is at least some cost...
    expect(costAt(0)).toBeGreaterThan(0)
    // ...and by maximum difficulty there is none.
    expect(costAt(DIFFICULTY_RAMP_SECONDS)).toBe(0)
  })

  /**
   * And the cost that does exist early is small relative to the margin on offer,
   * which is why no profile in the feel report ever meaningfully declines a ring.
   */
  it('and what cost exists early is a minority of the available margin', () => {
    const course = [1, 2, 3, 4, 5].flatMap((seed) => sampleCourse(seed, 180))
    expect(course.length).toBeGreaterThan(100)
    const worst = Math.max(...course.map((g) => g.marginCost / g.clearanceOnCentre))
    expect(worst).toBeLessThan(0.5)
  })
})

describe('the instrument is not measuring itself', () => {
  /**
   * The GOK-14 review found the model player reporting three of its own
   * properties as findings about the game. The repairs are pinned here, because
   * an instrument that quietly goes back to flattering the design is worse than
   * no instrument: it produces confident wrong answers, which is how the
   * thermals question nearly got decided on the wrong evidence.
   */

  /**
   * `thermalsMissed` used to be `gatesPassed - thermalsCollected`, and a ring is
   * collected on contact while its gate only counts as passed on its trailing
   * edge — so a run ending between the two printed a negative miss count and
   * "rings 101% of gates". Counted per gate id now, so the two halves must
   * partition the passed gates exactly.
   */
  it('counts missed rings per gate, so the tally never exceeds the gates', () => {
    const sloppy: PlayerProfile = {
      strategy: 'collector',
      latency: 0.083,
      deadZone: 8,
      unanticipatedFrames: 3,
      aimJitter: 18,
      perception: 28,
      riskTolerance: 0,
    }
    const results = [20261018, 1234, 7, 999_983, 42, 55, 101].map((seed) =>
      playRun(seed, sloppy, 60),
    )
    // The point of the profile: these runs end mid-course, which is the case the
    // old subtraction got wrong.
    expect(results.some((r) => r.crashCause !== null)).toBe(true)
    for (const r of results) {
      expect(r.thermalsMissed).toBeGreaterThanOrEqual(0)
      expect(r.thermalsTakenOnPassedGates + r.thermalsMissed).toBe(r.gatesPassed)
      expect(r.thermalsTakenOnPassedGates).toBeLessThanOrEqual(r.thermalsCollected)
    }
  })

  /**
   * The lead axis is quantised to whole frames of the input queue — it always
   * was, but it used to be expressed as a fraction, which hid the resolution and
   * made two adjacent rows of the sweep the identical controller. Asking for more
   * unpredicted frames than exist clamps, so a profile is portable across
   * latencies and the axis means the same thing at each one.
   */
  it('clamps the lead axis to the frames that exist, rather than silently aliasing', () => {
    const base: PlayerProfile = {
      strategy: 'collector',
      latency: 0.083,
      deadZone: 8,
      unanticipatedFrames: latencyFrames(0.083),
      aimJitter: 10,
      perception: 16,
      riskTolerance: 0,
    }
    const blind = playRun(4242, base, 60)
    const blinder = playRun(4242, { ...base, unanticipatedFrames: 50 }, 60)
    expect(blinder).toEqual(blind)

    // And at zero latency there is exactly one controller: nothing is in flight,
    // so no amount of failing to predict it can change anything.
    const instant = { ...base, latency: 0, unanticipatedFrames: 0 }
    expect(playRun(4242, { ...instant, unanticipatedFrames: 4 }, 60)).toEqual(
      playRun(4242, instant, 60),
    )
  })

  /**
   * The `opportunist` was reported as evidence that a cautious player still takes
   * most rings. It could not have done otherwise: the clearance left by the
   * cheapest collecting line is a constant, so the profile is a step function of
   * its own tolerance. Both sides of the step are pinned — below the knee it is
   * the collector, above it the safe line — so the day someone quotes an
   * opportunist number again, this says what it is worth.
   */
  it('has no tolerance at which declining a ring is a judgement call', () => {
    const knee = opportunistKnee()
    expect(knee.floor).toBeLessThan(knee.ceiling)

    const base: PlayerProfile = {
      strategy: 'opportunist',
      latency: 0,
      deadZone: 0,
      unanticipatedFrames: 0,
      aimJitter: 0,
      perception: 0,
      riskTolerance: knee.floor,
    }
    // At the floor it is not merely similar to the collector, it IS the
    // collector — same run, gate for gate. Above the ceiling it is the safe line.
    const atFloor = playRun(20261018, base, 120)
    expect(atFloor.gatesPassed).toBeGreaterThan(50)
    expect(atFloor).toEqual(playRun(20261018, { ...base, strategy: 'collector' }, 120))

    const aboveCeiling = playRun(20261018, { ...base, riskTolerance: knee.ceiling + 1 }, 120)
    expect(aboveCeiling).toEqual(playRun(20261018, { ...base, strategy: 'safe' }, 120))

    // And the safe line is not abstaining — it takes most of the rings anyway,
    // which is the whole finding.
    expect(aboveCeiling.thermalsMissed).toBeLessThan(aboveCeiling.gatesPassed)
  })
})

describe("the browser suite's input tape", () => {
  /**
   * e2e/game.ts flies an open-loop schedule so the game-over screenshot shows a
   * game someone played rather than a card reading zero. The browser asserts
   * nothing about it — under load it scores nothing, which is exactly why — so
   * without this test the tape could rot into a dead schedule and the only
   * symptom would be quietly worse deploy evidence.
   *
   * Re-derive it by searching schedules against `step()` and keeping the best
   * worst case under a one-sided delay of up to +50 ms per phase — one-sided
   * because a CDP round trip only ever makes a phase longer, never shorter.
   */
  function fly(delayPerPhaseMs: number, rand: () => number): number {
    let state = step(
      createInitialState(E2E_SEED),
      { holding: false, confirmPressed: true },
      FIXED_DT,
    )
    let edge = 0
    const edges = SCORING_TAPE.map((duration) => (edge += duration + delayPerPhaseMs * rand()))
    const total = edges[edges.length - 1] as number

    while (state.phase === 'playing' && state.elapsed * 1000 < total) {
      const ms = state.elapsed * 1000
      let i = 0
      while (i < edges.length && ms >= (edges[i] as number)) i += 1
      state = step(state, { holding: i % 2 === 0, confirmPressed: false }, FIXED_DT)
    }
    return state.score
  }

  /** Deterministic PRNG, so this test has exactly one outcome. */
  function mulberry(seed: number): () => number {
    let a = seed
    return () => {
      a |= 0
      a = (a + 0x6d2b79f5) | 0
      let t = Math.imul(a ^ (a >>> 15), 1 | a)
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296
    }
  }

  it('scores on the seed the browser suite uses, with perfect timing', () => {
    expect(fly(0, () => 0)).toBeGreaterThan(0)
  })

  it('still scores when every phase overruns by up to 50 ms', () => {
    const worst = Math.min(
      ...Array.from({ length: 200 }, (_, i) => fly(50, mulberry(i * 7919 + 1))),
    )
    expect(worst).toBeGreaterThan(0)
  })
})
