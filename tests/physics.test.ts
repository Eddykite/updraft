import { describe, expect, it } from 'vitest'
import {
  CEILING_Y,
  FIXED_DT,
  GRAVITY,
  GROUND_Y,
  KITE_RADIUS,
  KITE_START_Y,
  LIFT_ACCEL,
  NET_LIFT_ACCEL,
  VY_CLAMP,
} from '../src/game/constants.js'
import { accelerationFor, hasHitGround, integrate } from '../src/game/physics.js'
import type { Kite } from '../src/game/state.js'

/**
 * Physics (spec §3).
 *
 * The expected values here come from the closed form of semi-implicit Euler,
 * not from a second copy of the integrator:
 *
 *   vy_n = v0 + n·a·dt
 *   y_n  = y0 + dt·(n·v0 + a·dt·n(n+1)/2)
 *
 * so a change to the integration scheme fails these tests rather than being
 * silently mirrored by them.
 */

const EPS = 1e-9

function run(kite: Kite, holding: boolean, ticks: number, dt = FIXED_DT): Kite {
  let current = kite
  for (let i = 0; i < ticks; i += 1) current = integrate(current, holding, dt)
  return current
}

function expectedVy(v0: number, a: number, n: number, dt: number): number {
  return v0 + n * a * dt
}

function expectedY(y0: number, v0: number, a: number, n: number, dt: number): number {
  return y0 + dt * (n * v0 + (a * dt * n * (n + 1)) / 2)
}

describe('accelerationFor', () => {
  it('is gravity when released and the net lift when held', () => {
    expect(accelerationFor(false)).toBe(GRAVITY)
    expect(accelerationFor(true)).toBe(GRAVITY + LIFT_ACCEL)
    // The number the reachability maths is built on: net 1400 upward.
    expect(accelerationFor(true)).toBe(-NET_LIFT_ACCEL)
  })
})

describe('integrate: free fall', () => {
  it('matches the closed form after 20 ticks from rest', () => {
    // 20 ticks is one tick short of 500 px/s: still below the clamp, so the
    // closed form applies unmodified.
    const start: Kite = { y: KITE_START_Y, vy: 0 }
    const after = run(start, false, 20)
    expect(after.vy).toBeCloseTo(expectedVy(0, GRAVITY, 20, FIXED_DT), 9)
    expect(after.vy).toBeCloseTo(500, 9)
    expect(after.y).toBeCloseTo(expectedY(KITE_START_Y, 0, GRAVITY, 20, FIXED_DT), 9)
    expect(after.y).toBeCloseTo(KITE_START_Y + 87.5, 9)
  })

  it('matches the closed form from a non-zero starting velocity', () => {
    const start: Kite = { y: 300, vy: -120 }
    const after = run(start, false, 17)
    expect(Math.abs(after.vy)).toBeLessThan(VY_CLAMP)
    expect(after.vy).toBeCloseTo(expectedVy(-120, GRAVITY, 17, FIXED_DT), 9)
    expect(after.y).toBeCloseTo(expectedY(300, -120, GRAVITY, 17, FIXED_DT), 9)
  })

  it('is the same at a different dt for the same elapsed time, to first order', () => {
    // 0.3 s of fall from rest: the exact position differs between step sizes
    // (that is what Euler does), but velocity after 0.3 s is a·t either way.
    const sixty = run({ y: 100, vy: 0 }, false, 18, 1 / 60)
    const thirty = run({ y: 100, vy: 0 }, false, 9, 1 / 30)
    expect(sixty.vy).toBeCloseTo(GRAVITY * 0.3, 9)
    expect(thirty.vy).toBeCloseTo(GRAVITY * 0.3, 9)
    expect(Math.abs(sixty.y - thirty.y)).toBeLessThan(5)
  })
})

describe('integrate: climbing', () => {
  it('matches the closed form after 20 held ticks from rest', () => {
    const a = GRAVITY + LIFT_ACCEL
    const after = run({ y: KITE_START_Y, vy: 0 }, true, 20)
    expect(after.vy).toBeCloseTo(expectedVy(0, a, 20, FIXED_DT), 9)
    expect(after.vy).toBeGreaterThan(-VY_CLAMP)
    expect(after.y).toBeCloseTo(expectedY(KITE_START_Y, 0, a, 20, FIXED_DT), 9)
    expect(after.y).toBeLessThan(KITE_START_Y)
  })

  it('climbs and falls in the ratio of the two accelerations', () => {
    // Symmetry: from rest, the distance covered in n ticks is proportional to
    // the acceleration, and nothing else.
    const up = KITE_START_Y - run({ y: KITE_START_Y, vy: 0 }, true, 20).y
    const down = run({ y: KITE_START_Y, vy: 0 }, false, 20).y - KITE_START_Y
    expect(up / down).toBeCloseTo(NET_LIFT_ACCEL / GRAVITY, 9)
  })

  it('returns to rest after 15 held ticks and 14 released ticks, higher than it started', () => {
    // 15 · 1400 = 14 · 1500 = 21000, so the velocity ledger closes exactly.
    const climbed = run({ y: KITE_START_Y, vy: 0 }, true, 15)
    const settled = run(climbed, false, 14)
    expect(settled.vy).toBeCloseTo(0, 9)
    expect(settled.y).toBeLessThan(KITE_START_Y)
  })
})

