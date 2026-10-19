import { describe, expect, it } from 'vitest'
import {
  ASYMPTOTE_CHECKPOINT,
  ASYMPTOTIC_WORST_GATE,
  COLLECT_REACH,
  COST_CHECKPOINTS,
  PHASE_2_SHORTFALL,
  PUBLISHED_COST_TABLE,
  REFERENCE_DT,
  WORST_GATE_TABLE,
  collectingCost,
  costTable,
  requiredFloor,
  selfConsistentWorstGate,
  worstGateTowardDelta,
  type CostRow,
} from '../tools/feel/cost.js'
import { GATE_WIDTH, KITE_RADIUS, THERMAL_LEAD, VY_CLAMP } from '../src/game/constants.js'
import { gapHeight, scrollSpeed, thermalOutset } from '../src/game/difficulty.js'

/**
 * What a ring costs (spec §3, "Collecting cost").
 *
 * A table test, not a property test: the cost depends only on `t`. It is the
 * test that fails if someone retunes the placement without re-deriving what it
 * costs, and it is deliberately not dressed up as a proof — it asserts the
 * output of a model whose assumptions are listed in tools/feel/cost.ts.
 *
 * It computes the whole table once (about 1.6 s) and asserts against that.
 */

const TABLE = costTable()
const row = (elapsed: number): CostRow => {
  const found = TABLE.find((r) => r.elapsed === elapsed)
  if (found === undefined) throw new Error(`no row at t = ${elapsed}`)
  return found
}

describe('the risk layer is real at every difficulty', () => {
  /**
   * The headline claim, and the one that fails on v1's placement. Under v1 this
   * cost was 6-9% up to t = 60 s and **exactly zero from t = 77 s onward**,
   * because the ring sat inside the gap and the gap's own centre line collected
   * it. There is no gap height at which that is true of v2.
   */
  it('costs something to collect, at every published checkpoint', () => {
    for (const r of TABLE) {
      expect(r.cost).toBeGreaterThan(0)
      expect(r.collectingClearance).toBeLessThan(r.safeClearance)
    }
  })

  it('and the cost is never so large that the ring becomes untakeable', () => {
    for (const r of TABLE) {
      expect(r.collectingClearance).toBeGreaterThan(0)
      // A ring that cannot be taken without dying is as broken as one that is
      // free; 18 px of daylight at the asymptote is the thinnest it ever gets.
      expect(r.collectingClearance).toBeGreaterThan(15)
    }
  })

  it('falls strictly and monotonically as the course tightens', () => {
    for (let i = 1; i < TABLE.length; i += 1) {
      const previous = TABLE[i - 1] as CostRow
      const current = TABLE[i] as CostRow
      expect(current.collectingClearance).toBeLessThan(previous.collectingClearance)
      expect(current.safeClearance).toBeLessThan(previous.safeClearance)
    }
  })

  it('takes a growing share of the margin as the gap shrinks underneath it', () => {
    // Roughly a third to a half of the margin early, and about half at the
    // endgame gap: the ring costs about the same absolute altitude discipline
    // throughout, and what changes is how much margin there is to spend.
    expect(row(0).costFraction).toBeGreaterThan(0.3)
    expect(row(270).costFraction).toBeGreaterThan(0.45)
    expect(row(270).costFraction).toBeGreaterThan(row(0).costFraction)
    for (const r of TABLE) expect(r.costFraction).toBeLessThan(0.75)
  })

  it('is seed-independent — it is geometry, not a sample', () => {
    expect(collectingCost(150)).toEqual(row(150))
  })

  it('tracks the gap height the difficulty curve actually produces', () => {
    for (const r of TABLE) {
      expect(r.gap).toBeCloseTo(gapHeight(r.elapsed), 9)
      expect(r.safeClearance).toBeCloseTo(r.gap / 2 - KITE_RADIUS, 9)
    }
  })
})

