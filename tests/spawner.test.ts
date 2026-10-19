import { describe, expect, it } from 'vitest'
import {
  DIFFICULTY_RAMP_SECONDS,
  FIRST_GATE_DELAY,
  GAP_Y_MAX_EDGE,
  GAP_Y_MIN,
  GATE_SPAWN_X,
  GATE_WIDTH,
  KITE_RADIUS,
  KITE_START_Y,
  MAX_CENTRE_DELTA_MAX,
  MAX_CENTRE_DELTA_MIN,
  NET_LIFT_ACCEL,
  REACH_HEADROOM,
  THERMAL_RADIUS,
  THERMAL_TOWARD_DELTA,
  THERMAL_Y_MAX,
  THERMAL_Y_MIN,
  VY_CLAMP,
} from '../src/game/constants.js'
import { thermalX } from '../src/game/collision.js'
import {
  gapHeight,
  scrollSpeed,
  secondProgress,
  spawnInterval,
  thermalOutset,
} from '../src/game/difficulty.js'
import { createRng } from '../src/game/rng.js'
import {
  gapCentre,
  magnitudeFloor,
  maxCentre,
  maxCentreDelta,
  minCentre,
  reach,
  spawnGate,
  thermalTowardDelta,
} from '../src/game/spawner.js'
import type { Gate } from '../src/game/state.js'

/**
 * Spawner (spec §3).
 *
 * The headline test is the property test at the bottom: 10,000 seeds, and the
 * five invariants that replace v1's single *every thermal sits strictly inside
 * its gap*. That one assertion was the premise of the proof on GOK-14 that the
 * risk layer was fake; its mirror is what makes the layer real.
 *
 * **It now runs the whole ramp, not the first 45 s of it.** v1's 40 gates per
 * seed was commented as covering "the whole difficulty ramp and out the far
 * side", which was true while the ramp stopped at 90 s and stops being true the
 * moment it does not. Covering to 300 s is 8.5x the gates — and measures out at
 * about two seconds, so there was never a reason to buy coverage with a targeted
 * sweep instead.
 */

const SEEDS = 10_000
/**
 * Out past the last published checkpoint (t = 270 s), so every seed flies the
 * whole of phase 1, the junction, and three and a half half-lives of phase 2.
 */
const SECONDS_PER_SEED = 300

/** The reach a kite has to the ring, and to a thermal it should never reach. */
const COLLECT_REACH = KITE_RADIUS + THERMAL_RADIUS

/**
 * Generate one seed's course on exactly the schedule update.ts spawns on: the
 * first gate at FIRST_GATE_DELAY placed relative to where the kite starts, then
 * one gate every spawnInterval(elapsed).
 */
function course(seed: number, seconds: number): Array<{ gate: Gate; elapsed: number }> {
  let rng = createRng(seed)
  let elapsed = FIRST_GATE_DELAY
  let previousCentre: number | null = KITE_START_Y
  const gates: Array<{ gate: Gate; elapsed: number }> = []

  for (let id = 0; elapsed < seconds; id += 1) {
    const [next, gate] = spawnGate(rng, id, elapsed, previousCentre)
    rng = next
    gates.push({ gate, elapsed })
    previousCentre = gapCentre(gate)
    elapsed += spawnInterval(elapsed)
  }
  return gates
}

describe('reach', () => {
  it('is zero for no time at all', () => {
    expect(reach(0)).toBe(0)
    expect(reach(-1)).toBe(0)
  })

  it('is the triangular profile below the speed clamp', () => {
    // The kite only reaches the clamp after 2·vmax/a = 0.8 s of accelerating.
    const t = 0.5
    expect(t).toBeLessThan((2 * VY_CLAMP) / NET_LIFT_ACCEL)
    expect(reach(t)).toBeCloseTo((NET_LIFT_ACCEL * t * t) / 4, 9)
    expect(reach(t)).toBeCloseTo(87.5, 9)
  })

  it('is the trapezoidal profile above the speed clamp', () => {
    const t = 1.5
    expect(t).toBeGreaterThan((2 * VY_CLAMP) / NET_LIFT_ACCEL)
    expect(reach(t)).toBeCloseTo(VY_CLAMP * t - (VY_CLAMP * VY_CLAMP) / NET_LIFT_ACCEL, 9)
    expect(reach(t)).toBeCloseTo(616, 9)
  })

  it('is continuous where the two profiles meet', () => {
    const t = (2 * VY_CLAMP) / NET_LIFT_ACCEL
    expect(reach(t)).toBeCloseTo(224, 9)
    expect(reach(t - 1e-9)).toBeCloseTo(reach(t + 1e-9), 5)
  })

  it('is strictly increasing in time', () => {
    for (let t = 0.05; t < 4; t += 0.05) expect(reach(t + 0.05)).toBeGreaterThan(reach(t))
  })
})

