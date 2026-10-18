import { describe, expect, it } from 'vitest'
import { latencyFrames, playRun, type PlayerProfile } from '../tools/feel/autopilot.js'
import { DIP_DEPTHS, sampleCourse, searchForFreeCollect } from '../tools/feel/geometry.js'
import {
  CEILING_Y,
  DIFFICULTY_RAMP_SECONDS,
  FIXED_DT,
  GAP_Y_MIN,
  GATE_WIDTH,
  KITE_RADIUS,
  KITE_X,
  THERMAL_OUTSIDE_OFFSET,
  THERMAL_RADIUS,
} from '../src/game/constants.js'
import { DEFAULT_SEED as E2E_SEED, SCORING_TAPE } from '../e2e/game.js'
import { createInitialState, thermalX } from '../src/game/state.js'
import { flyTape, mulberry } from '../tools/feel/tape.js'
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
  strategy: 'safe',
  latency: 0,
  deadZone: 0,
  unanticipatedFrames: 0,
  aimJitter: 0,
  perception: 0,
  riskTolerance: 0,
}

const SEEDS = [20261018, 1234, 7, 999_983, 42]

/** The hands the feel report calls competent, flying the safe line. */
const COMPETENT: PlayerProfile = {
  strategy: 'safe',
  latency: 0.083,
  deadZone: 8,
  unanticipatedFrames: 1,
  aimJitter: 10,
  perception: 16,
  riskTolerance: 0,
}

/** The same hands, going for every ring — the player the risk layer is aimed at. */
const COMPETENT_COLLECTOR: PlayerProfile = { ...COMPETENT, strategy: 'collector' }

