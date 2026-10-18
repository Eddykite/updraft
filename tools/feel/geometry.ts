/**
 * Is a thermal a decision, or a formality? Measured without an autopilot.
 *
 * The autopilot answers "what happens when someone plays". This file answers the
 * prior question, and it answers it from the course geometry alone, so no
 * controller of mine can flatter or libel the design. That division of labour is
 * not academic: in the first round of feel tuning (GOK-5) the controller's
 * numbers were wrong three different ways and this file's were right, which is
 * why the recommendation ended up resting here.
 *
 * A thermal is only a *risk/reward* object if reaching it forces the kite
 * somewhere it would not otherwise go. For a gate with gap [gapY, gapY + h]:
 *
 *   safe band     = [gapY + KITE_RADIUS, gapY + h - KITE_RADIUS]
 *                   every y in here clears both columns
 *   collect band  = [thermal.y - (THERMAL_RADIUS + KITE_RADIUS),
 *                    thermal.y + (THERMAL_RADIUS + KITE_RADIUS)]
 *
 * Under the old placement — ring strictly *inside* the gap — those two bands
 * always overlapped, for every gap height and every ring radius, and past t=77s
 * the gap's own centre line collected the ring outright. That is the finding that
 * got the spec revised.
 *
 * Under the revised placement they are provably disjoint, by exactly
 * `THERMAL_OUTSIDE_OFFSET - THERMAL_RADIUS` px. `searchForFreeCollect` sweeps
 * both sides of that threshold rather than only confirming today's value, so the
 * table below says *why* the layer works and not merely that it currently does.
 */

import {
  FIXED_DT,
  FIRST_GATE_DELAY,
  GATE_WIDTH,
  KITE_RADIUS,
  KITE_START_Y,
  NET_LIFT_ACCEL,
  THERMAL_LEAD_X,
  THERMAL_OUTSIDE_OFFSET,
  THERMAL_RADIUS,
} from '../../src/game/constants.js'
import { gapHeight, scrollSpeed, spawnInterval } from '../../src/game/difficulty.js'
import { gapCentre, reach, spawnGate } from '../../src/game/spawner.js'
import { createRng } from '../../src/game/rng.js'
import type { Gate } from '../../src/game/state.js'

/** How close the kite's centre has to get to a ring's centre to take it. */
export const COLLECT_REACH = THERMAL_RADIUS + KITE_RADIUS

export interface GateGeometry {
  readonly elapsed: number
  /** Width (px) of the band of kite altitudes that clears both columns. */
  readonly safeBand: number
  /** Width (px) of that band which ALSO touches the thermal. Zero is the point. */
  readonly freeCollect: number
  /**
   * How far outside the safe band the *nearest* collecting altitude sits, in px.
   *
   * This is the whole mechanic in one number. It is `THERMAL_OUTSIDE_OFFSET -
   * THERMAL_RADIUS` on every gate at every difficulty — the gap height cancels —
   * so collecting is never free and never gets freer as the ramp tightens. Under
   * the old placement this quantity was negative everywhere.
   */
  readonly excursion: number
  /** Clearance (px) to the nearer column when flying the gap centre. */
  readonly clearanceOnCentre: number
}