describe('maxCentreDelta', () => {
  it('is half the reach, clamped into [60, 420]', () => {
    expect(maxCentreDelta(0)).toBe(MAX_CENTRE_DELTA_MIN)
    expect(maxCentreDelta(100)).toBe(MAX_CENTRE_DELTA_MAX)
    const t = 1.2
    expect(maxCentreDelta(t)).toBeCloseTo(REACH_HEADROOM * reach(t), 9)
  })

  /**
   * The v1 bug this constant carried, stated as a test rather than a comment.
   *
   * A clamp is a guard; the moment it starts *raising* the permitted jump above
   * what the formula allows, it has become the hazard it was guarding against.
   * At 120 that happens below T = 0.828 s — which v1 never reached and v2 does,
   * from about t = 124 s. At 60 it binds only below T = 0.586 s, under the
   * interval floor, so it is inert for every interval the game can ask for.
   */
  it('never overrides the formula at any interval the ramp can produce', () => {
    for (let t = 0; t <= 3600; t += 10) {
      const interval = spawnInterval(t)
      expect(maxCentreDelta(interval)).toBeCloseTo(REACH_HEADROOM * reach(interval), 9)
    }
    // And the floor is where it is for a reason: at v1's 120 this fails.
    expect(REACH_HEADROOM * reach(spawnInterval(3600))).toBeGreaterThan(MAX_CENTRE_DELTA_MIN)
    expect(REACH_HEADROOM * reach(spawnInterval(3600))).toBeLessThan(120)
  })

  it('leaves real headroom across both ramps', () => {
    for (const t of [0, 45, 90, 150, 210, 270, 600]) {
      const interval = spawnInterval(t)
      expect(maxCentreDelta(interval)).toBeLessThan(reach(interval))
    }
  })

  /** The gap floor's derivation (spec §2.4) depends on this number being 80.9. */
  it('is 80.9 px at the interval floor, which is what sets the 110 px gap', () => {
    expect(maxCentreDelta(1.6 - 0.7 - 0.22)).toBeCloseTo(80.9, 1)
  })
})

describe('thermalTowardDelta', () => {
  it('is a flat 30 px for the whole of phase 1 and shrinks to nothing after it', () => {
    for (const t of [0, 45, 90]) expect(thermalTowardDelta(t)).toBeCloseTo(THERMAL_TOWARD_DELTA, 9)
    expect(thermalTowardDelta(150)).toBeCloseTo(15, 9)
    expect(thermalTowardDelta(210)).toBeCloseTo(7.5, 9)
    expect(thermalTowardDelta(600)).toBeLessThan(0.1)
    expect(thermalTowardDelta(600)).toBeGreaterThan(0)
  })
})