describe('the model against the table published in spec §2.2', () => {
  /**
   * **This no longer passes for the whole table, and that is the finding.**
   *
   * v2.1 corrected §2.2's three phase-1 cells to this model's output
   * (79/64/50 → 63.6/48.6/41.5) on the ruling that the instrument is the
   * contract. It did not touch the phase-2 cells, which are still v2's hand
   * derivation. On the converged grid (GOK-25 finding 2 — the old `dt = 1/500`
   * default was up to 0.8 px optimistic) t = 90 s misses by 2.01 px, just
   * outside §2.2's own stated tolerance.
   *
   * So the tolerance is asserted where it holds and the one cell outside it is
   * named, rather than the bar being widened until everything fits. Reported on
   * GOK-17; correcting §2.2 is the CTO's call.
   */
  it('reproduces every published row to within 2 px, except t = 90 s', () => {
    for (const elapsed of COST_CHECKPOINTS) {
      const delta = Math.abs(
        row(elapsed).collectingClearance - (PUBLISHED_COST_TABLE[elapsed] as number),
      )
      if (elapsed === 90) expect(delta).toBeGreaterThan(2)
      else expect(delta).toBeLessThanOrEqual(2)
    }
  })

  /**
   * Every delta pinned, not just the one that broke the bar. Three of the four
   * phase-2 cells drifted when the grid converged and the fourth moved by a
   * pixel; pinning them is what stops "one cell is out" becoming two without
   * anyone noticing, which is how the phase-1 error survived review.
   *
   * The phase-1 rows are in here too. They were the model's own output as of
   * GOK-22 and now sit 0.4-0.7 px off it, for the same reason: the grid they
   * were measured on was coarse. That is a spec correction owed, not a model
   * failure, so it is recorded rather than asserted away.
   */
  it('pins every delta, so a second cell cannot drift out quietly', () => {
    for (const elapsed of COST_CHECKPOINTS) {
      const delta = row(elapsed).collectingClearance - (PUBLISHED_COST_TABLE[elapsed] as number)
      expect(delta).toBeCloseTo(PHASE_2_SHORTFALL[elapsed] as number, 1)
    }
  })

  /**
   * The negative test the ruling specifically asked to keep: the *loose*
   * reading of the traversal window is not what the table reports.
   *
   * That ambiguity — whether traversal begins when the kite's rim reaches the
   * column or when its centre does — is what produced the original error, since
   * v2's published numbers sat between the two readings so that neither
   * produced them. Rim is what collision.ts enforces. Pinning the gap stops the
   * table from being quietly reinterpreted back into the ambiguity.
   */
  it('is the strict reading: the loose one is 7.3 to 31.2 px looser', () => {
    // Model against model, not model against the spec. The published row has
    // its own drift now (`PHASE_2_SHORTFALL`), and subtracting it from this
    // comparison would mix a shortfall into a statement about the two readings.
    const loose = costTable({ rimEnters: false })
    const gaps = COST_CHECKPOINTS.map(
      (elapsed, i) => (loose[i] as CostRow).collectingClearance - row(elapsed).collectingClearance,
    )
    for (const gap of gaps) expect(gap).toBeGreaterThan(7)
    expect(Math.min(...gaps)).toBeCloseTo(7.3, 1)
    expect(Math.max(...gaps)).toBeCloseTo(31.2, 1)
    // Monotone in t, which is the shape the argument rests on: the two readings
    // differ by one kite radius of travel, and that is worth less time as the
    // course speeds up.
    for (let i = 1; i < gaps.length; i += 1) {
      expect(gaps[i] as number).toBeLessThan(gaps[i - 1] as number)
    }
  })

  it('has an analytic ceiling at t = 0 that v2 published above', () => {
    // Independent of the optimiser: the shallowest collecting altitude is
    // `h/2 + E - COLLECT_REACH` from the gap centre, the rim constraint bites
    // `THERMAL_LEAD - GATE_WIDTH/2 - KITE_RADIUS` px of world travel after the
    // ring is level with the kite, and nothing crosses that faster than the
    // speed clamp. This is why 79 px was unreachable rather than merely
    // unmatched, and it is the whole argument for the correction — so its
    // inputs are read from constants rather than written in as literals.
    const h = gapHeight(0)
    const safe = h / 2 - KITE_RADIUS
    const rimBites = THERMAL_LEAD - GATE_WIDTH / 2 - KITE_RADIUS
    const best = (dx: number): number => {
      const slack = Math.sqrt(Math.max(0, COLLECT_REACH * COLLECT_REACH - dx * dx))
      const mustReach = h / 2 + thermalOutset(0) - slack
      const seconds = (dx + rimBites) / scrollSpeed(0)
      return safe - (mustReach - VY_CLAMP * seconds)
    }
    let ceiling = -Infinity
    for (let dx = 0; dx <= COLLECT_REACH; dx += 0.01) ceiling = Math.max(ceiling, best(dx))
    expect(ceiling).toBeCloseTo(72.6, 0)
    // The number v2 published, which this ceiling rules out under any control
    // law. Kept as a literal on purpose: it is a historical claim, not a
    // quantity that should follow the constants if they move.
    expect(ceiling).toBeLessThan(79)
    // And this model, which also has to survive the traversal, lands under it.
    expect(row(0).collectingClearance).toBeLessThan(ceiling)
  })
}, 60_000)

