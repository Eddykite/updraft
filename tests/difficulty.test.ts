import { describe, expect, it } from 'vitest'
import {
  DIFFICULTY_RAMP_SECONDS,
  GAP_FLOOR,
  INTERVAL_FLOOR,
  SECOND_RAMP_HALF_LIFE,
  SPEED_LIMIT,
  THERMAL_RADIUS,
} from '../src/game/constants.js'
import {
  gapHeight,
  progress,
  scrollSpeed,
  secondProgress,
  spawnInterval,
  thermalOutset,
} from '../src/game/difficulty.js'

/**
 * Difficulty (spec §3).
 *
 * Non-decreasing over [0, 3600 s] and strictly increasing on (0, 1800 s) for
 * speed, strictly decreasing for gap and interval; exact values at t = 0, 45,
 * 90, 150, 210 and 270; continuous at t = 90 from both sides; and the three
 * limits never crossed at any finite t.
 *
 * **v1's "frozen after 90 s" assertion is deleted, not relaxed.** An assertion
 * that nothing moves is how a difficulty ramp with no top got shipped: it passed
 * for the same reason the game was broken. The test below that would have caught
 * it is `the course at t = 240 s is measurably harder than at t = 90 s`, and it
 * fails on v1's behaviour by construction.
 */

/** 0 .. 3600 s. Coarse enough to be quick, fine enough to catch a reversal. */
const SAMPLES = Array.from({ length: 721 }, (_, i) => i * 5)

describe('progress — phase 1', () => {
  it('is 0 at the start, 0.5 halfway, 1 at the ramp end', () => {
    expect(progress(0)).toBe(0)
    expect(progress(45)).toBe(0.5)
    expect(progress(DIFFICULTY_RAMP_SECONDS)).toBe(1)
  })

  it('stays at 1 after the ramp and never goes negative before it', () => {
    expect(progress(300)).toBe(1)
    expect(progress(9_000)).toBe(1)
    // Defensive: a negative elapsed time is not reachable through step(), but
    // clamping means a caller can never drive the ramp backwards.
    expect(progress(-10)).toBe(0)
  })
})

describe('secondProgress — phase 2', () => {
  it('is exactly 0 for the whole of phase 1, so the two ramps never overlap', () => {
    for (const t of [0, 1, 45, 89.9, DIFFICULTY_RAMP_SECONDS]) expect(secondProgress(t)).toBe(0)
  })

  it('halves the remaining distance every half-life', () => {
    expect(secondProgress(DIFFICULTY_RAMP_SECONDS + SECOND_RAMP_HALF_LIFE)).toBeCloseTo(1 / 2, 12)
    expect(secondProgress(DIFFICULTY_RAMP_SECONDS + 2 * SECOND_RAMP_HALF_LIFE)).toBeCloseTo(
      3 / 4,
      12,
    )
    expect(secondProgress(DIFFICULTY_RAMP_SECONDS + 3 * SECOND_RAMP_HALF_LIFE)).toBeCloseTo(
      7 / 8,
      12,
    )
  })

  it('approaches 1 without reaching it, everywhere a run can reach', () => {
    // Strict through the window the spec names; see the float64 saturation test
    // below for where the machine, but not the maths, gives up.
    for (const t of SAMPLES) {
      if (t <= 1800) expect(secondProgress(t)).toBeLessThan(1)
      expect(secondProgress(t)).toBeLessThanOrEqual(1)
    }
  })
})

describe('exact values at the sample times named in the spec', () => {
  const table: ReadonlyArray<readonly [number, number, number, number]> = [
    // t,    speed,   gap,  interval
    [0, 180, 260, 1.6],
    [45, 300, 205, 1.25],
    [90, 420, 150, 0.9],
    [150, 490, 130, 0.79],
    [210, 525, 120, 0.735],
    [270, 542.5, 115, 0.7075],
  ]

  it.each(table)('t = %d s -> speed %d, gap %d, interval %d', (t, speed, gap, interval) => {
    expect(scrollSpeed(t)).toBeCloseTo(speed, 9)
    expect(gapHeight(t)).toBeCloseTo(gap, 9)
    expect(spawnInterval(t)).toBeCloseTo(interval, 9)
  })
})

describe('continuity at the phase junction', () => {
  it('has no step at t = 90 from either side', () => {
    // Small enough that a genuine step would dwarf it: the steepest parameter
    // moves 2.7 px/s through the junction, so a continuous function differs by
    // ~3e-9 here and a discontinuous one by whatever the step is.
    const epsilon = 1e-9
    for (const f of [scrollSpeed, gapHeight, spawnInterval, thermalOutset]) {
      expect(f(DIFFICULTY_RAMP_SECONDS - epsilon)).toBeCloseTo(f(DIFFICULTY_RAMP_SECONDS), 6)
      expect(f(DIFFICULTY_RAMP_SECONDS + epsilon)).toBeCloseTo(f(DIFFICULTY_RAMP_SECONDS), 6)
    }
  })
})

