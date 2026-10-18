import { describe, expect, it } from 'vitest'
import {
  CEILING_Y,
  FIELD_WIDTH,
  FIRST_GATE_DELAY,
  GATE_SPAWN_X,
  GROUND_Y,
  GAP_Y_MAX_EDGE,
  GAP_Y_MIN,
  KITE_START_Y,
  MAX_CENTRE_DELTA_MAX,
  MAX_CENTRE_DELTA_MIN,
  NET_LIFT_ACCEL,
  REACH_HEADROOM,
  THERMAL_OUTSIDE_OFFSET,
  THERMAL_RADIUS,
  VY_CLAMP,
} from '../src/game/constants.js'
import { gapHeight, spawnInterval } from '../src/game/difficulty.js'
import { createRng } from '../src/game/rng.js'
import {
  gapCentre,
  maxCentre,
  maxCentreDelta,
  minCentre,
  reach,
  spawnGate,
  thermalY,
} from '../src/game/spawner.js'
import { thermalX, type Gate } from '../src/game/state.js'

/**
 * Spawner (spec §3).
 *
 * The headline test is the property test at the bottom: 10,000 seeds, every
 * consecutive gate pair reachable, every gap inside the field, every thermal
 * strictly *outside* its gap and in open air. It is the thing standing between us
 * and "unwinnable run" bug reports, so it runs over the same schedule update.ts
 * uses rather than over a convenient one.
 *
 * The thermal half of that invariant inverted on 2026-10-18 (GOK-5): a ring
 * strictly inside its gap was always collectible from an altitude that already
 * cleared the columns, so the risk/reward layer did not exist. Note what did NOT
 * change — the fairness rule is about the gaps, and rings are optional, so a ring
 * the player judges unreachable is a ring they decline, not an unflyable course.
 */

const SEEDS = 10_000
/** ~45 s of play per seed: through the whole difficulty ramp and out the far side. */
const GATES_PER_SEED = 40

/**
 * Generate one seed's course on exactly the schedule update.ts spawns on:
 * the first gate at FIRST_GATE_DELAY placed relative to where the kite starts,
 * then one gate every spawnInterval(elapsed).
 */
function course(seed: number, count: number): Array<{ gate: Gate; elapsed: number }> {
  let rng = createRng(seed)
  let elapsed = FIRST_GATE_DELAY
  let previousCentre: number | null = KITE_START_Y
  const gates: Array<{ gate: Gate; elapsed: number }> = []

  for (let id = 0; id < count; id += 1) {
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
  it('is half the reach, clamped into [120, 420]', () => {
    expect(maxCentreDelta(0)).toBe(MAX_CENTRE_DELTA_MIN)
    expect(maxCentreDelta(100)).toBe(MAX_CENTRE_DELTA_MAX)
    const t = 1.2
    expect(maxCentreDelta(t)).toBeCloseTo(REACH_HEADROOM * reach(t), 9)
  })

  it('is never more than half of what the kite can actually do', () => {
    for (let t = 0.1; t <= 3; t += 0.1) {
      expect(maxCentreDelta(t)).toBeLessThanOrEqual(Math.max(REACH_HEADROOM * reach(t), 120) + 1e-9)
    }
  })

  it('leaves real headroom across the whole difficulty ramp', () => {
    // Every interval the game can actually ask for, from 1.6 s down to 0.9 s.
    for (const t of [0.9, 1.0, 1.25, 1.4, 1.6]) {
      expect(maxCentreDelta(t)).toBeLessThan(reach(t))
    }
  })
})

