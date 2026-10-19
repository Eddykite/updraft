import { describe, expect, it } from 'vitest'
import {
  ASYMPTOTE_CHECKPOINT,
  COLLECT_REACH,
  COST_CHECKPOINTS,
  CYCLE_GRID,
  NEAR_EDGE_WORST_GATE,
  PUBLISHED_CHECKPOINTS,
  PUBLISHED_COST_TABLE,
  PUBLISHED_COST_TABLE_REVISION,
  REFERENCE_DT,
  SELF_CONSISTENT_WORST_GATE,
  SWITCH_REFERENCE,
  collectingCost,
  costTable,
  requiredFloor,
  worstCycle,
  type CostRow,
} from '../tools/feel/cost.js'
import { SPEC_REVISION } from '../tools/spec-revision.js'
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
 * It computes the whole table once (about 2 s) and asserts against that.
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
      // free; 18.7 px of daylight at the asymptote is the thinnest it ever gets
      // on a typical gate. What the *worst* gate leaves is §2.3's question and
      // a much tighter number — see below.
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
   * **The guard §3 added in v2.2, and the whole reason this file has one.**
   *
   * On GOK-27 the in-code transcription of §2.2's table was found to be a full
   * revision behind the document, and all 23 tests passed anyway — because
   * every assertion compared the model to the transcription and nothing
   * compared the transcription to the spec. The one mechanism meant to catch a
   * hand-edited table was the mechanism that hid one: it reported a 2.01 px
   * shortfall against a cell §2.2 had already replaced.
   *
   * Nothing in this repo can read the document, so this cannot verify the
   * numbers. What it does is make staleness fail *loudly at the moment the spec
   * moves*: bump `SPEC_REVISION` and this goes red until someone opens the new
   * §2.2, re-reads the table, and bumps the transcription's own revision with
   * it. That read is the verification; this is what forces it to happen.
   */
  it('is not a revision stale: the table names the spec revision it came from', () => {
    expect(PUBLISHED_COST_TABLE_REVISION).toBe(SPEC_REVISION)
  })

  /**
   * §3's pin: every published row within the ±2 px §2.2 states, with no
   * exceptions and none named. The exception that used to be here — "except
   * t = 90 s" — was an artefact of the stale copy, not a property of the
   * design.
   */
  it('reproduces every published row to within 2 px', () => {
    for (const elapsed of PUBLISHED_CHECKPOINTS) {
      const delta = Math.abs(
        row(elapsed).collectingClearance - (PUBLISHED_COST_TABLE[elapsed] as number),
      )
      expect(delta).toBeLessThanOrEqual(2)
    }
  })

  /**
   * And far tighter than that, because v2.2's table **is** this model's output
   * on this grid: every residual is inside the rounding of the one decimal
   * §2.2 publishes to.
   *
   * This is what replaces `PHASE_2_SHORTFALL`. That constant pinned a seven-cell
   * residual so a second cell could not drift out quietly, which was the right
   * instinct aimed at the wrong thing: three of its cells were wrong because
   * they inherited a stale baseline, and what it was really recording was the
   * staleness of the copy rather than a shortfall in the design. There is no
   * shortfall to pin, so the bar is the publication rounding instead.
   *
   * **"On this grid" is load-bearing in that sentence.** The grid is converged
   * in `dt` and is not converged in `switchSamples` (GOK-26), so what this
   * asserts is that the model reproduces the cells §2.2 published *from this
   * configuration* — which is a transcription check, exactly as it says, and
   * not a claim that those cells are the converged ones. On a converged switch
   * grid seven of the eight decimals change — six of them by more than the
   * 0.1 px `dt` is held to — all of them upward, and all of them still inside
   * §2.2's ±2 px, which is why that pin would not have caught this either.
   * Raising the knob is a spec revision because it moves published cells, so
   * this bar holds until §2.2 moves with it.
   */
  it('is the published table, to the rounding it is published at', () => {
    for (const elapsed of PUBLISHED_CHECKPOINTS) {
      const delta = row(elapsed).collectingClearance - (PUBLISHED_COST_TABLE[elapsed] as number)
      expect(Math.abs(delta)).toBeLessThan(0.05)
    }
  })

  /**
   * The negative test the GOK-22 ruling specifically asked to keep: the *loose*
   * reading of the traversal window is not what the table reports.
   *
   * That ambiguity — whether traversal begins when the kite's rim reaches the
   * column or when its centre does — is what produced the original error, since
   * v2's published numbers sat between the two readings so that neither
   * produced them. Rim is what collision.ts enforces. Pinning the gap stops the
   * table from being quietly reinterpreted back into the ambiguity.
   */
  it('is the strict reading: the loose one is 6.9 to 31.2 px looser', () => {
    // Model against model, not model against the spec: this is a statement
    // about two readings of one sentence, and mixing a transcription residual
    // into it would make it a statement about neither.
    const loose = costTable({ rimEnters: false })
    const gaps = PUBLISHED_CHECKPOINTS.map(
      (elapsed, i) => (loose[i] as CostRow).collectingClearance - row(elapsed).collectingClearance,
    )
    for (const gap of gaps) expect(gap).toBeGreaterThan(6)
    expect(Math.min(...gaps)).toBeCloseTo(6.9, 1)
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

  it('covers every checkpoint the spec publishes, the `→ ∞` cell included', () => {
    expect(TABLE.map((r) => r.elapsed)).toEqual([...PUBLISHED_CHECKPOINTS])
    expect(Object.keys(PUBLISHED_COST_TABLE).map(Number)).toEqual([...PUBLISHED_CHECKPOINTS])
    expect(PUBLISHED_CHECKPOINTS).toEqual([...COST_CHECKPOINTS, ASYMPTOTE_CHECKPOINT])
    expect(ASYMPTOTE_CHECKPOINT).toBeGreaterThan(Math.max(...COST_CHECKPOINTS))
    // The asymptotic row really is the asymptote: the course has reached its
    // floors long before t = 1800 s, so this cell is every gate of the rest of
    // a run of any length rather than a limit it approaches.
    expect(gapHeight(ASYMPTOTE_CHECKPOINT)).toBeCloseTo(gapHeight(3600), 5)
  })
}, 60_000)