describe('monotonicity', () => {
  it('never reverses anywhere in [0, 3600 s]', () => {
    let previous = 0
    for (const current of SAMPLES) {
      expect(scrollSpeed(current)).toBeGreaterThanOrEqual(scrollSpeed(previous))
      expect(gapHeight(current)).toBeLessThanOrEqual(gapHeight(previous))
      expect(spawnInterval(current)).toBeLessThanOrEqual(spawnInterval(previous))
      previous = current
    }
  })

  it('is strictly monotonic on (0, 1800 s) — there is no plateau to settle into', () => {
    for (let t = 0; t < 1800; t += 30) {
      expect(scrollSpeed(t + 30)).toBeGreaterThan(scrollSpeed(t))
      expect(gapHeight(t + 30)).toBeLessThan(gapHeight(t))
      expect(spawnInterval(t + 30)).toBeLessThan(spawnInterval(t))
    }
  })

  /**
   * The headline acceptance test, and the one that fails on v1.
   *
   * Under `p = clamp(t/90, 0, 1)` with no second ramp, every one of these is an
   * equality and all three assertions go red. That is the whole point of the
   * task: a frozen course is survivable indefinitely, so the score measured
   * patience rather than skill.
   */
  it('the course at t = 240 s is measurably harder than at t = 90 s', () => {
    expect(scrollSpeed(240)).toBeGreaterThan(scrollSpeed(90))
    expect(gapHeight(240)).toBeLessThan(gapHeight(90))
    expect(spawnInterval(240)).toBeLessThan(spawnInterval(90))

    // Not marginally, either: by t = 240 s the second ramp has run for two and a
    // half half-lives, so it has closed 82% of the distance to the floors.
    expect(scrollSpeed(240) - scrollSpeed(90)).toBeGreaterThan(100)
    expect(gapHeight(90) - gapHeight(240)).toBeGreaterThan(30)
    expect(spawnInterval(90) - spawnInterval(240)).toBeGreaterThan(0.17)
  })
})

describe('the floors are approached and never crossed', () => {
  it('holds at every sampled time out to an hour', () => {
    for (const t of SAMPLES) {
      expect(scrollSpeed(t)).toBeLessThanOrEqual(SPEED_LIMIT)
      expect(gapHeight(t)).toBeGreaterThanOrEqual(GAP_FLOOR)
      expect(spawnInterval(t)).toBeGreaterThanOrEqual(INTERVAL_FLOOR)
    }
  })

  it('is still strictly short of them at the far end of a plausible run', () => {
    for (const t of [270, 600, 1200, 1800]) {
      expect(scrollSpeed(t)).toBeLessThan(SPEED_LIMIT)
      expect(gapHeight(t)).toBeGreaterThan(GAP_FLOOR)
      expect(spawnInterval(t)).toBeGreaterThan(INTERVAL_FLOOR)
    }
    // Named in the spec: 115 px at t = 270 s, 110.1 px at t = 600 s, still shrinking.
    expect(gapHeight(270)).toBeCloseTo(115, 9)
    expect(gapHeight(600)).toBeCloseTo(110.1, 1)
  })

  /**
   * Where float64 gives up, pinned rather than papered over.
   *
   * The limits are never crossed in exact arithmetic and never will be. But
   * `140·2^-x` stops resolving against an ulp of 560 at about x = 51, so from
   * roughly t = 3.2 ks the parameters are saturated at the floors rather than
   * merely close to them. That is beyond any run anyone will fly — 53 minutes —
   * and it is the honest reading of "never reaches it", so it is measured here
   * instead of being hidden behind a sample grid that stops at 1800 s.
   */
  it('saturates in float64 only long after any reachable run', () => {
    const saturates = (f: (t: number) => number, limit: number): number => {
      let t = 90
      while (t < 100_000 && f(t) !== limit) t += 1
      return t
    }
    expect(saturates(scrollSpeed, SPEED_LIMIT)).toBeGreaterThan(3_000)
    expect(saturates(gapHeight, GAP_FLOOR)).toBeGreaterThan(3_000)
    expect(saturates(spawnInterval, INTERVAL_FLOOR)).toBeGreaterThan(3_000)
  })
})

describe('thermalOutset', () => {
  it('is 76 px at t = 0 and 22 px from t = 90 s on', () => {
    expect(thermalOutset(0)).toBeCloseTo(76, 9)
    expect(thermalOutset(DIFFICULTY_RAMP_SECONDS)).toBeCloseTo(22, 9)
    for (const t of [90, 150, 240, 600, 3600]) expect(thermalOutset(t)).toBeCloseTo(22, 9)
  })

  it('never falls below the thermal radius — the replacement invariant, as arithmetic', () => {
    for (const t of SAMPLES) expect(thermalOutset(t)).toBeGreaterThanOrEqual(THERMAL_RADIUS)
  })

  it('is non-increasing, and lands on its floor with zero slope', () => {
    let previous = Infinity
    for (const t of SAMPLES) {
      expect(thermalOutset(t)).toBeLessThanOrEqual(previous)
      previous = thermalOutset(t)
    }
    // Quadratic, so the approach flattens out: the last second of phase 1 moves
    // E by less than a hundredth of a pixel, which is what keeps the published
    // cost table monotone through the junction.
    expect(thermalOutset(89) - thermalOutset(90)).toBeLessThan(0.01)
  })
})

describe('the gap always fits the field', () => {
  it('leaves room between GAP_Y_MIN and GAP_Y_MAX_EDGE at every sampled time', () => {
    for (const t of SAMPLES) {
      // 870 - 80 = 790 px of legal band; the gap must leave somewhere to put it.
      expect(gapHeight(t)).toBeLessThan(790)
      // And it never comes within 78 px of being narrower than the kite itself.
      expect(gapHeight(t)).toBeGreaterThan(2 * 16)
    }
  })
})
