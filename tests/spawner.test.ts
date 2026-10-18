import { describe, expect, it } from 'vitest'
import {
  FIELD_WIDTH,
  FIRST_GATE_DELAY,
  GAP_Y_MAX_EDGE,
  GAP_Y_MIN,
  KITE_START_Y,
  MAX_CENTRE_DELTA_MAX,
  MAX_CENTRE_DELTA_MIN,
  NET_LIFT_ACCEL,
  REACH_HEADROOM,
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
} from '../src/game/spawner.js'
import type { Gate } from '../src/game/state.js'

/**
 * Spawner (spec §3).
 *
 * The headline test is the property test at the bottom: 10,000 seeds, every
 * consecutive gate pair reachable, every gap inside the field, every thermal
 * strictly inside its gap. It is the thing standing between us and "unwinnable
 * run" bug reports, so it runs over the same schedule update.ts uses rather than
 * over a convenient one.
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
  it('spawns at the right-hand edge, unpassed, with an uncollected thermal', () => {
    const [, gate] = spawnGate(createRng(42), 7, 0, null)
    expect(gate.id).toBe(7)
    expect(gate.x).toBe(FIELD_WIDTH)
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

  it('puts the thermal on one side of the gap or the other, by RNG', () => {
    const sides = new Set<string>()
    let rng = createRng(5)
    for (let i = 0; i < 20; i += 1) {
      const [next, gate] = spawnGate(rng, i, 0, null)
      rng = next
      sides.add(gate.thermal.y > gapCentre(gate) ? 'below' : 'above')
    }
    expect(sides).toEqual(new Set(['above', 'below']))
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

        // 3. The thermal ring is strictly inside the gap — reachable without
        //    having to clip a column to touch it.
        const clearance = Math.min(
          gate.thermal.y - gate.thermal.radius - gate.gapY,
          gapBottom - (gate.thermal.y + gate.thermal.radius),
        )
        if (clearance <= 0) {
          throw new Error(
            `seed ${seed}, gate ${gate.id}: thermal at ${gate.thermal.y.toFixed(2)} is not ` +
              `inside gap [${gate.gapY.toFixed(2)}, ${gapBottom.toFixed(2)}]`,
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
    // 45 px inset minus the 22 px ring: 23 px of clearance at the tightest gap.
    expect(worstThermalClearance).toBeCloseTo(THERMAL_RADIUS + 1, 9)
  })
})
