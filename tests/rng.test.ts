import { describe, expect, it } from 'vitest'
import { createRng, nextBool, nextFloat, nextInt, nextRange } from '../src/game/rng.js'

/**
 * The golden sequences below are the point of this file.
 *
 * Determinism is load-bearing: `createInitialState(seed)` plus a recorded input
 * sequence has to reproduce a run exactly (spec §2), and the golden-replay and
 * 10,000-seed spawner property tests in spec §3 are built on this generator.
 * If anyone "optimises" mulberry32, these values change and the build fails —
 * which is exactly the intent.
 */

const SEQUENCE_SEED_1 = [
  0.6270739405881613, 0.002735721180215478, 0.5274470399599522, 0.9810509674716741,
  0.9683778982143849,
]

const SEQUENCE_SEED_42 = [
  0.6011037519201636, 0.44829055899754167, 0.8524657934904099, 0.6697340414393693,
  0.17481389874592423,
]

function take(seed: number, count: number): number[] {
  let rng = createRng(seed)
  const out: number[] = []
  for (let i = 0; i < count; i += 1) {
    const [next, value] = nextFloat(rng)
    rng = next
    out.push(value)
  }
  return out
}

describe('mulberry32', () => {
  it('produces a known sequence for seed 1', () => {
    expect(take(1, 5)).toEqual(SEQUENCE_SEED_1)
  })

  it('produces a known sequence for seed 42', () => {
    expect(take(42, 5)).toEqual(SEQUENCE_SEED_42)
  })

  it('produces a known sequence for seed 0', () => {
    expect(take(0, 3)).toEqual([0.26642920868471265, 0.0003297457005828619, 0.2232720274478197])
  })

  it('is reproducible: the same seed always replays the same run', () => {
    expect(take(20261017, 50)).toEqual(take(20261017, 50))
  })

  it('is purely functional: drawing does not mutate the generator it was given', () => {
    const rng = createRng(7)
    const [, first] = nextFloat(rng)
    const [, again] = nextFloat(rng)
    expect(again).toBe(first)
    expect(rng.state).toBe(7)
  })

  it('different seeds diverge immediately', () => {
    expect(take(1, 5)).not.toEqual(take(2, 5))
  })

  it('stays within [0, 1) over a long run', () => {
    let rng = createRng(12345)
    let min = 1
    let max = 0
    let sum = 0
    const draws = 50_000
    for (let i = 0; i < draws; i += 1) {
      const [next, value] = nextFloat(rng)
      rng = next
      expect(Number.isFinite(value)).toBe(true)
      if (value < min) min = value
      if (value > max) max = value
      sum += value
    }
    expect(min).toBeGreaterThanOrEqual(0)
    expect(max).toBeLessThan(1)
    // Not a statistics suite — just enough to catch a generator that has collapsed.
    expect(sum / draws).toBeCloseTo(0.5, 2)
  })
})

describe('derived draws', () => {
  it('nextRange maps into [min, max)', () => {
    let rng = createRng(99)
    for (let i = 0; i < 1000; i += 1) {
      const [next, value] = nextRange(rng, 80, 870)
      rng = next
      expect(value).toBeGreaterThanOrEqual(80)
      expect(value).toBeLessThan(870)
    }
  })

  it('nextInt returns integers in [min, max)', () => {
    let rng = createRng(5)
    const seen = new Set<number>()
    for (let i = 0; i < 1000; i += 1) {
      const [next, value] = nextInt(rng, 3, 7)
      rng = next
      expect(Number.isInteger(value)).toBe(true)
      expect(value).toBeGreaterThanOrEqual(3)
      expect(value).toBeLessThan(7)
      seen.add(value)
    }
    expect(seen).toEqual(new Set([3, 4, 5, 6]))
  })

  it('nextBool is roughly fair — thermals pick a gap edge with it', () => {
    let rng = createRng(2024)
    let heads = 0
    const flips = 10_000
    for (let i = 0; i < flips; i += 1) {
      const [next, value] = nextBool(rng)
      rng = next
      if (value) heads += 1
    }
    expect(heads / flips).toBeGreaterThan(0.45)
    expect(heads / flips).toBeLessThan(0.55)
  })
})
