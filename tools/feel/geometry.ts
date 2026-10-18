/**
 * Is a thermal a decision, or a formality? Measured without an autopilot.
 *
 * The autopilot answers "what happens when someone plays". This file answers
 * the prior question, and it answers it from the course geometry alone, so no
 * controller of mine can flatter or libel the design.
 *
 * A thermal is only a *risk/reward* object if reaching it forces the kite
 * somewhere it would not otherwise go. Concretely, for a gate with gap
 * [gapY, gapY + h]:
 *
 *   safe band     = [gapY + KITE_RADIUS, gapY + h - KITE_RADIUS]
 *                   every y in here clears both columns
 *   collect band  = [thermal.y - (THERMAL_RADIUS + KITE_RADIUS),
 *                    thermal.y + (THERMAL_RADIUS + KITE_RADIUS)]
 *
 * If those two overlap, the ring can be taken from a position that was already
 * safe, and the "risk" is zero. The number that matters is how much of the safe
 * band also collects: at 100%, the thermal is not a choice at all, it is a
 * participation trophy.
 */

import {
  DIFFICULTY_RAMP_SECONDS,
  FIXED_DT,
  FIRST_GATE_DELAY,
  GAP_BASE,
  GAP_RANGE,
  GAP_Y_MIN,
  KITE_RADIUS,
  KITE_START_Y,
  THERMAL_EDGE_INSET,
  THERMAL_RADIUS,
} from '../../src/game/constants.js'
import { gapHeight, spawnInterval } from '../../src/game/difficulty.js'
import { gapCentre, spawnGate } from '../../src/game/spawner.js'
import { createRng } from '../../src/game/rng.js'
import type { Gate } from '../../src/game/state.js'

export interface GateGeometry {
  readonly elapsed: number
  /** Width (px) of the band of kite altitudes that clears both columns. */
  readonly safeBand: number
  /** Width (px) of that band which ALSO touches the thermal. */
  readonly freeCollect: number
  /** How far outside the safe band the ring's centre sits. <= 0 means it is inside. */
  readonly exposure: number
  /** Clearance (px) to the nearer column when flying the gap centre. */
  readonly clearanceOnCentre: number
  /** Clearance (px) to the nearer column at the best altitude that still collects. */
  readonly clearanceCollecting: number
  /**
   * Margin the player gives up to collect, in px: `clearanceOnCentre -
   * clearanceCollecting`.
   *
   * This, not `exposure`, is the number that decides whether the risk layer
   * exists. `exposure` asks "is collecting *possible* from safety", which the
   * proof below shows is always yes. The real question is what collecting
   * *costs*, and a cost of 0 means the safest line in the game already takes the
   * ring — at which point there was never a decision to make.
   */
  readonly marginCost: number
}