describe('integrate: velocity clamp', () => {
  it('never exceeds ±VY_CLAMP however long the input is held', () => {
    // The clamp bites after 560/25 = 22.4 ticks of falling and 24 ticks of
    // climbing; 40 ticks is well past both. The climb starts near the ground so
    // the ceiling is not what stops it.
    const falling = run({ y: 100, vy: 0 }, false, 40)
    const climbing = run({ y: 900, vy: 0 }, true, 40)
    expect(falling.vy).toBe(VY_CLAMP)
    expect(climbing.vy).toBe(-VY_CLAMP)
    expect(climbing.y).toBeGreaterThan(CEILING_Y)
  })

  it('clamps exactly at the boundary, not one tick late', () => {
    // One tick short of the clamp, then the tick that reaches it.
    const justUnder: Kite = { y: 400, vy: VY_CLAMP - GRAVITY * FIXED_DT }
    expect(integrate(justUnder, false, FIXED_DT).vy).toBeCloseTo(VY_CLAMP, 9)
    const over: Kite = { y: 400, vy: VY_CLAMP }
    expect(integrate(over, false, FIXED_DT).vy).toBe(VY_CLAMP)
    const under: Kite = { y: 400, vy: -VY_CLAMP }
    expect(integrate(under, true, FIXED_DT).vy).toBe(-VY_CLAMP)
  })

  it('moves at exactly the clamp speed once clamped', () => {
    const clamped = integrate({ y: 400, vy: VY_CLAMP }, false, FIXED_DT)
    expect(clamped.y).toBeCloseTo(400 + VY_CLAMP * FIXED_DT, 9)
  })
})

describe('integrate: the soft ceiling', () => {
  it('stops the kite dead at CEILING_Y instead of killing it', () => {
    const after = run({ y: CEILING_Y + 40, vy: -VY_CLAMP }, true, 10)
    expect(after.y).toBe(CEILING_Y)
    expect(after.vy).toBe(0)
  })

  it('treats a step that lands exactly on the ceiling as a ceiling touch', () => {
    // Whole numbers at dt = 1 so the boundary is exact rather than nearly exact:
    // vy becomes -60, y becomes 30 + 60 - 60 = CEILING_Y.
    const start: Kite = { y: CEILING_Y + 60, vy: -60 - (GRAVITY + LIFT_ACCEL) }
    const after = integrate(start, true, 1)
    expect(after).toEqual({ y: CEILING_Y, vy: 0 })
  })

  it('leaves a step that lands one pixel below the ceiling alone', () => {
    const start: Kite = { y: CEILING_Y + 61, vy: -60 - (GRAVITY + LIFT_ACCEL) }
    const after = integrate(start, true, 1)
    expect(after).toEqual({ y: CEILING_Y + 1, vy: -60 })
  })

  it('leaves a kite one pixel below the ceiling alone when it is falling', () => {
    const after = integrate({ y: CEILING_Y + 1, vy: 0 }, false, FIXED_DT)
    expect(after.y).toBeGreaterThan(CEILING_Y)
    expect(after.vy).toBeCloseTo(GRAVITY * FIXED_DT, 9)
  })

  it('falls away from the ceiling as soon as the input is released', () => {
    const pinned = run({ y: CEILING_Y + 5, vy: 0 }, true, 10)
    expect(pinned.y).toBe(CEILING_Y)
    const dropped = integrate(pinned, false, FIXED_DT)
    expect(dropped.y).toBeGreaterThan(CEILING_Y)
    expect(dropped.vy).toBeCloseTo(GRAVITY * FIXED_DT, 9)
  })

  it('holding at the ceiling is survivable forever', () => {
    const after = run({ y: CEILING_Y, vy: 0 }, true, 10_000)
    expect(after).toEqual({ y: CEILING_Y, vy: 0 })
    expect(hasHitGround(after)).toBe(false)
  })
})

describe('hasHitGround', () => {
  it('is true exactly when y + r reaches the ground line', () => {
    expect(hasHitGround({ y: GROUND_Y - KITE_RADIUS - EPS, vy: 0 })).toBe(false)
    expect(hasHitGround({ y: GROUND_Y - KITE_RADIUS, vy: 0 })).toBe(true)
    expect(hasHitGround({ y: GROUND_Y - KITE_RADIUS + EPS, vy: 0 })).toBe(true)
  })

  it('is one pixel of clearance away from fatal', () => {
    expect(hasHitGround({ y: GROUND_Y - KITE_RADIUS - 1, vy: 0 })).toBe(false)
  })

  it('does not depend on velocity', () => {
    expect(hasHitGround({ y: KITE_START_Y, vy: VY_CLAMP })).toBe(false)
  })
})
