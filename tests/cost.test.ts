import { describe, expect, it } from 'vitest'
import {
  COST_CHECKPOINTS,
  PUBLISHED_COST_TABLE,
  collectingCost,
  costTable,
  type CostRow,
} from '../tools/feel/cost.js'
import { KITE_RADIUS } from '../src/game/constants.js'
import { gapHeight } from '../src/game/difficulty.js'

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
   * The second ramp reproduces, to the spec's own ±2 px, on every row. That is
   * the half of the table this task exists to create, and it is the half where
   * `E(t)` is at its 22 px floor.
   */
  it('reproduces every row of the second ramp to within 2 px', () => {
    for (const elapsed of [90, 150, 210, 270]) {
      const published = PUBLISHED_COST_TABLE[elapsed] as number
      expect(Math.abs(row(elapsed).collectingClearance - published)).toBeLessThanOrEqual(2)
    }
  })

  /**
   * The three phase-1 rows do not, and the gap is pinned here rather than left
   * in a comment, so that it is visible every time this suite runs and so that
   * a later change to either side shows up as a diff.
   *
   * This model reports the early detour as 8 to 16 px *more* expensive than
   * published. The t = 0 figure is not merely unmatched but unreachable: the
   * speed clamp alone caps the holdable clearance there at 72.6 px against a
   * published 79. Under the loose reading of the traversal window the same rows
   * come out 9 to 15 px cheaper than published instead — so no single reading of
   * the model's own prose yields the published phase-1 numbers.
   *
   * Reported to the CTO on GOK-17. Not tuned away: no gameplay constant moves to
   * make a measurement agree with a table.
   */
  it('does not reproduce phase 1, and records by how much', () => {
    const shortfall = (elapsed: number): number =>
      (PUBLISHED_COST_TABLE[elapsed] as number) - row(elapsed).collectingClearance
    expect(shortfall(0)).toBeCloseTo(15.4, 0)
    expect(shortfall(30)).toBeCloseTo(15.4, 0)
    expect(shortfall(60)).toBeCloseTo(8.5, 0)
  })

  it('has an analytic ceiling at t = 0 that the published 79 px exceeds', () => {
    // Independent of the optimiser: the shallowest collecting altitude is
    // `h/2 + E - 38` from the gap centre, the rim constraint bites 13 px of
    // world travel after the ring is level with the kite, and nothing can cross
    // that distance faster than the speed clamp.
    const h = gapHeight(0)
    const safe = h / 2 - KITE_RADIUS
    const best = (dx: number): number => {
      const slack = Math.sqrt(Math.max(0, 38 * 38 - dx * dx))
      const mustReach = h / 2 + 76 - slack
      const seconds = (dx + 13) / 180
      return safe - (mustReach - 560 * seconds)
    }
    let ceiling = -Infinity
    for (let dx = 0; dx <= 38; dx += 0.01) ceiling = Math.max(ceiling, best(dx))
    expect(ceiling).toBeCloseTo(72.6, 0)
    expect(ceiling).toBeLessThan(PUBLISHED_COST_TABLE[0] as number)
    // And this model, which also has to survive the traversal, lands under it.
    expect(row(0).collectingClearance).toBeLessThan(ceiling)
  })
})

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