describe('the course is flyable', () => {
  /**
   * Flyable is a claim about the *gaps*, and after the 2026-10-18 revision it is
   * only about the gaps: the rings are outside them now, so going for one is a
   * choice the player makes and a ring they cannot safely reach is a ring they
   * decline. What must never happen is the course killing someone who declines
   * every one of them — so both of these fly the safe line.
   */
  it.each(SEEDS)('a frame-perfect player survives 120 s on seed %i', (seed) => {
    const result = playRun(seed, FRAME_PERFECT, 120)
    expect(result.crashCause).toBeNull()
    expect(result.duration).toBeGreaterThanOrEqual(120)
  })

  it.each(SEEDS)('and so does a competent one, with hands that shake, on seed %i', (seed) => {
    const result = playRun(seed, COMPETENT, 120)
    expect(result.crashCause).toBeNull()
    expect(result.duration).toBeGreaterThanOrEqual(120)
  })

  it('and scores on the way — a run is not just survival', () => {
    const result = playRun(20261018, FRAME_PERFECT, 120)
    expect(result.gatesPassed).toBeGreaterThan(50)
  })

  /**
   * The multiplier is the reward layer's and nothing else's: the streak counts
   * consecutive rings, so the safe line flies a whole run at 1x and only someone
   * leaving the gap can reach the cap. That is the entire economic argument for
   * taking a risk, so it is pinned on both sides.
   */
  it('pays the multiplier only to a player who leaves the gap', () => {
    expect(playRun(20261018, FRAME_PERFECT, 120).peakMultiplier).toBe(1)
    const collecting = SEEDS.map((seed) => playRun(seed, COMPETENT_COLLECTOR, 120))
    expect(Math.max(...collecting.map((r) => r.peakMultiplier))).toBe(5)
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
   * The spec revision of 2026-10-18 (GOK-5), pinned as tests so that the day
   * someone moves a thermal back inside its gap, these fail and say why.
   *
   * The old placement's problem was not a bad number, it was an algebraic
   * identity: a ring strictly inside the gap is always collectible from an
   * altitude that already clears the columns, for every gap height and every
   * radius, so no retune could have produced a risk layer. The revision inverts
   * exactly that identity.
   */

  /**
   * The threshold the whole mechanic turns on, swept on BOTH sides rather than
   * confirmed at today's constants. A sweep that only checked the current values
   * would pass just as happily if the inequality were an accident.
   */
  it('turns on one inequality: the ring is outside the gap, or there is no risk', () => {
    const { tested, riskyInside, freeOutside } = searchForFreeCollect()
    expect(tested).toBeGreaterThan(100_000)
    // Inside the gap: a safe collecting altitude ALWAYS exists. The old finding.
    expect(riskyInside).toBe(0)
    // Outside it: one never does. The new one.
    expect(freeOutside).toBe(0)
    expect(THERMAL_OUTSIDE_OFFSET).toBeGreaterThan(THERMAL_RADIUS)
  })

  /**
   * And the cost does not melt away as the game gets harder, which is what sank
   * the old placement: there, the ring's offset from the gap centre shrank with
   * the gap until the centre line collected it outright at t=77s. Here the gap
   * height cancels, so the excursion is the same constant at t=0 and at maximum
   * difficulty.
   */
  it('costs the same excursion at every point on the ramp', () => {
    const expected = THERMAL_OUTSIDE_OFFSET - THERMAL_RADIUS
    expect(expected).toBeGreaterThan(0)
    for (const elapsed of [0, 30, 60, DIFFICULTY_RAMP_SECONDS, 3 * DIFFICULTY_RAMP_SECONDS]) {
      const course = sampleCourse(20261018, elapsed + 30).filter((g) => g.elapsed >= elapsed)
      expect(course.length).toBeGreaterThan(5)
      for (const gate of course) {
        expect(gate.excursion).toBeCloseTo(expected, 9)
        expect(gate.freeCollect).toBe(0)
      }
    }
  })

  /**
   * The ring has to be in genuine open air, or the excursion would be instant
   * death rather than a risk: at no moment may the kite be inside a column's
   * x-range while an uncollected ring is within reach of it. That is what bounds
   * THERMAL_LEAD_X on both sides, and the bound depends on the gate spacing the
   * difficulty ramp produces, so it is checked against the real simulation rather
   * than against the arithmetic in spawner.ts's header.
   *
   * Two things about *how* it is flown, both found by the GOK-18 review and both
   * the difference between this test meaning something and reading as though it
   * does.
   *
   * **The player must survive, so fly the safe line.** The quantity being checked
   * is a property of the gate schedule, not of the kite — the kite's altitude
   * never enters the clearance below. So the profile's only job is to keep the
   * run alive long enough to see the course, and the collector profile cannot:
   * it dies at 7.0, 4.0, 7.1, 23.0 and 68.7 s on these five seeds, so a test
   * asking for 150 s got a median of seven, and the anti-vacuity guard was
   * carried by seed 42 alone. COMPETENT survives the full 150 s on all five.
   *
   * **The seeds do not buy five schedules.** A gate's x comes from `elapsed`
   * through `scrollSpeed` and `spawnInterval` only; the rng places gaps
   * vertically and picks the ring's side. So all five seeds walk the *same*
   * horizontal schedule and this assertion's strength is its 150 s of duration,
   * not its seed count. The seeds still earn their place — they vary the course
   * the player has to survive to get there — but nobody should read five seeds
   * here as five independent samples of the thing being asserted.
   */
  it('never puts a ring where reaching for it means being inside a column', () => {
    const reach = THERMAL_RADIUS + KITE_RADIUS
    let tightest = Infinity
    const framesPerSeed: number[] = []
    for (const seed of SEEDS) {
      // Watched from inside a real run rather than flown by a throwaway input
      // pattern: the gate schedule is what is being checked, and a pattern crude
      // enough to write inline here dies in the first few seconds and never sees
      // the course the player actually meets.
      let frames = 0
      const result = playRun(seed, COMPETENT, 150, (state) => {
        if (state.phase !== 'playing') return
        // Horizontal distance from the kite at which a ring is reachable at all.
        if (!state.gates.some((gate) => Math.abs(thermalX(gate) - KITE_X) <= reach)) return
        frames += 1
        for (const gate of state.gates) {
          const clearance = Math.max(
            gate.x - (KITE_X + KITE_RADIUS),
            KITE_X - KITE_RADIUS - (gate.x + GATE_WIDTH),
          )
          tightest = Math.min(tightest, clearance)
        }
      })
      // The run reached the end of the window rather than dying into it: the
      // 150 above is the test's reach, and this is what stops it being decoration.
      expect(result.crashCause).toBeNull()
      framesPerSeed.push(frames)
    }
    // Not vacuous, and not carried by one outlier: every seed on its own sees
    // rings in reach on over a thousand frames.
    for (const frames of framesPerSeed) expect(frames).toBeGreaterThan(1_000)
    // Positive: whenever a ring is in reach, every column is clear of the kite.
    expect(tightest).toBeGreaterThan(0)
    // And not vacuous — the margin is real but not enormous.
    expect(tightest).toBeLessThan(KITE_RADIUS * 4)
  })

  /**
   * Finally, the thing the whole revision was for: the layer is not a formality.
   * A model player that takes every ring dies measurably more often than one that
   * never leaves the gap — on deaths per 100 gates, which the run cutoff cannot
   * eat. Under the old placement both of these were 0.
   */
  it('makes taking rings cost something a safe line does not pay', () => {
    const rate = (profile: PlayerProfile): number => {
      const runs = SEEDS.map((seed) => playRun(seed, profile, 120))
      const gates = runs.reduce((a, r) => a + r.gatesPassed, 0)
      const deaths = runs.filter((r) => r.crashCause !== null).length
      return gates === 0 ? Infinity : (100 * deaths) / gates
    }
    const safe = rate(COMPETENT)
    const collector = rate(COMPETENT_COLLECTOR)
    expect(safe).toBe(0)
    expect(collector).toBeGreaterThan(1)

    // And it is not merely a tax on shaky hands: taking *every* ring costs a
    // frame-perfect player runs too, while the same player flying the safe line
    // never dies at all. That gap is the layer, and it is what the old placement
    // could not produce at any setting of any constant.
    expect(rate(FRAME_PERFECT)).toBe(0)
    expect(rate({ ...FRAME_PERFECT, strategy: 'collector' })).toBeGreaterThan(1)

    // And the safe line is genuinely abstaining now, rather than collecting most
    // of them by accident the way it did when the ring sat inside the gap.
    const safeRuns = SEEDS.map((seed) => playRun(seed, COMPETENT, 120))
    const gates = safeRuns.reduce((a, r) => a + r.gatesPassed, 0)
    const taken = safeRuns.reduce((a, r) => a + r.thermalsTakenOnPassedGates, 0)
    expect(taken / gates).toBeLessThan(0.1)
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
   * The `opportunist` used to be a step function of its own tolerance: the
   * clearance it tested was a constant, so every tolerance below it took every
   * ring and every tolerance above it took none, and quoting a number from inside
   * one band as caution was quoting an identity (GOK-14).
   *
   * It is a judgement now, and this is what that means operationally: raising the
   * nerve has to change which rings are declined, not merely how many, and there
   * has to be a tolerance at which the same player accepts some and declines
   * others on the same run. A step function cannot do the second one.
   */
  it('declines some rings and takes others at the same tolerance', () => {
    const base: PlayerProfile = { ...COMPETENT, strategy: 'opportunist', riskTolerance: 40 }
    const runs = SEEDS.map((seed) => playRun(seed, base, 120))
    const offered = runs.reduce((a, r) => a + r.ringsOffered, 0)
    const declined = runs.reduce((a, r) => a + r.ringsDeclined, 0)
    expect(offered).toBeGreaterThan(100)
    expect(declined).toBeGreaterThan(0)
    expect(declined).toBeLessThan(offered)

    // And the knob is a dial rather than a switch: more nerve, fewer rings.
    const rate = (riskTolerance: number): number => {
      const rs = SEEDS.map((seed) => playRun(seed, { ...base, riskTolerance }, 120))
      const o = rs.reduce((a, r) => a + r.ringsOffered, 0)
      return rs.reduce((a, r) => a + r.ringsDeclined, 0) / o
    }
    expect(rate(0)).toBeLessThan(rate(40))
    expect(rate(40)).toBeLessThan(rate(90))
  })

  /**
   * The dip depth is a fixed number per strategy (geometry.ts's DIP_DEPTHS), not
   * something derived from the slack model that then judges it — if it were, "the
   * collector survives" would be partly a measurement of my own arithmetic. Pinned
   * so the circularity cannot creep back in.
   */
  it('flies dip depths that are stated, not computed from the model that grades them', () => {
    expect(DIP_DEPTHS.greedy).toBe(0)
    expect(DIP_DEPTHS.skimmer).toBe(THERMAL_RADIUS + KITE_RADIUS)
    expect(DIP_DEPTHS.collector).toBeGreaterThan(DIP_DEPTHS.greedy)
    expect(DIP_DEPTHS.collector).toBeLessThan(DIP_DEPTHS.skimmer)

    // The skim is the one the geometry says should hurt, and it does: it touches
    // the ring only at dx = 0, so it drops rings the other lines take.
    const base = COMPETENT_COLLECTOR
    const ringRate = (strategy: PlayerProfile['strategy']): number => {
      const rs = SEEDS.map((seed) => playRun(seed, { ...base, strategy }, 120))
      const gates = rs.reduce((a, r) => a + r.gatesPassed, 0)
      return rs.reduce((a, r) => a + r.thermalsTakenOnPassedGates, 0) / Math.max(1, gates)
    }
    expect(ringRate('skimmer')).toBeLessThan(ringRate('collector') - 0.2)
  })
})

describe("the browser suite's input tape", () => {
  /**
   * e2e/game.ts flies an open-loop schedule so the game-over screenshot shows a
   * game someone played rather than a card reading zero. The browser asserts
   * nothing about it — under load it scores nothing, which is exactly why — so
   * without this test the tape could rot into a dead schedule and the only
   * symptom would be quietly worse deploy evidence. It did rot, once: the
   * thermal revision moved the course out from under it (GOK-5).
   *
   * Re-derive with `node scripts/run-tool.mjs tools/feel/tape-search.ts`, which
   * flies candidates through the same `flyTape` these assertions use, so the
   * thing the search maximises and the thing this guards cannot drift apart.
   */
  it('scores on the seed the browser suite uses, with perfect timing', () => {
    expect(flyTape(SCORING_TAPE, E2E_SEED, 0, () => 0)).toBeGreaterThan(0)
  })

  /**
   * And under delay, one-sided: a CDP round trip only ever makes a phase longer,
   * never shorter.
   *
   * The patterns are drawn from a *different* generator than the search's. They
   * used to come from `mulberry(i * 7919 + 1)` — the search's own formula over
   * the same `i` — so of the 200 patterns, 120 were literally the ones the
   * hill-climb had maximised the minimum over and only 80 were new. "200 rather
   * than the search's 120" was true about the count and misleading about the
   * evidence, which is the GOK-18 finding shape. Reseeded so all 200 are unseen,
   * and it still passes.
   */
  it('still scores when every phase overruns by up to 50 ms', () => {
    const worst = Math.min(
      ...Array.from({ length: 200 }, (_, i) =>
        flyTape(SCORING_TAPE, E2E_SEED, 50, mulberry(i * 104_729 + 7)),
      ),
    )
    expect(worst).toBeGreaterThan(0)
  })
})