describe('the worst legal gate (spec §2.3)', () => {
  const WORST = COST_CHECKPOINTS.map((t) => collectingCost(t, { worstGate: true }))
  const worst = (elapsed: number): CostRow => {
    const found = WORST.find((r) => r.elapsed === elapsed)
    if (found === undefined) throw new Error(`no worst-gate row at t = ${elapsed}`)
    return found
  }

  /**
   * **The acceptance criterion.** A ring that cannot be taken without dying is
   * as broken as one that is free, so the hardest legal gate still has to leave
   * `max(12, 25% of the margin)`. A failure here is a reachability failure and
   * goes back to the CTO — it is not something to absorb into a constant.
   */
  it('still leaves the ring takeable at every published checkpoint', () => {
    for (const r of WORST) {
      expect(r.collectingClearance).toBeGreaterThanOrEqual(requiredFloor(r.elapsed))
    }
  })

  /**
   * And past the end of them, which is the regime §2.4 is proudest of.
   *
   * The published checkpoints stop at t = 270 s. The margin over the floor is
   * thinnest at the *last* one and keeps thinning after it, so seven samples
   * could not see the part of the ramp the "no top" argument is about
   * (GOK-25, finding 3). By t = 1200 s the course has stopped moving entirely —
   * `worstGateTowardDelta` is 0 — so this single row stands for the whole rest
   * of a run of any length.
   *
   * It clears, by **0.2 px**. On the pre-GOK-25 grid it read 13.0 against the
   * same floor, a margin five times its true size, so this is also the clearest
   * statement of why the default grid had to move: the instrument's own error
   * was larger than the quantity being measured.
   */
  it('still leaves it takeable out at the asymptote, by a fifth of a pixel', () => {
    const late = collectingCost(ASYMPTOTE_CHECKPOINT, { worstGate: true })
    expect(late.collectingClearance).toBeCloseTo(ASYMPTOTIC_WORST_GATE, 1)
    expect(late.collectingClearance).toBeGreaterThanOrEqual(requiredFloor(ASYMPTOTE_CHECKPOINT))
    expect(late.collectingClearance - requiredFloor(ASYMPTOTE_CHECKPOINT)).toBeLessThan(0.5)
    // The course really has stopped: the floors, not the ramp, are what this
    // row is measuring. (Not exactly equal — the ramp approaches its floors
    // asymptotically — but to well under a tenth of the quantity in question.)
    expect(late.gap).toBeCloseTo(gapHeight(3600), 5)
  })

  /**
   * **The exit assumptions straddle the floor.** The published row lets the
   * kite leave the previous gap hugging its near edge — holding nothing there
   * in order to hold 12.9 here — which the model's own "at every gate" does not
   * license (GOK-25, finding 1). Asking for the same clearance at both ends is
   * a fixed point, and at rest it lands *under* the floor at the two endgame
   * checkpoints.
   *
   * This is not a FAIL of the criterion as written, and the reason is the
   * symmetric point: a collector that holds clearance at the previous gate is
   * also still moving as it leaves it, and ~100 px/s restores every cell. The
   * two assumptions pull opposite ways and the published figure sits between
   * them. Which one §2.3 means is the CTO's, so this test pins the straddle
   * rather than picking a side.
   */
  it('straddles the floor once the exit from the previous gap is priced', () => {
    for (const elapsed of [210, 270]) {
      const floor = requiredFloor(elapsed)
      const settled = selfConsistentWorstGate(elapsed)
      const moving = selfConsistentWorstGate(elapsed, { approachExitVelocity: 100 })
      expect(settled).toBeLessThan(floor)
      expect(moving).toBeGreaterThanOrEqual(floor)
      // And the published row is between the two, which is the whole claim.
      expect(WORST_GATE_TABLE[elapsed] as number).toBeGreaterThan(settled)
      expect(WORST_GATE_TABLE[elapsed] as number).toBeLessThanOrEqual(moving + 0.1)
    }
  })

  /**
   * Phase 1 is insensitive to the exit *velocity* and not to the exit
   * *position* — which is the correction to what I reported on GOK-17, where I
   * swept the one axis that could not move the answer and called the cell
   * robust. The fixed points are 36.0 at t = 60 and 56.1 at t = 0, against
   * published cells of 41.1 and 62.9. Both clear their floors twice over, so
   * nothing rests on them; this is here so the claim cannot be made again.
   *
   * One probe rather than the fixed point, because the fixed point costs a
   * model evaluation per step and the straddle test above already exercises
   * it. Asking the kite to leave the previous gap holding what this row claims
   * to hold here is the single most interesting point on the map anyway.
   */
  it('and phase 1 moves on that axis too, even though it clears easily', () => {
    const published = WORST_GATE_TABLE[60] as number
    const holdingBoth = collectingCost(60, {
      worstGate: true,
      towardDelta: worstGateTowardDelta(60) + published,
    }).collectingClearance
    expect(holdingBoth).toBeLessThan(published - 5)
    expect(holdingBoth).toBeGreaterThan(1.5 * requiredFloor(60))
  })

  it('is never easier than the typical gate, and never free', () => {
    for (const r of WORST) {
      expect(r.collectingClearance).toBeLessThanOrEqual(
        (PUBLISHED_COST_TABLE[r.elapsed] as number) + 0.1,
      )
      expect(r.collectingClearance).toBeGreaterThan(0)
    }
  })

  /**
   * Phase 1 re-derives to the best-gate figure exactly, and that is the finding
   * rather than a rounding artefact: at t = 0 the gates are 288 px apart at
   * 180 px/s, so the kite has 0.84 s of approach in which a 30 px course move
   * costs it nothing at all. The worst gate and the best gate are the same gate
   * until the interval starts to bite, which is why v2's 72 / 59 / 45 px could
   * not have been right — they claimed the worst gate was *harder* than this
   * model says the best one is.
   *
   * "Exactly" means to 0.1 px, which is the grid's own residual jitter rather
   * than a slack bar: phase 2 separates the two by 11 px and more.
   */
  it('costs nothing extra in phase 1, where the approach is free', () => {
    for (const elapsed of [0, 30, 60]) {
      expect(
        Math.abs(worst(elapsed).collectingClearance - row(elapsed).collectingClearance),
      ).toBeLessThan(0.1)
    }
  })

  /** And it does bite in phase 2, where the interval has closed up. */
  it('costs real clearance in phase 2', () => {
    for (const elapsed of [90, 150, 210, 270]) {
      expect(worst(elapsed).collectingClearance).toBeLessThan(row(elapsed).collectingClearance - 4)
    }
  })

  it('matches the row published in spec §2.3', () => {
    for (const elapsed of COST_CHECKPOINTS) {
      expect(worst(elapsed).collectingClearance).toBeCloseTo(WORST_GATE_TABLE[elapsed] as number, 1)
    }
  })

  /**
   * The required floor is derived, not transcribed: it is 25% of the margin
   * until the margin gets small enough for the absolute 12 px to take over,
   * which happens between t = 150 and t = 210.
   */
  it('derives its floor from the gap the ramp actually produces', () => {
    expect(requiredFloor(0)).toBeCloseTo(28.5, 1)
    expect(requiredFloor(90)).toBeCloseTo(14.75, 2)
    expect(requiredFloor(210)).toBe(12)
    expect(requiredFloor(3600)).toBe(12)
  })
}, 180_000)