/** Measure one gate's placement. Seed-dependent only through the gap height. */
export function measureGate(gate: Gate): Omit<GateGeometry, 'elapsed'> {
  const safeLow = gate.gapY + KITE_RADIUS
  const safeHigh = gate.gapY + gate.gapHeight - KITE_RADIUS
  const collectLow = gate.thermal.y - COLLECT_REACH
  const collectHigh = gate.thermal.y + COLLECT_REACH

  const centre = gate.gapY + gate.gapHeight / 2
  const offsetFromCentre = Math.abs(gate.thermal.y - centre)

  return {
    safeBand: Math.max(0, safeHigh - safeLow),
    freeCollect: Math.max(0, Math.min(safeHigh, collectHigh) - Math.max(safeLow, collectLow)),
    excursion: offsetFromCentre - COLLECT_REACH - (gate.gapHeight / 2 - KITE_RADIUS),
    clearanceOnCentre: gate.gapHeight / 2 - KITE_RADIUS,
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
 * Brute-force the threshold the whole mechanic turns on.
 *
 * For a gap [0, h], kite radius Rk, ring radius Rt and a ring placed `Q` px
 * beyond a gap edge (so `ty = -Q` or `h + Q`; negative Q puts it back inside):
 *
 *   survives  <=>  y in [Rk, h - Rk]
 *   collects  <=>  |y - ty| <= Rt + Rk
 *
 * The nearest surviving altitude to the ring is `clamp(ty, Rk, h - Rk)`, at
 * distance `Q + Rk` from it, so a safe altitude collects exactly when
 * `Q + Rk <= Rt + Rk`, i.e. **Q <= Rt**. One inequality, no h in it, which is why
 * no retune of a placement inside the gap could ever have produced a risk layer
 * and why moving the ring outside it is enough on its own.
 *
 * The sweep runs both sides of the threshold: every combination with `Q <= Rt`
 * must admit a free collect and every combination with `Q > Rt` must not. A sweep
 * that only checked today's constants would pass just as happily if the
 * inequality were an accident.
 *
 * One precondition, stated because this is load-bearing: `h >= 2*Rk`, or the safe
 * band is empty and the clamp has nothing to clamp into. UPDRAFT never gets near
 * it — the ramp bottoms out at a 150px gap against 2*Rk = 32px — and those
 * combinations are skipped rather than counted.
 */
export function searchForFreeCollect(): {
  tested: number
  /** Combinations with the ring inside the gap (Q <= Rt) where NO safe altitude collects. */
  riskyInside: number
  /** Combinations with the ring outside the gap (Q > Rt) where a safe altitude DOES collect. */
  freeOutside: number
} {
  let tested = 0
  let riskyInside = 0
  let freeOutside = 0
  const Rk = KITE_RADIUS
  for (let h = 100; h <= 300; h += 5) {
    if (h < 2 * Rk) continue
    for (let Rt = 4; Rt <= 60; Rt += 2) {
      // Q < 0 is the old placement (ring inside the gap, |Q| from the edge);
      // Q > 0 is the revised one. Both halves of the threshold get swept.
      for (let Q = -Math.max(0, Math.floor(h / 2 - Rt)); Q <= 120; Q += 1) {
        tested += 1
        const ty = h + Q
        const nearestSafe = Math.min(Math.max(ty, Rk), h - Rk)
        const collectsFromSafety = Math.abs(nearestSafe - ty) <= Rt + Rk
        if (Q <= Rt && !collectsFromSafety) riskyInside += 1
        if (Q > Rt && collectsFromSafety) freeOutside += 1
      }
    }
  }
  return { tested, riskyInside, freeOutside }
}

/**
 * What collecting costs, across the whole difficulty ramp. Seed-independent: it
 * depends only on the gap height and the scroll speed, both pure functions of
 * elapsed time.
 *
 * The shape of this table is the finding, and it is the opposite of the one the
 * old placement produced. The excursion is constant — the `h/2` cancels — while
 * the time to pay it back shrinks with the scroll speed, so the manoeuvre gets
 * harder exactly as the game gets harder.
 */
export function costAcrossTheRamp(): string {
  const rows = [0, 15, 30, 45, 60, 75, 90].map((elapsed) => {
    const h = gapHeight(elapsed)
    const onCentre = h / 2 - KITE_RADIUS
    const trip = roundTrip(elapsed, DIP_DEPTHS.collector)
    return [
      `  t=${`${elapsed}s`.padStart(4)}`,
      `gap ${h.toFixed(0).padStart(3)}px`,
      `safe band +-${onCentre.toFixed(0).padStart(3)}px`,
      `dip to ${(h / 2 + THERMAL_OUTSIDE_OFFSET - DIP_DEPTHS.collector).toFixed(0).padStart(3)}px off the centre`,
      `(${trip.excursion.toFixed(0)}px past the edge)`,
      `worst-case approach ${trip.approach.capable.toFixed(0).padStart(3)}px / back ${trip.recovery.capable.toFixed(0).padStart(3)}px`,
      `vs ${trip.travel.toFixed(0)}px needed`,
    ].join('  ')
  })

  return [
    ...rows,
    '',
    `  The ring is touchable from ${COLLECT_REACH}px away (THERMAL_RADIUS ${THERMAL_RADIUS} + KITE_RADIUS ${KITE_RADIUS})`,
    `  and sits h/2 + ${THERMAL_OUTSIDE_OFFSET} from the gap centre, so the nearest altitude that collects it`,
    `  is outside the safe band by ${THERMAL_OUTSIDE_OFFSET - THERMAL_RADIUS}px at every gap height the ramp produces.`,
    `  The gap height cancels: there is no point on the ramp at which this gets cheaper.`,
    `  The two capability columns are the worst case — two consecutive gaps exactly level,`,
    `  so the approach is the full excursion from a standing lean. The ring hangs off the`,
    `  edge the kite is coming from, so in a real course the previous gap is usually already`,
    `  part of the way there and the approach is cheaper than this. Compare the autopilot.`,
  ].join('\n')
}

/**
 * The three dip depths the autopilot flies, in px short of the ring's centre.
 *
 * Stated here as plain numbers rather than derived from the slack model below,
 * deliberately. If the collector's line were computed by the same formula that
 * then judges it, "the collector survives" would be partly a measurement of my
 * own arithmetic — which is exactly the failure mode the GOK-14 review found in
 * the first version of this instrument. These are three fixed lines; the model
 * describes them, it does not choose them.
 */
export const DIP_DEPTHS = {
  /** Commit to the ring's centre. Widest contact window, longest way back. */
  greedy: 0,
  /** Half way into the collect band. Still a 33px contact window. */
  collector: COLLECT_REACH / 2,
  /** The very edge of the collect band: shortest trip, and contact only at dx = 0. */
  skimmer: COLLECT_REACH,
} as const

/**
 * What the round trip to a ring costs and what the kite can afford, as a closed
 * form. The thing the whole mechanic has to fit inside.
 *
 * The budget is the open air between two gates. Writing S for the distance
 * between consecutive gates' leading edges, the kite is clear of the first gate's
 * columns and not yet into the second's for `S - GATE_WIDTH - 2*KITE_RADIUS` px
 * of scroll, and THERMAL_LEAD_X decides how that is split between going out and
 * coming back. `S = speed(p)·interval(p)`, less one frame of spawn jitter.
 *
 * Dipping `d` px short of the ring's centre, with R = COLLECT_REACH and
 * Q = THERMAL_OUTSIDE_OFFSET:
 *
 *   approach  S - THERMAL_LEAD_X - 86 - sqrt(R² - d²) px, to cover Q + Rk - d
 *   recovery  THERMAL_LEAD_X - 16 + sqrt(R² - d²)     px, to cover Q + Rk - d
 *
 * The two legs need the same travel and share a fixed budget, which is what makes
 * THERMAL_LEAD_X a real choice rather than a free parameter. The approach is
 * measured against `reach` — the spawner's own settle-and-arrive distance, since
 * the kite has to *stop* at the dip — and the recovery against free acceleration,
 * since it only has to be back inside the band, not settled there.
 *
 * Conservative in three ways, all of which make the real window wider than this
 * says: it climbs at NET_LIFT_ACCEL rather than falling at the stronger GRAVITY,
 * it throws away the vertical speed the kite carries through the dip, and it takes
 * the two consecutive gaps as exactly level. That last one is the big one now that
 * the ring hangs off the edge the kite approaches from (`approachesFromBelow` in
 * spawner.ts): level gaps are the one case where the ring is a pure excursion, and
 * every other case hands the kite part of the approach for free. So the slack here
 * goes negative at both ends of the ramp while the autopilot's frame-perfect
 * collector still takes every ring. It is a lower bound on the worst case, not a
 * prediction of what a player does — that is what the autopilot is for.
 */
export function roundTrip(
  elapsed: number,
  depth: number,
): {
  readonly elapsed: number
  readonly speed: number
  /** px between consecutive gates' leading edges at this difficulty. */
  readonly spacing: number
  /** px outside the safe band the nearest collecting altitude sits. */
  readonly excursion: number
  /** px of travel each leg of the trip asks for. */
  readonly travel: number
  /** px of scroll the ring stays within reach for. Zero at the band's edge. */
  readonly contactWindow: number
  readonly approach: { readonly scroll: number; readonly capable: number }
  readonly recovery: { readonly scroll: number; readonly capable: number }
  /** The tighter of the two legs: capability minus what it has to cover. */
  readonly slack: number
} {
  const speed = scrollSpeed(elapsed)
  const spacing = speed * spawnInterval(elapsed) - speed * FIXED_DT
  const closing = Math.sqrt(Math.max(0, COLLECT_REACH ** 2 - depth * depth))
  const travel = THERMAL_OUTSIDE_OFFSET + KITE_RADIUS - depth

  const approachScroll = spacing - THERMAL_LEAD_X - (GATE_WIDTH + 2 * KITE_RADIUS) - closing
  const recoveryScroll = THERMAL_LEAD_X - KITE_RADIUS + closing
  const approachCapable = reach(Math.max(0, approachScroll) / speed)
  const recoveryTime = Math.max(0, recoveryScroll) / speed
  const recoveryCapable = (NET_LIFT_ACCEL * recoveryTime * recoveryTime) / 2

  return {
    elapsed,
    speed,
    spacing,
    excursion: THERMAL_OUTSIDE_OFFSET - THERMAL_RADIUS,
    travel,
    contactWindow: 2 * closing,
    approach: { scroll: approachScroll, capable: approachCapable },
    recovery: { scroll: recoveryScroll, capable: recoveryCapable },
    slack: Math.min(approachCapable, recoveryCapable) - travel,
  }
}