describe('the magnitude rule (spec §2.3, new in v2.1)', () => {
  /**
   * The inertness that earns phase 1 its exemption, asserted on the range
   * itself rather than inferred from a sample.
   *
   * This is the load-bearing property of the whole rule: it is what lets §2.2's
   * cost table, the teaching ramp and the golden replay stay untouched by a
   * change to the generator. The golden file is the second, independent check —
   * it dies at t = 50.6 s and still passes bit for bit, trajectory checksum
   * included, which it could not do if the floor were nonzero anywhere before
   * then.
   */
  it('is exactly inert for every t in phase 1', () => {
    for (let t = 0; t <= DIFFICULTY_RAMP_SECONDS; t += 0.25) {
      expect(magnitudeFloor(t, false, 100)).toBe(0)
      expect(magnitudeFloor(t, true, 100)).toBe(0)
    }
  })

  /**
   * And in phase 2 it closes on the cap, reaching it only in the limit — the
   * hardest legal gate becomes the one the course approaches rather than an
   * outlier it occasionally rolls.
   */
  it('closes the away-range on the cap as phase 2 tightens, and never reaches it', () => {
    const cap = 100
    expect(magnitudeFloor(150, false, cap)).toBeCloseTo(50, 9)
    expect(magnitudeFloor(210, false, cap)).toBeCloseTo(75, 9)
    expect(magnitudeFloor(270, false, cap)).toBeCloseTo(87.5, 9)
    // t = 600 s is 8.5 half-lives into phase 2: q = 1 - 2^-8.5 = 0.99724, so
    // the away-range has closed to the last 0.28% of the cap and is still
    // closing. It approaches the cap and, in exact arithmetic, never arrives.
    expect(magnitudeFloor(600, false, cap)).toBeLessThan(cap)
    expect(magnitudeFloor(600, false, cap)).toBeCloseTo(99.72, 2)
    // A toward-move keeps the full range at every difficulty.
    for (const t of [0, 90, 150, 600]) expect(magnitudeFloor(t, true, cap)).toBe(0)
  })

  /** Monotone in t, like everything else the ramp drives. */
  it('never loosens as the run goes on', () => {
    for (let t = 0; t < 600; t += 1) {
      expect(magnitudeFloor(t + 1, false, 100)).toBeGreaterThanOrEqual(
        magnitudeFloor(t, false, 100),
      )
    }
  })
})

describe('the legal centre band', () => {
  /**
   * The lemma of spec §2.3: the band is non-empty iff h + 2E <= 800, and the
   * maximum of h + 2E over the whole ramp is 412, at t = 0. Both sides of the
   * gap therefore always have room for a ring, which is what lets the side stay
   * a fair coin at every difficulty rather than being quietly biased on tight
   * gates.
   */
  it('is never empty, and by a factor of two', () => {
    for (let t = 0; t <= 3600; t += 5) {
      const h = gapHeight(t)
      const outset = thermalOutset(t)
      expect(h + 2 * outset).toBeLessThanOrEqual(800)
      expect(maxCentre(h, outset) - minCentre(h, outset)).toBeGreaterThan(0)
    }
    expect(gapHeight(0) + 2 * thermalOutset(0)).toBeCloseTo(412, 6)
  })

  /**
   * Worth knowing, and not obvious from the spec's two `max`/`min` expressions:
   * the ring's bound is the active one on both edges at *every* difficulty, so
   * GAP_Y_MIN and GAP_Y_MAX_EDGE never actually bind. Even at the outset floor,
   * `THERMAL_Y_MIN + E` = 94 against GAP_Y_MIN's 80, and `THERMAL_Y_MAX - E` =
   * 850 against GAP_Y_MAX_EDGE's 870.
   *
   * That means the v1 field constants are now inherited slack rather than live
   * limits. They are left in place because they still describe the gap's own
   * legal band and the renderer's sky and ground are drawn to them — but a
   * future retune should know that moving them changes nothing until it moves
   * them by more than 14 px.
   */
  it('is bounded by the ring, not by the gap, at every difficulty', () => {
    for (const t of [0, 45, 90, 270, 600, 3600]) {
      const h = gapHeight(t)
      const outset = thermalOutset(t)
      expect(minCentre(h, outset)).toBeGreaterThan(GAP_Y_MIN + h / 2)
      expect(maxCentre(h, outset)).toBeLessThan(GAP_Y_MAX_EDGE - h / 2)
    }
    // The slack at its narrowest, i.e. at the outset floor.
    const h = gapHeight(600)
    expect(minCentre(h, 22) - (GAP_Y_MIN + h / 2)).toBeCloseTo(14, 9)
    expect(GAP_Y_MAX_EDGE - h / 2 - maxCentre(h, 22)).toBeCloseTo(20, 9)
  })
})