describe('the model itself', () => {
  /**
   * The convergence check this replaces refined `dt` and `switchSamples`
   * together and ran balanced mode only — so it never covered the mode with
   * the pinned table, and it spent most of its budget on the knob that does
   * nothing (GOK-25, finding 2). Refined properly it failed at t = 90 s.
   *
   * Three representative points rather than all seven, because the reference
   * grid is twice the work of the default: phase 1, the phase-2 knee where the
   * approach starts to bite, and the endgame where the margin over the floor is
   * thinnest.
   */
  const SPOTS = [0, 90, 270] as const

  it('has settled: refining dt moves no row by more than a tenth of a pixel', () => {
    for (const worstGate of [false, true]) {
      for (const elapsed of SPOTS) {
        const coarse = collectingCost(elapsed, { worstGate }).collectingClearance
        const fine = collectingCost(elapsed, { dt: REFERENCE_DT, worstGate }).collectingClearance
        expect(Math.abs(coarse - fine)).toBeLessThan(0.1)
      }
    }
  })

  /**
   * And the other knob is inert, which is why refining both at once hid the
   * problem: a fourfold refinement of `switchSamples` moves nothing, so a
   * check that spends its budget there measures its own patience.
   *
   * Measured at a coarse `dt` on purpose. The claim is about the switch grid
   * and holds at any `dt`; pricing it at the default would cost eight model
   * evaluations at the default's resolution to say the same thing.
   */
  it('is insensitive to the switch-time grid, so dt is the whole claim', () => {
    for (const elapsed of SPOTS) {
      const coarse = collectingCost(elapsed, {
        dt: 1 / 4000,
        worstGate: true,
      }).collectingClearance
      const fine = collectingCost(elapsed, {
        dt: 1 / 4000,
        worstGate: true,
        switchSamples: 240,
      }).collectingClearance
      expect(Math.abs(coarse - fine)).toBeLessThan(0.05)
    }
  })

  /**
   * The bias has a sign, and it is the dangerous one. The column constraint and
   * the held clearance are *sampled* on the dt grid rather than solved, so a
   * coarse grid steps over near-misses and reports clearance the line never
   * holds. Every cell of both tables moved **down** when the grid converged.
   * A model that errs optimistically is the wrong kind of model to grade a
   * reachability floor with, which is the argument for paying for 1/8000.
   */
  it('errs optimistically when coarse, which is why the default had to move', () => {
    for (const elapsed of COST_CHECKPOINTS) {
      const old = collectingCost(elapsed, { dt: 1 / 500, worstGate: true }).collectingClearance
      expect(old).toBeGreaterThan(WORST_GATE_TABLE[elapsed] as number)
    }
  })

  it('covers every checkpoint the spec publishes', () => {
    expect(TABLE.map((r) => r.elapsed)).toEqual([...COST_CHECKPOINTS])
    expect(Object.keys(PUBLISHED_COST_TABLE).map(Number)).toEqual([...COST_CHECKPOINTS])
    expect(Object.keys(WORST_GATE_TABLE).map(Number)).toEqual([...COST_CHECKPOINTS])
    expect(ASYMPTOTE_CHECKPOINT).toBeGreaterThan(Math.max(...COST_CHECKPOINTS))
  })
}, 180_000)
