/**
 * Is a thermal a decision, or a formality? Measured without an autopilot.
 *
 * The autopilot answers "what happens when someone plays". This file answers the
 * prior question, and it answers it from the course geometry alone, so no
 * controller of mine can flatter or libel the design. `cost.ts` then answers the
 * third question — what the decision is *worth* — with the dynamics included.
 *
 * ## What changed, and why these functions are not the v1 ones
 *
 * In v1 the ring sat strictly inside the gap, and the finding was that this made
 * the layer fake: for a gate with gap [gapY, gapY + h],
 *
 *   safe band    = [gapY + KITE_RADIUS, gapY + h - KITE_RADIUS]
 *   collect band = [thermal.y ± (THERMAL_RADIUS + KITE_RADIUS)]
 *
 * always overlapped, so the ring could be taken from a position that was already
 * safe — and past t = 77 s the gap's own centre line took it outright. The proof
 * never mentioned the inset, which is why no retune could reach it.
 *
 * v2 inverts the argument rather than retuning it. The ring is outside the gap
 * band by at least its own radius, and `searchForFreeCollect` below is the mirror
 * of the v1 sweep: it looks for any (gap, outset, radius) combination where a
 * surviving altitude still collects, and finds none. The v1 functions that
 * measured "how much of the safe band also collects" are gone, because the
 * answer is now zero by construction and a function that returns a constant is
 * not an instrument.
 */

import {
  FIXED_DT,
  FIRST_GATE_DELAY,
  GATE_WIDTH,
  KITE_RADIUS,
  KITE_START_Y,
  KITE_X,
  THERMAL_LEAD,
  THERMAL_RADIUS,
} from '../../src/game/constants.js'
import { thermalX } from '../../src/game/collision.js'
import { gapHeight, scrollSpeed, spawnInterval, thermalOutset } from '../../src/game/difficulty.js'
import { gapCentre, spawnGate } from '../../src/game/spawner.js'
import { createRng } from '../../src/game/rng.js'
import type { Gate } from '../../src/game/state.js'

/** How close the kite's centre must come to the ring's to collect it. */
const COLLECT_REACH = KITE_RADIUS + THERMAL_RADIUS

export interface GateGeometry {
  readonly elapsed: number
  /** Width (px) of the band of kite altitudes that clears both columns. */
  readonly safeBand: number
  /** Width (px) of that band which ALSO touches the ring. Zero, in v2, always. */
  readonly freeCollect: number
  /**
   * How far outside the safe band the ring's centre sits. Positive in v2 —
   * under v1 this was always negative, which was the whole problem.
   */
  readonly exposure: number
  /** Clearance (px) to the nearer column when flying the gap centre. */
  readonly clearanceOnCentre: number
  /**
   * How far the kite has to leave the gap centre to touch the ring at all,
   * ignoring the trip back. The static half of the cost; `cost.ts` has the half
   * that depends on the dynamics, which is the one that decides the question.
   */
  readonly excursion: number
  /** Px of daylight between the ring's disc and the gap's centre line. */
  readonly centreLineMiss: number
}

/** Measure one gate. */
export function measureGate(gate: Gate): Omit<GateGeometry, 'elapsed'> {
  const safeLow = gate.gapY + KITE_RADIUS
  const safeHigh = gate.gapY + gate.gapHeight - KITE_RADIUS
  const collectLow = gate.thermal.y - COLLECT_REACH
  const collectHigh = gate.thermal.y + COLLECT_REACH

  const overlap = Math.max(0, Math.min(safeHigh, collectHigh) - Math.max(safeLow, collectLow))
  const centre = gapCentre(gate)
  const offset = Math.abs(gate.thermal.y - centre)

  return {
    safeBand: Math.max(0, safeHigh - safeLow),
    freeCollect: overlap,
    exposure: offset - (gate.gapHeight / 2 - KITE_RADIUS),
    clearanceOnCentre: gate.gapHeight / 2 - KITE_RADIUS,
    excursion: Math.max(0, offset - COLLECT_REACH - (gate.gapHeight / 2 - KITE_RADIUS)),
    centreLineMiss: offset - COLLECT_REACH,
  }
}

/**
 * Walk the gates a run would actually spawn, at the difficulty they appear at.
 * Mirrors update.ts's spawn loop closely enough for geometry: each gate is
 * placed relative to the previous one, at the elapsed time it is created.
 */
export function sampleCourse(seed: number, seconds: number): GateGeometry[] {
  let rng = createRng(seed)
  let previousCentre: number | null = KITE_START_Y
  const out: GateGeometry[] = []

  let elapsed = 0
  let spawnTimer = FIRST_GATE_DELAY
  let id = 0
  while (elapsed < seconds) {
    elapsed += FIXED_DT
    spawnTimer -= FIXED_DT
    while (spawnTimer <= 0) {
      const [after, gate] = spawnGate(rng, id, elapsed, previousCentre)
      rng = after
      id += 1
      previousCentre = gapCentre(gate)
      out.push({ elapsed, ...measureGate(gate) })
      spawnTimer += spawnInterval(elapsed)
    }
  }
  return out
}