describe('the collector the struck §2.3 row was measured on', () => {
  const NEAR = PUBLISHED_CHECKPOINTS.map((t) => collectingCost(t, { worstGate: true }))
  const near = (elapsed: number): CostRow => {
    const found = NEAR.find((r) => r.elapsed === elapsed)
    if (found === undefined) throw new Error(`no near-edge row at t = ${elapsed}`)
    return found
  }

  /**
   * **This row is struck in spec v2.2 and is not a published figure.** It is
   * reproduced so that the strike can be checked against the numbers that
   * earned it, and because it is the ceiling the self-consistent bisection
   * brackets against. Nothing is graded on it.
   */
  it('reproduces the figures the strike was argued from', () => {
    for (const elapsed of PUBLISHED_CHECKPOINTS) {
      expect(near(elapsed).collectingClearance).toBeCloseTo(
        NEAR_EDGE_WORST_GATE[elapsed] as number,
        1,
      )
    }
  })

  it('is never easier than the typical gate, and never free', () => {
    for (const r of NEAR) {
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
        Math.abs(near(elapsed).collectingClearance - row(elapsed).collectingClearance),
      ).toBeLessThan(0.1)
    }
  })

  /** And it does bite in phase 2, where the interval has closed up. */
  it('costs real clearance in phase 2', () => {
    for (const elapsed of [90, 150, 210, 270, ASYMPTOTE_CHECKPOINT]) {
      expect(near(elapsed).collectingClearance).toBeLessThan(row(elapsed).collectingClearance - 4)
    }
  })

  /**
   * `dt`'s bias has a sign, and it is the dangerous one. The column constraint
   * and the held clearance are *sampled* on the dt grid rather than solved, so
   * a coarse grid steps over near-misses and reports clearance the line never
   * holds. Every cell of both tables moved **down** when `dt` converged. A
   * model that errs optimistically is the wrong kind of model to grade a
   * reachability floor with, which is the argument §2.2's grid box makes for
   * paying for 1/8000.
   *
   * This is a claim about `dt` alone, and deliberately so: the switch grid's
   * bias runs the other way, and a statement about "the grid" that did not say
   * which knob is how the two came to be netted against each other in the first
   * place. See `is not converged in the switch grid` below.
   */
  it('errs optimistically when coarse, which is why the default had to move', () => {
    for (const elapsed of PUBLISHED_CHECKPOINTS) {
      const old = collectingCost(elapsed, { dt: 1 / 500, worstGate: true }).collectingClearance
      expect(old).toBeGreaterThan(NEAR_EDGE_WORST_GATE[elapsed] as number)
    }
  })
}, 180_000)

