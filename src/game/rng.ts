/**
 * mulberry32 — a small, fast, seeded PRNG (spec §2).
 *
 * Purely functional on purpose: the generator state lives inside `GameState`, so
 * `createInitialState(seed)` plus a recorded input sequence reproduces a run
 * exactly. Nothing here reads a clock or calls `Math.random`.
 *
 * Every function returns `[nextRng, value]`. Never reuse an `Rng` after you have
 * drawn from it — thread the returned one through, or you will draw the same
 * number twice.
 */

export interface Rng {
  /** Internal generator state, unsigned 32-bit. Do not interpret it. */
  readonly state: number
}

/** Create a generator from a seed. Any finite number works; it is coerced to uint32. */
export function createRng(seed: number): Rng {
  return { state: seed >>> 0 }
}

/** Draw a float in [0, 1). */
export function nextFloat(rng: Rng): [Rng, number] {
  const a = (rng.state + 0x6d2b79f5) | 0
  let t = Math.imul(a ^ (a >>> 15), 1 | a)
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
  const value = ((t ^ (t >>> 14)) >>> 0) / 4294967296
  return [{ state: a >>> 0 }, value]
}

/** Draw a float in [min, max). */
export function nextRange(rng: Rng, min: number, max: number): [Rng, number] {
  const [next, value] = nextFloat(rng)
  return [next, min + value * (max - min)]
}

/** Draw an integer in [minInclusive, maxExclusive). */
export function nextInt(rng: Rng, minInclusive: number, maxExclusive: number): [Rng, number] {
  const [next, value] = nextFloat(rng)
  return [next, minInclusive + Math.floor(value * (maxExclusive - minInclusive))]
}

/** Draw a coin flip. Used for which edge of the gap a thermal hugs. */
export function nextBool(rng: Rng): [Rng, boolean] {
  const [next, value] = nextFloat(rng)
  return [next, value < 0.5]
}