describe('spawnGate', () => {
  it('spawns off-screen, unpassed, with an uncollected thermal', () => {
    const [, gate] = spawnGate(createRng(42), 7, 0, null)
    expect(gate.id).toBe(7)
    // 604, not 540: the ring rides 64 px ahead, so at 540 it would pop into
    // view 29 px inside the right edge instead of entering from off-screen.
    expect(gate.x).toBe(GATE_SPAWN_X)
    expect(thermalX(gate)).toBeGreaterThan(540)
    expect(gate.passed).toBe(false)
    expect(gate.thermal.collected).toBe(false)
    expect(gate.thermal.radius).toBe(THERMAL_RADIUS)
    expect(gate.gapHeight).toBeCloseTo(gapHeight(0), 9)
  })

  it('advances the generator, and the same generator gives the same gate', () => {
    const rng = createRng(99)
    const [after, first] = spawnGate(rng, 0, 0, null)
    const [, again] = spawnGate(rng, 0, 0, null)
    expect(again).toEqual(first)
    expect(after).not.toEqual(rng)
    const [, second] = spawnGate(after, 1, 0, null)
    expect(second.gapY).not.toBe(first.gapY)
  })

  it('puts the thermal outside one side of the gap or the other, by RNG', () => {
    const sides = new Set<string>()
    let rng = createRng(5)
    for (let i = 0; i < 20; i += 1) {
      const [next, gate] = spawnGate(rng, i, 0, null)
      rng = next
      sides.add(gate.thermal.y > gapCentre(gate) ? 'below' : 'above')
      // Outside, every time — never the v1 placement.
      expect(Math.abs(gate.thermal.y - gapCentre(gate))).toBeGreaterThan(gate.gapHeight / 2)
    }
    expect(sides).toEqual(new Set(['above', 'below']))
  })

  it('draws side, then direction, then magnitude — the order the golden file depends on', () => {
    // Changing the order changes every course from the same seed. This pins it
    // as a contract rather than leaving it to be rediscovered from a diff.
    const [, withPrevious] = spawnGate(createRng(31337), 0, 10, 500)
    expect(withPrevious.gapY).toBeCloseTo(358.597687, 6)
    expect(withPrevious.thermal.y).toBeCloseTo(293.931021, 6)
  })

  it('honours the reachability limit against the previous centre', () => {
    const elapsed = 30
    const limit = maxCentreDelta(spawnInterval(elapsed))
    let rng = createRng(2024)
    for (let i = 0; i < 500; i += 1) {
      const [next, gate] = spawnGate(rng, i, elapsed, 500)
      rng = next
      expect(Math.abs(gapCentre(gate) - 500)).toBeLessThanOrEqual(limit + 1e-9)
    }
  })

  it('clamps an impossible previous centre into the legal band', () => {
    // Clamping can only ever shorten a move, so it cannot break reachability.
    const h = gapHeight(0)
    const outset = thermalOutset(0)
    const [, high] = spawnGate(createRng(1), 0, 0, 10_000)
    expect(gapCentre(high)).toBeCloseTo(maxCentre(h, outset), 9)
    const [, low] = spawnGate(createRng(1), 0, 0, -10_000)
    expect(gapCentre(low)).toBeCloseTo(minCentre(h, outset), 9)
  })

  it('explores the whole legal band when it is unconstrained', () => {
    let rng = createRng(77)
    let lowest = Infinity
    let highest = -Infinity
    for (let i = 0; i < 2_000; i += 1) {
      const [next, gate] = spawnGate(rng, i, 0, null)
      rng = next
      lowest = Math.min(lowest, gapCentre(gate))
      highest = Math.max(highest, gapCentre(gate))
    }
    const h = gapHeight(0)
    const outset = thermalOutset(0)
    expect(lowest).toBeGreaterThanOrEqual(minCentre(h, outset) - 1e-9)
    expect(lowest).toBeLessThan(minCentre(h, outset) + 10)
    expect(highest).toBeLessThanOrEqual(maxCentre(h, outset) + 1e-9)
    expect(highest).toBeGreaterThan(maxCentre(h, outset) - 10)
  })
})