describe('spawnGate', () => {
  it('spawns off the right-hand edge, unpassed, with an uncollected thermal', () => {
    const [, gate] = spawnGate(createRng(42), 7, 0, null)
    expect(gate.id).toBe(7)
    // Far enough out that the ring, which leads the gate, enters at FIELD_WIDTH
    // rather than appearing in the middle of the screen.
    expect(gate.x).toBe(GATE_SPAWN_X)
    expect(thermalX(gate)).toBe(FIELD_WIDTH)
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

  it('hangs the thermal off the edge the kite is coming from', () => {
    // Previous gap above this one: the kite arrives from above, so the ring is on
    // the gap's upper edge, on the way in rather than across the course.
    const [, fromAbove] = spawnGate(createRng(5), 0, 0, 200)
    expect(fromAbove.thermal.y).toBeLessThan(fromAbove.gapY)
    const [, fromBelow] = spawnGate(createRng(5), 0, 0, 800)
    expect(fromBelow.thermal.y).toBeGreaterThan(fromBelow.gapY + fromBelow.gapHeight)
  })

  it('falls back to the RNG only when there is no side to come from', () => {
    const sides = new Set<string>()
    let rng = createRng(5)
    for (let i = 0; i < 20; i += 1) {
      const [next, gate] = spawnGate(rng, i, 0, null)
      rng = next
      sides.add(gate.thermal.y > gapCentre(gate) ? 'below' : 'above')
    }
    expect(sides).toEqual(new Set(['above', 'below']))
  })

  /**
   * The flip. A ring is pushed to the other edge when its own side would put it
   * off the field — near the top and bottom of the legal band. It can never need
   * flipping twice: that would take a gap taller than
   * THERMAL_Y_MAX - THERMAL_Y_MIN - 2*THERMAL_OUTSIDE_OFFSET = 776px, against a
   * widest gap of 260. Swept rather than argued.
   */
  it('keeps every ring in open air, for every gap the game can produce', () => {
    for (let elapsed = 0; elapsed <= 120; elapsed += 1) {
      const height = gapHeight(elapsed)
      for (let centre = minCentre(height); centre <= maxCentre(height); centre += 1) {
        for (const below of [true, false]) {
          const y = thermalY(centre, height, below)
          expect(Math.abs(y - centre)).toBeCloseTo(height / 2 + THERMAL_OUTSIDE_OFFSET, 9)
          expect(y - THERMAL_RADIUS).toBeGreaterThanOrEqual(CEILING_Y)
          expect(y + THERMAL_RADIUS).toBeLessThanOrEqual(GROUND_Y)
        }
      }
    }
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

  it('falls back to the nearest legal centre if asked for an impossible one', () => {
    // A previous centre far outside the legal band for this gap height: field
    // bounds win, and the gap is placed as close to it as the field allows.
    const [, high] = spawnGate(createRng(1), 0, 0, 10_000)
    expect(gapCentre(high)).toBeCloseTo(maxCentre(gapHeight(0)), 9)
    const [, low] = spawnGate(createRng(1), 0, 0, -10_000)
    expect(gapCentre(low)).toBeCloseTo(minCentre(gapHeight(0)), 9)
  })

  it('explores the whole legal band when it is unconstrained', () => {
    let rng = createRng(77)
    let lowest = Infinity
    let highest = -Infinity
    for (let i = 0; i < 2_000; i += 1) {
      const [next, gate] = spawnGate(rng, i, 0, null)
      rng = next
      lowest = Math.min(lowest, gate.gapY)
      highest = Math.max(highest, gate.gapY + gate.gapHeight)
    }
    expect(lowest).toBeGreaterThanOrEqual(GAP_Y_MIN)
    expect(lowest).toBeLessThan(GAP_Y_MIN + 10)
    expect(highest).toBeLessThanOrEqual(GAP_Y_MAX_EDGE)
    expect(highest).toBeGreaterThan(GAP_Y_MAX_EDGE - 10)
  })
})

describe(`the fairness rule holds over ${SEEDS.toLocaleString('en-US')} seeds`, () => {
  it('never places a course that cannot be flown, and never one off the field', () => {
    let worstDeltaRatio = 0
    let worstThermalClearance = Infinity
    let tightestGapMargin = Infinity

    for (let seed = 0; seed < SEEDS; seed += 1) {
      const gates = course(seed, GATES_PER_SEED)

      let previousCentre = KITE_START_Y
      for (const { gate, elapsed } of gates) {
        const centre = gapCentre(gate)
        const gapBottom = gate.gapY + gate.gapHeight

        // 1. Reachable from the gate before it (and the first from the kite's
        //    starting altitude) within the time the player actually gets.
        const limit = maxCentreDelta(spawnInterval(elapsed))
        const delta = Math.abs(centre - previousCentre)
        if (delta / limit > worstDeltaRatio) worstDeltaRatio = delta / limit
        if (delta > limit + 1e-9) {
          throw new Error(
            `seed ${seed}, gate ${gate.id}: centre moved ${delta.toFixed(2)}px in ` +
              `${spawnInterval(elapsed).toFixed(3)}s, limit ${limit.toFixed(2)}px`,
          )
        }

        // 2. The whole gap is inside the legal band.
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

        // 3. The thermal ring is strictly OUTSIDE the gap, and in open air. The
        //    clearance here is daylight between the ring and the gap it hides
        //    beside — the thing that makes collecting cost something.
        const clearance = Math.max(
          gate.gapY - (gate.thermal.y + gate.thermal.radius),
          gate.thermal.y - gate.thermal.radius - gapBottom,
        )
        if (clearance <= 0) {
          throw new Error(
            `seed ${seed}, gate ${gate.id}: thermal at ${gate.thermal.y.toFixed(2)} is not ` +
              `outside gap [${gate.gapY.toFixed(2)}, ${gapBottom.toFixed(2)}]`,
          )
        }
        if (
          gate.thermal.y - gate.thermal.radius < CEILING_Y ||
          gate.thermal.y + gate.thermal.radius > GROUND_Y
        ) {
          throw new Error(
            `seed ${seed}, gate ${gate.id}: thermal at ${gate.thermal.y.toFixed(2)} is not ` +
              `in open air`,
          )
        }
        worstThermalClearance = Math.min(worstThermalClearance, clearance)

        previousCentre = centre
      }
    }

    // Sanity on the test itself: if the generator had collapsed to the middle of
    // the field, every assertion above would pass vacuously.
    expect(worstDeltaRatio).toBeGreaterThan(0.9)
    expect(worstDeltaRatio).toBeLessThanOrEqual(1)
    expect(tightestGapMargin).toBeLessThan(1)
    // The 40 px offset minus the 22 px ring: 18 px of daylight between every ring
    // and its gap, at every difficulty. It is a constant because the gap height
    // cancels — which is exactly why no point on the ramp makes collecting free.
    expect(worstThermalClearance).toBeCloseTo(THERMAL_OUTSIDE_OFFSET - THERMAL_RADIUS, 9)
  })
})