/**
 * **§2.3's criterion, on the collector v2.2 says it is about.**
 *
 * The exit state is an output of the definition rather than an input to it, so
 * the figure is a joint fixed point in (position, velocity) over the worst
 * legal *sequence* of sides. `SELF_CONSISTENT_WORST_GATE` is the derived row
 * and `pnpm feel:reach` is what produces it: one cell is an orbit iteration
 * inside a bisection inside a model evaluation, minutes apiece in phase 1, so
 * the constant is the pin and CI re-derives the one cell the verdict turns on.
 */
describe('the self-consistent collector (spec §2.3, derived)', () => {
  // The asymptote, solved once and shared. It is the binding cell — the course
  // is at its floors from t = 1200 s, so it is every gate of the rest of a run
  // of any length — and it is the one `worstGateTowardDelta` has fallen to zero
  // at, which is where this model is at its least conservative.
  const ASYMPTOTE = worstCycle(ASYMPTOTE_CHECKPOINT)

  it('pins the derived row at every published checkpoint, the asymptote included', () => {
    expect(Object.keys(SELF_CONSISTENT_WORST_GATE).map(Number)).toEqual([...PUBLISHED_CHECKPOINTS])
    for (const elapsed of PUBLISHED_CHECKPOINTS) {
      const derived = SELF_CONSISTENT_WORST_GATE[elapsed] as number
      // It is a sustained figure, so it cannot beat the collector that is
      // handed the previous gap's near edge for free.
      expect(derived).toBeLessThanOrEqual((NEAR_EDGE_WORST_GATE[elapsed] as number) + 0.1)
      expect(derived).toBeGreaterThan(0)
    }
  })

  /**
   * **The verdict, and it is a reachability failure.** Phase 1 and the knee at
   * t = 90 s clear their floors — the last of them by 0.4 px — and every cell
   * from t = 150 s on is under. At the asymptote, which is not a limit but
   * every gate of the rest of a run of any length, it is 8.5 against 12.0.
   *
   * A cell crossing its floor in *either* direction is a change of verdict and
   * goes to the CTO (§3), so this asserts the whole shape rather than only the
   * half that is currently true: it fails if a cell starts clearing just as
   * loudly as if one stops.
   */
  it('clears its floor to t = 90 s and fails it from t = 150 s on', () => {
    for (const elapsed of PUBLISHED_CHECKPOINTS) {
      const derived = SELF_CONSISTENT_WORST_GATE[elapsed] as number
      const clears = derived >= requiredFloor(elapsed)
      expect({ elapsed, clears }).toEqual({ elapsed, clears: elapsed <= 90 })
    }
  })

  /**
   * And the model still produces the pinned cell at the asymptote. Re-deriving
   * all eight here would be a quarter of an hour of CI for cells that clear by
   * 20 px; `pnpm feel:reach` is the command that does that.
   */
  it('re-derives the cell the verdict turns on', () => {
    expect(ASYMPTOTE.clearance).toBeCloseTo(
      SELF_CONSISTENT_WORST_GATE[ASYMPTOTE_CHECKPOINT] as number,
      0,
    )
    expect(ASYMPTOTE.clearance).toBeLessThan(requiredFloor(ASYMPTOTE_CHECKPOINT))
    // The ring is still collectable on the worst course; what fails is the
    // clearance, not the reach. A course the ring cannot be taken on at all
    // would be a different and larger finding.
    expect(ASYMPTOTE.collectable).toBe(true)
    // And it cannot beat the collector that is handed the previous gap's near
    // edge for free, which is the bracket the bisection runs inside — at this
    // checkpoint that is 12.2 px, against a floor of 12.0. For the derived cell
    // to clear, self-consistency would have to cost under a quarter of a pixel.
    const nearEdge = collectingCost(ASYMPTOTE_CHECKPOINT, { worstGate: true }).collectingClearance
    expect(ASYMPTOTE.clearance).toBeLessThanOrEqual(nearEdge)
    expect(nearEdge - requiredFloor(ASYMPTOTE_CHECKPOINT)).toBeLessThan(0.3)
  })

  /**
   * The exit velocity is the half of the ruling that is new, and the point of
   * deriving it is that it could have come out anywhere. It comes out **small
   * and frequently inward** — nothing like the ~100 px/s that "restores every
   * cell", and on the wrong side of zero as often as not.
   *
   * That is a statement about the line, not about the control: the model can
   * express an exit at any speed up to the clamp (`flyReturn`'s release phase),
   * and the orbit does not want one. A collector that leaves fast is a
   * collector that spent the traversal accelerating back out of the gap, and at
   * these gap heights it cannot afford the clearance that costs.
   */
  it('derives an exit velocity, and it is nowhere near the 100 px/s that rescues the cell', () => {
    expect(Math.abs(ASYMPTOTE.exit.velocity)).toBeLessThan(60)
    // Self-consistency on the position axis, which the orbit gets for free: the
    // exit is a point of the traversal, so a line holding C leaves at least C
    // inside the edge. This is the half the struck row fixed by hand, in the
    // generous direction.
    const safeHalfWidth = gapHeight(ASYMPTOTE_CHECKPOINT) / 2 - KITE_RADIUS
    expect(Math.abs(ASYMPTOTE.exit.offset)).toBeLessThanOrEqual(safeHalfWidth - ASYMPTOTE.clearance)
  })

  /**
   * The cycle searches coarser grids than the published tables do, because it
   * nests an orbit iteration and a bisection inside them. This is the control
   * that says the trade is free at the precision the row is reported to — one
   * checkpoint, at the published resolution on every axis at once.
   */
  it("the cycle's own grids are inert", () => {
    // Measured at a coarse `dt`, the way the switch-grid control below is. The
    // claim is about the *search* resolution — how finely the collect window,
    // the switch time and the approach bracket are swept — and it holds at any
    // integration step; pricing it at the published one is a six-minute
    // assertion about a quantity reported to a tenth of a pixel.
    const dt = 1 / 1000
    const coarse = worstCycle(ASYMPTOTE_CHECKPOINT, { dt }).clearance
    const fine = worstCycle(ASYMPTOTE_CHECKPOINT, {
      dt,
      cycleGrid: { dxStep: 1, approachDt: dt, switchSamples: 60, approachBrackets: 96 },
    }).clearance
    expect(Math.abs(coarse - fine)).toBeLessThan(0.3)
    // And the coarse grid is the coarse one, so the comparison is not two
    // names for the same run.
    expect(CYCLE_GRID.dxStep).toBeGreaterThan(1)
    expect(CYCLE_GRID.approachDt).toBeGreaterThan(1 / 8000)
    expect(CYCLE_GRID.switchSamples).toBeLessThan(60)
  })
}, 900_000)