/** Measure one gate. */
export function measureGate(gate: Gate): Omit<GateGeometry, 'elapsed'> {
  const safeLow = gate.gapY + KITE_RADIUS
  const safeHigh = gate.gapY + gate.gapHeight - KITE_RADIUS
  const reach = THERMAL_RADIUS + KITE_RADIUS
  const collectLow = gate.thermal.y - reach
  const collectHigh = gate.thermal.y + reach

  const overlap = Math.max(0, Math.min(safeHigh, collectHigh) - Math.max(safeLow, collectLow))
  const edge = Math.min(gate.thermal.y - safeLow, safeHigh - gate.thermal.y)

  // Clearance is maximised at the gap centre and falls off linearly either way,
  // so the best collecting altitude is simply the point of the collect band
  // nearest the centre — clamped into the safe band, which the proof below shows
  // is never empty here.
  const centre = gate.gapY + gate.gapHeight / 2
  const best = Math.min(
    Math.max(Math.min(Math.max(centre, collectLow), collectHigh), safeLow),
    safeHigh,
  )
  const clearance = (y: number): number => Math.min(y - safeLow, safeHigh - y)

  return {
    safeBand: Math.max(0, safeHigh - safeLow),
    freeCollect: overlap,
    exposure: -edge,
    clearanceOnCentre: clearance(centre),
    clearanceCollecting: clearance(best),
    marginCost: clearance(centre) - clearance(best),
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

  // Step the spawn clock the way the simulation does, so gates land at the same
  // elapsed times and therefore the same gap heights.
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
 * Brute-force the claim that the risk layer cannot be rescued by retuning.
 *
 * The proof is two lines, but a proof I wrote about my own design is worth
 * checking against a machine. For a gate with gap [0, h], kite radius Rk and
 * thermal radius Rt:
 *
 *   survives  <=>  y in [Rk, h - Rk]
 *   thermal strictly inside the gap  =>  ty in [Rt, h - Rt]
 *   collects  <=>  |y - ty| <= Rt + Rk
 *
 * Let y* = clamp(ty, Rk, h - Rk) — a surviving position by construction. If
 * ty < Rk then |y* - ty| = Rk - ty <= Rk - Rt <= Rk + Rt, so y* collects.
 * Symmetrically at the top; otherwise y* = ty. So a safe collecting position
 * always exists, for every h, Rt, Rk and every placement rule. The inset does
 * not appear in the argument, which is exactly why retuning it cannot help.
 *
 * One precondition, stated because this proof is load-bearing for the whole
 * recommendation: it needs h >= 2*Rk, or the safe band is empty and clamping has
 * nothing to clamp into. UPDRAFT never gets near that — the ramp bottoms out at a
 * 150px gap against 2*Rk = 32px — and the sweep below skips those combinations
 * explicitly rather than counting them as safe.
 *
 * Returns the number of (h, Rt, ty) combinations that admit a risky thermal.
 * It should be 0.
 */
export function searchForRiskyPlacement(): { tested: number; risky: number } {
  let tested = 0
  let risky = 0
  const Rk = KITE_RADIUS
  for (let h = 100; h <= 300; h += 5) {
    // The proof's one precondition: below this the safe band is empty and the
    // gate is unflyable with or without a ring. Skipped rather than counted, so
    // `tested` is exactly the set the claim is made about.
    if (h < 2 * Rk) continue
    for (let Rt = 4; Rt <= 60; Rt += 2) {
      if (2 * Rt > h) continue
      for (let ty = Rt; ty <= h - Rt; ty += 1) {
        tested += 1
        const safeLow = Rk
        const safeHigh = h - Rk
        const nearest = Math.min(Math.max(ty, safeLow), safeHigh)
        // "Risky" would mean: no surviving altitude is close enough to collect.
        if (Math.abs(nearest - ty) > Rt + Rk) risky += 1
      }
    }
  }
  return { tested, risky }
}

/**
 * What collecting costs, across the whole difficulty ramp. Seed-independent:
 * it depends only on the gap height, which is a pure function of elapsed time.
 *
 * The shape of this table is the finding. The cost does not rise with
 * difficulty, it *falls* — and reaches exactly zero before the ramp finishes,
 * because the collect reach (THERMAL_RADIUS + KITE_RADIUS = 38) eventually
 * exceeds the ring's offset from the gap centre (h/2 - THERMAL_EDGE_INSET).
 * Past that point the safest line in the game collects the ring for free.
 */
export function costAcrossTheRamp(): string {
  const reach = THERMAL_RADIUS + KITE_RADIUS
  const rows = [0, 15, 30, 45, 60, 75, 90].map((elapsed) => {
    const h = gapHeight(elapsed)
    const offset = h / 2 - THERMAL_EDGE_INSET
    const onCentre = h / 2 - KITE_RADIUS
    const cost = Math.max(0, offset - reach)
    return [
      `  t=${`${elapsed}s`.padStart(4)}`,
      `gap ${h.toFixed(0).padStart(3)}px`,
      `margin on the centre line ${onCentre.toFixed(0).padStart(3)}px`,
      `cost to collect ${cost.toFixed(0).padStart(3)}px`,
      `(${((100 * cost) / onCentre).toFixed(0).padStart(3)}% of it)`,
    ].join('  ')
  })

  // h/2 - INSET = reach  =>  h = 2*(reach + INSET)
  const freeAt = 2 * (reach + THERMAL_EDGE_INSET)
  const p = (GAP_BASE - freeAt) / GAP_RANGE
  const when = p >= 1 ? null : p * DIFFICULTY_RAMP_SECONDS

  return [
    ...rows,
    '',
    `  The ring is touchable from ${reach}px away (THERMAL_RADIUS ${THERMAL_RADIUS} + KITE_RADIUS ${KITE_RADIUS})`,
    `  and sits h/2 - ${THERMAL_EDGE_INSET} from the gap centre, so the centre line collects it`,
    when === null
      ? `  at every gap height the ramp produces — the cost is always zero.`
      : `  outright once the gap is under ${freeAt.toFixed(0)}px, i.e. from t=${when.toFixed(0)}s onward.`,
    `  (GAP_Y_MIN ${GAP_Y_MIN} is irrelevant here — this is all gap-relative.)`,
  ].join('\n')
}

/**
 * At what nerve does a player start declining rings at all?
 *
 * The `opportunist` profile takes a ring only when the cheapest collecting line
 * still leaves it `riskTolerance` px of clearance to the nearer column. That
 * clearance is not a distribution — it is a closed form:
 *
 *   cheapest line = centre + sign * max(0, h/2 - INSET - reach)
 *   clearance     = min(h/2 - KITE_RADIUS, INSET + THERMAL_RADIUS)
 *
 * The gap height cancels out entirely in the second branch, so the clearance is a
 * flat INSET + THERMAL_RADIUS = 67px for most of the ramp and `h/2 -
 * KITE_RADIUS` (59px) once the gap is tight. So the "opportunist" is a step
 * function of its own tolerance: at or below the floor it is the collector, above
 * the ceiling it is the safe line, and only the sliver between them declines
 * selectively — and then only on the hardest gates.
 *
 * This is why quoting "a cautious player still takes 70% of rings" was an
 * identity rather than a measurement (GOK-14). The knee is the real statement.
 */
export function opportunistKnee(): {
  /** At or below this tolerance the opportunist declines nothing, at any difficulty. */
  readonly floor: number
  /** Above this tolerance it declines everything, at any difficulty. */
  readonly ceiling: number
  /** Gap height at which the clearance stops being flat and starts tracking h. */
  readonly tightensBelowGap: number
} {
  const clearanceOnCheapestLine = (h: number): number =>
    Math.min(h / 2 - KITE_RADIUS, THERMAL_EDGE_INSET + THERMAL_RADIUS)
  const over = [gapHeight(0), gapHeight(DIFFICULTY_RAMP_SECONDS)].map(clearanceOnCheapestLine)
  return {
    floor: Math.min(...over),
    ceiling: Math.max(...over),
    tightensBelowGap: 2 * (THERMAL_EDGE_INSET + THERMAL_RADIUS + KITE_RADIUS),
  }
}

/**
 * Could retuning rescue the risk layer, if "risky" is relaxed from *impossible
 * from safety* to merely *expensive*?
 *
 * `searchForRiskyPlacement` proves the strong form is unachievable. This asks
 * the weaker and more useful question: holding the signed-off invariant that the
 * ring sits strictly inside the gap, how much margin can any (inset, ring
 * radius) pair make collecting cost at maximum difficulty?
 *
 * Returns the best achievable cost and the pair that achieves it, so the
 * trade-off can be argued about with numbers instead of taste.
 */
export function bestAchievableCost(): {
  readonly gap: number
  readonly marginOnCentre: number
  readonly best: { inset: number; radius: number; cost: number; ringToColumn: number }
  readonly atCurrentRadius: { inset: number; cost: number; ringToColumn: number }
} {
  const h = gapHeight(DIFFICULTY_RAMP_SECONDS)
  const marginOnCentre = h / 2 - KITE_RADIUS

  let best = { inset: THERMAL_EDGE_INSET, radius: THERMAL_RADIUS, cost: -1, ringToColumn: 0 }
  let atCurrentRadius = { inset: THERMAL_EDGE_INSET, cost: -1, ringToColumn: 0 }

  for (let radius = 4; radius <= THERMAL_RADIUS; radius += 1) {
    const reach = radius + KITE_RADIUS
    // Strictly inside the gap requires inset > radius; a ring flush against the
    // column reads as part of the hazard, so insist on 4px of daylight.
    for (let inset = radius + 4; inset <= h / 2; inset += 1) {
      const cost = Math.max(0, h / 2 - inset - reach)
      const ringToColumn = inset - radius
      if (cost > best.cost) best = { inset, radius, cost, ringToColumn }
      if (radius === THERMAL_RADIUS && cost > atCurrentRadius.cost) {
        atCurrentRadius = { inset, cost, ringToColumn }
      }
    }
  }
  return { gap: h, marginOnCentre, best, atCurrentRadius }
}