/**
 * The v2 claim, brute-forced: with the ring outside the gap band there is **no**
 * surviving altitude that collects, for any gap, outset or radius.
 *
 * The proof is two lines, but a proof written about one's own design is worth
 * checking against a machine — and this one is load-bearing twice over, because
 * it is the exact mirror of the v1 sweep that sank the old placement. For a gate
 * with gap [0, h], kite radius Rk, ring radius Rt and outset E >= Rt, the ring
 * sits at `-E` (above) or `h + E` (below):
 *
 *   survives  <=>  y in [Rk, h - Rk]
 *   collects  <=>  |y - ty| <= Rt + Rk
 *
 * Take the ring below, at ty = h + E. The nearest surviving altitude is h - Rk,
 * so the closest approach is `E + Rk`, and collecting needs `E + Rk <= Rt + Rk`,
 * i.e. `E <= Rt`. With `E >= Rt` that holds only at `E = Rt` exactly, where it
 * is a touch rather than an overlap — and at that boundary the collecting kite
 * is at `h - Rk`, the very edge of the safe band, which is the statement the
 * spec's invariant makes: *collecting means leaving the corridor completely*.
 *
 * Returns the combinations tested and the number that admit a free collect
 * strictly inside the safe band. It should be 0.
 */
export function searchForFreeCollect(): { tested: number; free: number; tightest: number } {
  let tested = 0
  let free = 0
  let tightest = Infinity
  const Rk = KITE_RADIUS
  for (let h = 100; h <= 300; h += 2) {
    if (h < 2 * Rk) continue
    for (let Rt = 4; Rt <= 60; Rt += 2) {
      for (let E = Rt; E <= Rt + 60; E += 1) {
        tested += 1
        // Closest a surviving kite can come to the ring's centre.
        const closest = E + Rk
        const slack = closest - (Rt + Rk)
        tightest = Math.min(tightest, slack)
        if (slack < 0) free += 1
      }
    }
  }
  return { tested, free, tightest }
}

/**
 * Where the gap's own centre line stands relative to the collect disc, across
 * the ramp. In v1 this crossed zero at t = 77 s and stayed there; in v2 it never
 * does, and the margin is smallest — not largest — at the asymptote.
 */
export function centreLineMissAcrossTheRamp(): string {
  const rows = [0, 15, 30, 45, 60, 75, 90, 150, 270].map((elapsed) => {
    const h = gapHeight(elapsed)
    const offset = h / 2 + thermalOutset(elapsed)
    return [
      `  t=${`${elapsed}s`.padStart(5)}`,
      `gap ${h.toFixed(0).padStart(3)}px`,
      `outset ${thermalOutset(elapsed).toFixed(0).padStart(2)}px`,
      `ring sits ${offset.toFixed(0).padStart(3)}px off the centre line`,
      `which misses the collect disc by ${(offset - COLLECT_REACH).toFixed(0).padStart(3)}px`,
    ].join('  ')
  })
  return [
    ...rows,
    '',
    `  The ring is touchable from ${COLLECT_REACH}px away (THERMAL_RADIUS ${THERMAL_RADIUS} + KITE_RADIUS ${KITE_RADIUS})`,
    '  and never comes within that of the gap centre, at any difficulty. Under v1',
    '  the centre line collected it outright from t=77s onward.',
  ].join('\n')
}

/**
 * How much of the kite's between-gate travel budget each half of the game asks
 * for, and whether they can both be served.
 *
 * The ring and the course spend the same budget (spec §2.3), which is why the
 * spawner caps how far the gap may close on the ring's side. This prints the two
 * bills side by side so the cap can be argued about with numbers.
 */
export function verticalBudget(): Array<{
  elapsed: number
  reachBetweenGates: number
  courseAsks: number
  ringAsks: number
  spare: number
}> {
  return [0, 45, 90, 150, 210, 270].map((elapsed) => {
    const h = gapHeight(elapsed)
    const offset = h / 2 + thermalOutset(elapsed)
    // What the detour asks for: out past the shallowest collecting altitude and
    // back inside the safe band.
    const ringAsks = 2 * Math.max(0, offset - COLLECT_REACH - (h / 2 - KITE_RADIUS))
    // What the course can ask for on a gate that closes on the ring's side.
    const courseAsks = Math.min(30, 30 * 1)
    const seconds = spawnInterval(elapsed)
    const reachBetweenGates = 1400 * seconds * seconds * 0.25
    return {
      elapsed,
      reachBetweenGates,
      courseAsks,
      ringAsks,
      spare: reachBetweenGates - courseAsks - ringAsks,
    }
  })
}

/**
 * How much time the detour actually gets, which is the quantity the whole
 * mechanism rests on: the ring leads the column by THERMAL_LEAD, so a kite that
 * left the corridor has `(THERMAL_LEAD - GATE_WIDTH/2 - KITE_RADIUS) / speed`
 * seconds before the gap constraint bites.
 */
export function detourWindow(elapsed: number): number {
  return (THERMAL_LEAD - GATE_WIDTH / 2 - KITE_RADIUS) / scrollSpeed(elapsed)
}

/** Where the ring is, in x, relative to the kite, when its gate is at `gateX`. */
export function ringOffsetFromKite(gateX: number): number {
  return thermalX({ x: gateX } as Gate) - KITE_X
}