describe('the model itself', () => {
  /**
   * The convergence check this replaces refined `dt` and `switchSamples`
   * together and ran balanced mode only, so it never covered the mode with the
   * pinned table (GOK-25, finding 2). Refined properly it moved a row by
   * 0.78 px.
   *
   * The original diagnosis — that it wasted its budget on a knob that does
   * nothing — was wrong, and the real reason is worse (GOK-26). Coarse `dt` is
   * optimistic and coarse `switchSamples` is pessimistic, provably so in both
   * cases, and refining them together **partly cancels them**. A joint check
   * does not merely dilute the signal; it subtracts it. That is why §3 requires
   * one knob at a time, and why there are now two tests here rather than one
   * and a dismissal.
   *
   * Three representative points rather than all eight, because the reference
   * grid is twice the work of the default: phase 1, the phase-2 knee where the
   * approach starts to bite, and the asymptote where the margin is thinnest.
   */
  const SPOTS = [0, 90, ASYMPTOTE_CHECKPOINT] as const

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
   * **The other knob is not inert, and the claim that it was is what this
   * replaces** (GOK-26).
   *
   * The test that used to sit here asserted that `switchSamples` carries none
   * of the error — and it ran `worstGate: true` at `dt = 1/4000`, which is the
   * one configuration in which that is true. Worst-gate `t ≥ 90` is the region
   * where the knob is *exactly* inert, and at `dt = 1/4000` the t = 0 cell
   * happens to read 0.0000 as well, so the only grid the check ever visited was
   * one nobody computes on. Same shape as GOK-25's finding 2, which this file
   * fixed for `dt`: a convergence check run somewhere other than the published
   * configuration.
   *
   * So this one runs at the **default `dt`, in both modes**, and asserts what
   * is actually true of the published grid — which is two different things in
   * two places, and both are worth pinning:
   *
   * - **Exactly inert where §2.3's verdict lives.** Every worst-gate phase-2
   *   cell is identical to the last bit under an eightfold refinement, the
   *   near-edge ceiling the self-consistent bisection brackets against
   *   included. Exact equality is the honest assertion here rather than a
   *   tolerance, because the grids nest: `{k/60} ⊂ {k/480}`, so the refinement
   *   maximises over a superset and either finds a strictly better switch time
   *   or returns the same float. A tolerance would hide the first case.
   * - **Not inert in the published §2.2 row**, which moves by more than the
   *   0.1 px `dt` is held to. That bound is pinned from both sides so the
   *   sensitivity cannot quietly grow *or* vanish: if it ever drops under
   *   0.1 px the switch grid has converged and §2.2's table should be re-read
   *   on it, which is as much a change of state as the reverse.
   *
   * The direction is pinned too, and it is provable rather than measured: a max
   * over a superset cannot fall, so refining can only raise the figure. Coarse
   * `switchSamples` is **pessimistic**, the opposite sign to `dt`'s bias — which
   * is the real reason the old refine-both-at-once check looked settled.
   */
  it('is not converged in the switch grid, and that is confined to §2.2', () => {
    // The floors, and the ceiling the derived row brackets against. These are
    // the cells a change here would have to move to change a verdict.
    for (const elapsed of [90, 150, 210, 270, ASYMPTOTE_CHECKPOINT]) {
      const coarse = collectingCost(elapsed, { worstGate: true }).collectingClearance
      const fine = collectingCost(elapsed, {
        worstGate: true,
        switchSamples: SWITCH_REFERENCE,
      }).collectingClearance
      expect(fine).toBe(coarse)
    }

    // And the published row, which does move.
    const shifts = SPOTS.map((elapsed) => {
      const coarse = collectingCost(elapsed).collectingClearance
      const fine = collectingCost(elapsed, { switchSamples: SWITCH_REFERENCE }).collectingClearance
      return fine - coarse
    })
    for (const shift of shifts) expect(shift).toBeGreaterThanOrEqual(0)
    expect(Math.max(...shifts)).toBeGreaterThan(0.1)
    expect(Math.max(...shifts)).toBeLessThan(0.6)
    // The reference is a bar, not a converged grid — it is a refinement of the
    // default and nothing more. See `SWITCH_REFERENCE`.
    expect(SWITCH_REFERENCE).toBeGreaterThan(60)
  })
}, 600_000)