describe('the side and centre rule', () => {
  /**
   * Half the gates are tight (a flat approach and an expensive ring) and half
   * swing (a big course move and a cheap one). That 50/50 is by construction —
   * the direction is a fair coin — and it is a better rhythm than v1's uniform
   * draw produced. Checked here rather than left as a claim in the spec.
   */
  it('splits gates evenly between moving toward the ring and away from it', () => {
    let toward = 0
    let total = 0
    for (let seed = 0; seed < 300; seed += 1) {
      let previous = KITE_START_Y
      for (const { gate } of course(seed, 60)) {
        const u = gate.thermal.y > gapCentre(gate) ? 1 : -1
        const delta = gapCentre(gate) - previous
        // Clamping at the band edges turns some moves into exact zeroes, which
        // belong to neither side; count only the ones that actually moved.
        if (Math.abs(delta) > 1e-9) {
          total += 1
          if (delta * u > 0) toward += 1
        }
        previous = gapCentre(gate)
      }
    }
    expect(total).toBeGreaterThan(10_000)
    expect(toward / total).toBeGreaterThan(0.45)
    expect(toward / total).toBeLessThan(0.55)
  })
})

describe(`the invariants hold over ${SEEDS.toLocaleString('en-US')} seeds`, () => {
  // 3.5M gates of real arithmetic. Measured at ~6 s; the budget is generous so
  // that a slower CI runner fails on an assertion rather than on a stopwatch.
  it(
    'never places a course that cannot be flown, and never one that is free',
    { timeout: 60_000 },
    () => {
      let worstDeltaRatio = 0
      let worstTowardRatio = 0
      let tightestGapMargin = Infinity
      let worstOutsideGap = Infinity
      let worstCentreLineMiss = Infinity
      let worstColumnClearance = Infinity
      let worstNeighbourClearance = Infinity
      let worstFieldMargin = Infinity
      let worstMagnitudeSlack = Infinity
      let awayGatesInPhase2 = 0
      let edgeClampedAwayGates = 0
      let gatesChecked = 0

      for (let seed = 0; seed < SEEDS; seed += 1) {
        const gates = course(seed, SECONDS_PER_SEED)

        let previousCentre = KITE_START_Y
        let previousSpawn: number | null = null
        for (const { gate, elapsed } of gates) {
          gatesChecked += 1
          const centre = gapCentre(gate)
          const gapBottom = gate.gapY + gate.gapHeight
          const u = gate.thermal.y > centre ? 1 : -1
          const offset = Math.abs(gate.thermal.y - centre)

          // 1. Reachable from the gate before it (and the first from the kite's
          //    starting altitude) within the time the player actually gets.
          const limit = maxCentreDelta(spawnInterval(elapsed))
          const delta = centre - previousCentre
          worstDeltaRatio = Math.max(worstDeltaRatio, Math.abs(delta) / limit)
          if (Math.abs(delta) > limit + 1e-9) {
            throw new Error(
              `seed ${seed}, gate ${gate.id}: centre moved ${Math.abs(delta).toFixed(2)}px in ` +
                `${spawnInterval(elapsed).toFixed(3)}s, limit ${limit.toFixed(2)}px`,
            )
          }

          // 2. The side/centre rule: the course may run away from the ring freely,
          //    but may close on it by at most 30·(1 - q). Otherwise both bills —
          //    the course move and the detour — come due on the same gate and the
          //    ring stops being takeable at any survivable clearance.
          const towardCap = Math.min(limit, thermalTowardDelta(elapsed))
          if (delta * u > towardCap + 1e-9) {
            throw new Error(
              `seed ${seed}, gate ${gate.id}: centre closed ${(delta * u).toFixed(2)}px on the ` +
                `ring's side at t=${elapsed.toFixed(1)}s, cap ${towardCap.toFixed(2)}px`,
            )
          }
          worstTowardRatio = Math.max(worstTowardRatio, (delta * u) / towardCap)

          // 3. THE MAGNITUDE RULE (v2.1). On a gate that moves *away* from the
          //    ring's side, the move is at least q·maxCentreDelta — unless the
          //    centre landed on a band edge, where clamping shortened it.
          //
          //    **The edge exemption is load-bearing, not defensive.** Clamping
          //    into [loC, hiC] shortens the move on 16.2% of phase-2 away-gates
          //    (224,047 of 1,385,865 here), so the same assertion written
          //    without it does not fail occasionally — measured over these
          //    10,000 seeds it fails on 9,994 of them. The counters below are
          //    what stop the exemption from quietly swallowing the clause.
          const height = gapHeight(elapsed)
          const outset = thermalOutset(elapsed)
          const low = minCentre(height, outset)
          const high = maxCentre(height, outset)
          const atEdge = centre <= low + 1e-9 || centre >= high - 1e-9
          if (delta * u < 0 && secondProgress(elapsed) > 0) {
            awayGatesInPhase2 += 1
            if (atEdge) {
              edgeClampedAwayGates += 1
            } else {
              const floor = magnitudeFloor(elapsed, false, limit)
              if (Math.abs(delta) < floor - 1e-9) {
                throw new Error(
                  `seed ${seed}, gate ${gate.id}: away-move of ${Math.abs(delta).toFixed(2)}px ` +
                    `at t=${elapsed.toFixed(1)}s is under the q·cap floor of ${floor.toFixed(2)}px ` +
                    `(centre ${centre.toFixed(2)} is not at a band edge)`,
                )
              }
              worstMagnitudeSlack = Math.min(worstMagnitudeSlack, Math.abs(delta) - floor)
            }
          }

          // 4. The whole gap is inside the legal band.
          if (gate.gapY < GAP_Y_MIN - 1e-9 || gapBottom > GAP_Y_MAX_EDGE + 1e-9) {
            throw new Error(
              `seed ${seed}, gate ${gate.id}: gap [${gate.gapY.toFixed(2)}, ` +
                `${gapBottom.toFixed(2)}] escapes [${GAP_Y_MIN}, ${GAP_Y_MAX_EDGE}]`,
            )
          }
          tightestGapMargin = Math.min(
            tightestGapMargin,
            gate.gapY - GAP_Y_MIN,
            GAP_Y_MAX_EDGE - gapBottom,
          )

          // 5. THE REPLACEMENT INVARIANT. The ring's disc lies entirely outside
          //    the gap band — equivalently, a kite that collects is at that
          //    instant at least h/2 - KITE_RADIUS from the gap centre, i.e. it has
          //    left the safe corridor completely. This is the exact mirror of the
          //    v1 proof that killed the old placement.
          const outsideBy = offset - gate.gapHeight / 2 - THERMAL_RADIUS
          if (outsideBy < -1e-9) {
            throw new Error(
              `seed ${seed}, gate ${gate.id}: ring at ${gate.thermal.y.toFixed(2)} overlaps gap ` +
                `[${gate.gapY.toFixed(2)}, ${gapBottom.toFixed(2)}]`,
            )
          }
          worstOutsideGap = Math.min(worstOutsideGap, outsideBy)

          // 6. The direct regression test for the v1 defect: the gap's centre line
          //    never collects, at any t. Under v1 this failed on 65% of gates and
          //    on 100% of them from t = 77 s.
          const centreLineMiss = offset - COLLECT_REACH
          if (centreLineMiss <= 0) {
            throw new Error(
              `seed ${seed}, gate ${gate.id}: the gap centre line collects the ring for free ` +
                `at t=${elapsed.toFixed(1)}s`,
            )
          }
          worstCentreLineMiss = Math.min(worstCentreLineMiss, centreLineMiss)

          // 7. The ring's disc is 7 px clear of both of its own gate's columns,
          //    and clear of the previous gate's columns too — it sits in genuine
          //    open air, not tucked against a hazard.
          const ringX = thermalX(gate)
          worstColumnClearance = Math.min(worstColumnClearance, gate.x - (ringX + THERMAL_RADIUS))
          if (previousSpawn !== null) {
            // Where the previous gate has scrolled to by the time this one is
            // created. Scroll speed only rises, so taking it at the earlier of the
            // two times understates the distance — the clearance below is a lower
            // bound on the real one, which is the direction a safety check should
            // err in.
            const spacing = scrollSpeed(previousSpawn) * (elapsed - previousSpawn)
            const previousRightEdge = GATE_SPAWN_X - spacing + GATE_WIDTH
            worstNeighbourClearance = Math.min(
              worstNeighbourClearance,
              ringX - THERMAL_RADIUS - previousRightEdge,
            )
          }
          previousSpawn = elapsed

          // 8. The whole ring is reachable and visible: its centre stays inside
          //    the kite's flyable band, inset by the radius and a 20 px margin.
          if (gate.thermal.y < THERMAL_Y_MIN - 1e-9 || gate.thermal.y > THERMAL_Y_MAX + 1e-9) {
            throw new Error(
              `seed ${seed}, gate ${gate.id}: ring centre ${gate.thermal.y.toFixed(2)} escapes ` +
                `[${THERMAL_Y_MIN}, ${THERMAL_Y_MAX}]`,
            )
          }
          worstFieldMargin = Math.min(
            worstFieldMargin,
            gate.thermal.y - THERMAL_Y_MIN,
            THERMAL_Y_MAX - gate.thermal.y,
          )

          previousCentre = centre
        }
      }

      // Every seed really did fly the whole ramp and out the far side.
      expect(gatesChecked / SEEDS).toBeGreaterThan(340)

      // Sanity on the test itself: if the generator had collapsed to the middle of
      // the field, every assertion above would pass vacuously.
      expect(worstDeltaRatio).toBeGreaterThan(0.9)
      expect(worstDeltaRatio).toBeLessThanOrEqual(1)
      expect(worstTowardRatio).toBeGreaterThan(0.9)
      expect(worstTowardRatio).toBeLessThanOrEqual(1)

      // The magnitude rule, and the two numbers that stop its edge exemption
      // from being a licence. There have to be plenty of phase-2 away-gates for
      // clause 3 to have tested anything; the clamped share has to be a real
      // minority (so the exemption is not swallowing the clause); and it has to
      // be nonzero (so the exemption is genuinely load-bearing rather than
      // defensive — without it this test fails on 9,994 of these 10,000 seeds).
      expect(awayGatesInPhase2).toBeGreaterThan(1_000_000)
      const clampedShare = edgeClampedAwayGates / awayGatesInPhase2
      expect(clampedShare).toBeGreaterThan(0.05)
      expect(clampedShare).toBeLessThan(0.3)
      // And the clause binds: the tightest unclamped away-move in 3.5M gates
      // sits right on its q·cap floor rather than comfortably above it.
      expect(worstMagnitudeSlack).toBeGreaterThanOrEqual(0)
      expect(worstMagnitudeSlack).toBeLessThan(0.5)
      // The ring's field bound is the one that actually binds, so it is the one
      // that has to reach zero for this test not to be vacuous. The gap's own
      // margin bottoms out at the 14 px of slack between the two bounds, which is
      // a derived consequence rather than a tuning choice — see the band tests.
      expect(worstFieldMargin).toBeLessThan(1)
      expect(tightestGapMargin).toBeCloseTo(14, 6)

      // And the headline numbers, pinned so a retune that erodes them is visible.
      // At the outset floor the ring's disc is exactly flush with the gap band:
      // zero is the tightest this is allowed to be, and it is where the invariant
      // and the constant meet.
      expect(worstOutsideGap).toBeCloseTo(0, 6)
      // The centre line misses by at least E - 38 + h/2 — 17 px at the asymptote.
      expect(worstCentreLineMiss).toBeGreaterThan(16)
      // 64 - 22 - 35 = 7 px from its own columns, always, at every difficulty.
      expect(worstColumnClearance).toBeCloseTo(7, 9)
      // And at least 167 px from the previous gate's, which is the gate spacing at
      // its tightest (288 px at t = 0) less the 121 px the geometry needs.
      expect(worstNeighbourClearance).toBeGreaterThan(167)
    },
  )
})
