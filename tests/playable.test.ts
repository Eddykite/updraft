import { describe, expect, it } from 'vitest'
import { latencyFrames, playRun, type PlayerProfile } from '../tools/feel/autopilot.js'
import {
  centreLineMissAcrossTheRamp,
  sampleCourse,
  searchForFreeCollect,
} from '../tools/feel/geometry.js'
import {
  CEILING_Y,
  FIXED_DT,
  GAP_Y_MIN,
  KITE_RADIUS,
  THERMAL_RADIUS,
} from '../src/game/constants.js'
import { gapHeight, thermalOutset } from '../src/game/difficulty.js'
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

const SAFE_LINE: PlayerProfile = { ...FRAME_PERFECT, strategy: 'safe' }

const SEEDS = [20261018, 1234, 7, 999_983, 42]

describe('the course is flyable', () => {
  it.each(SEEDS)('a frame-perfect collector survives 120 s on seed %i', (seed) => {
    const result = playRun(seed, FRAME_PERFECT, 120)
    expect(result.crashCause).toBeNull()
    expect(result.duration).toBeGreaterThanOrEqual(120)
  })

  /**
   * The second ramp is the half of this task that did not exist before, so the
   * course has to stay flyable *past* where v1 froze it — otherwise the new
   * difficulty curve would be "harder" only in the sense of being impossible.
   */
  it.each(SEEDS)('and is still flyable deep into the second ramp on seed %i', (seed) => {
    const result = playRun(seed, SAFE_LINE, 210)
    expect(result.crashCause).toBeNull()
    expect(result.duration).toBeGreaterThanOrEqual(210)
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

describe('the risk/reward layer, as rebuilt', () => {
  /**
   * The v1 findings that sank the old placement are **closed**, not relaxed, and
   * what replaces them is their mirror. Under v1 these three tests asserted that
   * a safe collecting altitude always exists, that the gap's centre line
   * collects for free once the gap tightens, and that the cost is a minority of
   * the margin. All three are now false of the game, which is the point.
   */

  /**
   * Strong form, mirrored. With the ring's disc outside the gap band there is no
   * surviving altitude that collects — for every gap height, every ring radius
   * and every outset at or above the radius. The inset does not appear in the v1
   * argument, which is why no retune reached it; the outset *is* the argument
   * here, which is why this one holds by construction.
   */
  it('has real risk: no surviving altitude collects, at any gap or radius', () => {
    const { tested, free, tightest } = searchForFreeCollect()
    expect(tested).toBeGreaterThan(100_000)
    expect(free).toBe(0)
    // The tightest case in the sweep is a touch, not an overlap: it is the
    // E = THERMAL_RADIUS boundary, where collecting puts the kite exactly on the
    // edge of the safe corridor.
    expect(tightest).toBe(0)
  })

  /**
   * The direct regression test for the v1 defect, and the one that would have
   * caught it. Under v1 the crossover was at t = 77 s and everything after it
   * collected the ring from the single safest altitude in the game.
   */
  it('and the gap centre line never collects, at any point on either ramp', () => {
    const reach = THERMAL_RADIUS + KITE_RADIUS
    const missAt = (elapsed: number): number =>
      gapHeight(elapsed) / 2 + thermalOutset(elapsed) - reach

    for (const t of [0, 30, 60, 77, 90, 150, 240, 600, 3600]) {
      expect(missAt(t)).toBeGreaterThan(0)
    }
    // It is tightest at the asymptote, not at t = 0 — the opposite of v1, where
    // the margin fell to zero as the gap closed.
    expect(missAt(3600)).toBeLessThan(missAt(0))
    expect(missAt(3600)).toBeGreaterThan(16)
    expect(centreLineMissAcrossTheRamp()).toContain('never comes within')
  })

  /**
   * And the excursion is a majority of the margin, not a minority of it. The v1
   * version of this test asserted `< 0.5` and was the evidence that no profile
   * ever meaningfully declined a ring.
   */
  it('and every gate a real course produces leaves the safe corridor to collect', () => {
    const course = [1, 2, 3, 4, 5].flatMap((seed) => sampleCourse(seed, 240))
    expect(course.length).toBeGreaterThan(500)
    for (const gate of course) {
      // The ring is strictly outside the safe band on every gate...
      expect(gate.exposure).toBeGreaterThan(0)
      // ...and no altitude that survives the gate also collects.
      // Zero in exact arithmetic; at the E = THERMAL_RADIUS floor the two
      // bands share an endpoint, so the subtraction leaves float dust.
      expect(gate.freeCollect).toBeLessThan(1e-9)
      expect(gate.centreLineMiss).toBeGreaterThan(0)
      // The static excursion is never negative: that is the invariant.
      expect(gate.excursion).toBeGreaterThanOrEqual(0)
    }

    /**
     * And the one thing the static geometry does *not* settle, made explicit.
     *
     * `excursion` — how far outside the safe band the shallowest collecting
     * altitude sits — equals `E - THERMAL_RADIUS`. It is positive while the
     * outset is above its floor and **exactly zero from t = 90 s onward**. That
     * is the invariant being tight rather than a hole in it: at the floor the
     * shallowest collecting altitude is precisely the edge of the corridor.
     *
     * It is also why cost.ts has to exist. From t = 90 s the ring costs nothing
     * to *touch* and a great deal to touch *and survive*, because the columns
     * arrive 29 px later and the kite cannot be at the band edge and back inside
     * it at the same time. The dynamic cost at t = 90 s is 27 px against a
     * static excursion of 0, and a reader who stopped at this test would draw
     * exactly the wrong conclusion.
     */
    const early = course.filter((g) => g.elapsed < 60)
    const late = course.filter((g) => g.elapsed > 120)
    expect(early.length).toBeGreaterThan(0)
    expect(late.length).toBeGreaterThan(0)
    expect(Math.min(...early.map((g) => g.excursion))).toBeGreaterThan(0)
    expect(Math.max(...late.map((g) => g.excursion))).toBeLessThan(1e-9)
  })

  /**
   * The payoff, measured rather than asserted. No score constant moved in v2;
   * what changed is that the safe line now collects nothing, so its multiplier
   * is stuck at 1 while a collector reaches the cap.
   */
  it('pays a collector far more than a safe-line player over the same course', () => {
    const collector = playRun(20261018, FRAME_PERFECT, 120)
    const safe = playRun(20261018, SAFE_LINE, 120)

    // The theorem, as a measurement: the safe line takes exactly zero rings.
    expect(safe.thermalsCollected).toBe(0)
    expect(safe.peakMultiplier).toBe(1)

    expect(collector.peakMultiplier).toBe(5)
    expect(collector.score / safe.score).toBeGreaterThan(4)
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
   * The `opportunist` was reported under v1 as evidence that a cautious player
   * still takes most rings. It could not have done otherwise: the clearance left
   * by the cheapest collecting line was a constant, so the profile was a step
   * function of its own tolerance and quoting a number from it was quoting an
   * identity (GOK-14).
   *
   * In v2 the detour's affordability depends on the gap height and the scroll
   * speed, both of which move continuously, so the profile is a genuine dial —
   * and *that* is what is pinned here: it declines more as its nerve rises, and
   * at the extremes it collapses onto the two pure strategies. A version of this
   * that went back to being a step function would fail the middle assertion.
   */
  it('has tolerances at which declining a ring is a real judgement call', () => {
    const base: PlayerProfile = {
      strategy: 'opportunist',
      latency: 0,
      deadZone: 0,
      unanticipatedFrames: 0,
      aimJitter: 0,
      perception: 0,
      riskTolerance: 0,
    }
    const taken = (riskTolerance: number): number =>
      playRun(20261018, { ...base, riskTolerance }, 120).thermalsCollected

    // At zero nerve it is the collector outright, gate for gate.
    expect(playRun(20261018, base, 120)).toEqual(
      playRun(20261018, { ...base, strategy: 'collector' }, 120),
    )
    // At a nerve nothing can satisfy it is the safe line, which takes nothing.
    expect(taken(10_000)).toBe(0)

    // And in between it is monotone and actually graded — more than two distinct
    // outcomes, which is exactly what the v1 opportunist could not produce.
    const sweep = [0, 5, 10, 15, 20, 25, 30, 40, 60].map(taken)
    for (let i = 1; i < sweep.length; i += 1) {
      expect(sweep[i] as number).toBeLessThanOrEqual(sweep[i - 1] as number)
    }
    expect(new Set(sweep).size).toBeGreaterThan(2)
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
    // Seeded off a different constant from the search that produced the tape, so
    // all 200 patterns are unseen rather than being the ones it optimised over.
    const worst = Math.min(
      ...Array.from({ length: 200 }, (_, i) => fly(50, mulberry(i * 104729 + 7))),
    )
    expect(worst).toBeGreaterThan(0)
  })
})
