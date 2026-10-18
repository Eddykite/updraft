import { describe, expect, it } from 'vitest'
import { DIFFICULTY_RAMP_SECONDS } from '../src/game/constants.js'
import { gapHeight, progress, scrollSpeed, spawnInterval } from '../src/game/difficulty.js'

/**
 * Difficulty (spec §3): monotonic in t, exact at t = 0, 45, 90 and 300, frozen
 * after 90 s.
 */

const SAMPLES = Array.from({ length: 121 }, (_, i) => i * 2.5) // 0 .. 300 s

describe('progress', () => {
  it('is 0 at the start, 0.5 halfway, 1 at the ramp end', () => {
    expect(progress(0)).toBe(0)
    expect(progress(45)).toBe(0.5)
    expect(progress(DIFFICULTY_RAMP_SECONDS)).toBe(1)
  })

  it('is frozen at 1 after the ramp and never goes negative before it', () => {
    expect(progress(300)).toBe(1)
    expect(progress(9_000)).toBe(1)
    // Defensive: a negative elapsed time is not reachable through step(), but
    // clamping means a caller can never drive the ramp backwards.
    expect(progress(-10)).toBe(0)
  })
})

describe('exact values at the sample times named in the spec', () => {
  const table: ReadonlyArray<readonly [number, number, number, number]> = [
    // t,   speed, gap,   interval
    [0, 180, 260, 1.6],
    [45, 300, 205, 1.25],
    [90, 420, 150, 0.9],
    [300, 420, 150, 0.9],
  ]

  it.each(table)('t = %d s -> speed %d, gap %d, interval %d', (t, speed, gap, interval) => {
    expect(scrollSpeed(t)).toBeCloseTo(speed, 10)
    expect(gapHeight(t)).toBeCloseTo(gap, 10)
    expect(spawnInterval(t)).toBeCloseTo(interval, 10)
  })
})

describe('monotonicity', () => {
  it('speed rises, gap shrinks and the interval shortens, with no reversals', () => {
    let previous = 0
    for (const current of SAMPLES) {
      expect(scrollSpeed(current)).toBeGreaterThanOrEqual(scrollSpeed(previous))
      expect(gapHeight(current)).toBeLessThanOrEqual(gapHeight(previous))
      expect(spawnInterval(current)).toBeLessThanOrEqual(spawnInterval(previous))
      previous = current
    }
  })

  it('is strictly monotonic while the ramp is running', () => {
    expect(scrollSpeed(10)).toBeGreaterThan(scrollSpeed(0))
    expect(gapHeight(10)).toBeLessThan(gapHeight(0))
    expect(spawnInterval(10)).toBeLessThan(spawnInterval(0))
  })

  it('is frozen once the ramp ends: 90 s and 300 s are the same game', () => {
    expect(scrollSpeed(300)).toBe(scrollSpeed(90))
    expect(gapHeight(300)).toBe(gapHeight(90))
    expect(spawnInterval(300)).toBe(spawnInterval(90))
  })
})

describe('the gap always fits the field', () => {
  it('leaves room between GAP_Y_MIN and GAP_Y_MAX_EDGE at every sampled time', () => {
    for (const t of SAMPLES) {
      // 870 - 80 = 790 px of legal band; the gap must leave somewhere to put it.
      expect(gapHeight(t)).toBeLessThan(790)
      expect(gapHeight(t)).toBeGreaterThan(0)
    }
  })
})
