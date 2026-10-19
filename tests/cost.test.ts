import { describe, expect, it } from 'vitest'
import {
  COLLECT_REACH,
  COST_CHECKPOINTS,
  PUBLISHED_COST_TABLE,
  WORST_GATE_TABLE,
  collectingCost,
  costTable,
  requiredFloor,
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
   * Since v2.1 the published table *is* this model's output, so the whole table
   * reproduces rather than three rows of it documenting a shortfall. The three
   * phase-1 cells were corrected on GOK-22 (79/64/50 → 63.6/48.6/41.5); the
   * ruling was that the instrument is the contract and the hand-derived row was
   * fitted to a headline.
   */
  it('reproduces every published row to within 2 px', () => {
    for (const elapsed of COST_CHECKPOINTS) {
      const published = PUBLISHED_COST_TABLE[elapsed] as number
      expect(Math.abs(row(elapsed).collectingClearance - published)).toBeLessThanOrEqual(2)
    }
  })

  /**
   * And the three corrected cells are pinned tight, because they are not an
   * independent claim this model is being checked against — they are its own
   * output, rounded to a decimal. A drift of more than 0.1 px here means the
   * model moved and the spec did not.
   */
  it('pins the three corrected phase-1 cells to a tenth of a pixel', () => {
    for (const elapsed of [0, 30, 60]) {
      const published = PUBLISHED_COST_TABLE[elapsed] as number
      expect(row(elapsed).collectingClearance).toBeCloseTo(published, 1)
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
  it('is the strict reading: the loose one is 8.7 to 30.6 px looser', () => {
    const loose = costTable({ rimEnters: false })
    const gaps = COST_CHECKPOINTS.map((elapsed, i) => {
      const published = PUBLISHED_COST_TABLE[elapsed] as number
      return (loose[i] as CostRow).collectingClearance - published
    })
    for (const gap of gaps) expect(gap).toBeGreaterThan(8)
    expect(Math.min(...gaps)).toBeCloseTo(8.7, 0)
    expect(Math.max(...gaps)).toBeCloseTo(30.6, 0)
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
})

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
   */
  it('costs nothing extra in phase 1, where the approach is free', () => {
    for (const elapsed of [0, 30, 60]) {
      expect(worst(elapsed).collectingClearance).toBeCloseTo(row(elapsed).collectingClearance, 1)
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
}, 120_000)

describe('the model itself', () => {
  it('has settled: refining the grid moves no row by more than half a pixel', () => {
    const fine = costTable({ dt: 1 / 2000, switchSamples: 240 })
    for (const [i, r] of TABLE.entries()) {
      expect(
        Math.abs(r.collectingClearance - (fine[i] as CostRow).collectingClearance),
      ).toBeLessThan(0.5)
    }
  })

  it('covers every checkpoint the spec publishes', () => {
    expect(TABLE.map((r) => r.elapsed)).toEqual([...COST_CHECKPOINTS])
    expect(Object.keys(PUBLISHED_COST_TABLE).map(Number)).toEqual([...COST_CHECKPOINTS])
  })
}, 120_000)
