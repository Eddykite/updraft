import { describe, expect, it } from 'vitest'
import {
  CEILING_Y,
  FIELD_WIDTH,
  FIXED_DT,
  GAP_Y_MAX_EDGE,
  GAP_Y_MIN,
  GATE_WIDTH,
  GROUND_Y,
  MULTIPLIER_CAP,
  VY_CLAMP,
} from '../src/game/constants.js'
import { nextFloat, createRng, type Rng } from '../src/game/rng.js'
import { createInitialState, multiplierFor, type GameState } from '../src/game/state.js'
import { step } from '../src/game/update.js'

/**
 * Soak (spec §3): 200 runs of random input at the fixed step. No NaN, no
 * unbounded array growth, no state-invariant violation, every run terminates.
 *
 * Random input is not a strategy, so these runs die quickly and often — that is
 * fine. What is being checked is that the simulation stays well-formed no matter
 * what it is fed, including the inputs no human would produce — holding for a
 * solid second at a time, or letting go at exactly the wrong moment, 200 times
 * over.
 */

const RUNS = 200
const MAX_TICKS = 60 * 180 // three minutes of game time; nothing should need it

/** Every invariant that must hold after every single step, for the whole run. */
function checkInvariants(state: GameState, seed: number, tick: number): void {
  const fail = (message: string): never => {
    throw new Error(`seed ${seed}, tick ${tick}: ${message}`)
  }

  for (const [name, value] of [
    ['kite.y', state.kite.y],
    ['kite.vy', state.kite.vy],
    ['elapsed', state.elapsed],
    ['distance', state.distance],
    ['score', state.score],
    ['streak', state.streak],
    ['multiplier', state.multiplier],
    ['spawnTimer', state.spawnTimer],
  ] as const) {
    if (!Number.isFinite(value)) fail(`${name} is ${String(value)}`)
  }

  if (state.kite.y < CEILING_Y) fail(`kite above the ceiling at ${state.kite.y}`)
  // One step of overshoot past the fatal line is allowed: death is detected on
  // the step that crosses it, not predicted before it.
  if (state.kite.y > GROUND_Y) fail(`kite below the ground line at ${state.kite.y}`)
  if (Math.abs(state.kite.vy) > VY_CLAMP) fail(`vy ${state.kite.vy} escaped the clamp`)

  if (state.score < 0) fail(`negative score ${state.score}`)
  if (state.streak < 0) fail(`negative streak ${state.streak}`)
  if (!Number.isInteger(state.score)) fail(`non-integer score ${state.score}`)
  if (state.multiplier < 1 || state.multiplier > MULTIPLIER_CAP) {
    fail(`multiplier ${state.multiplier} out of range`)
  }
  if (state.multiplier !== multiplierFor(state.streak)) {
    fail(`multiplier ${state.multiplier} does not match streak ${state.streak}`)
  }
  if (Math.abs(state.elapsed - state.tick * FIXED_DT) > 1e-6) {
    fail(`elapsed ${state.elapsed} drifted from tick ${state.tick}`)
  }

  // Bounded, not merely finite: a leak here is the bug this test exists to find.
  if (state.gates.length > 6) fail(`${state.gates.length} live gates`)
  if (state.events.length > 16) fail(`${state.events.length} queued events`)

  let previousId = -1
  for (const gate of state.gates) {
    if (!Number.isFinite(gate.x)) fail(`gate ${gate.id} x is ${String(gate.x)}`)
    if (gate.id <= previousId) fail('gates are not in spawn order')
    previousId = gate.id
    if (gate.x + GATE_WIDTH < 0) fail(`gate ${gate.id} was kept after leaving the field`)
    if (gate.x > FIELD_WIDTH) fail(`gate ${gate.id} is beyond the right edge`)
    if (gate.gapY < GAP_Y_MIN - 1e-9) fail(`gate ${gate.id} gap starts above the legal band`)
    if (gate.gapY + gate.gapHeight > GAP_Y_MAX_EDGE + 1e-9) {
      fail(`gate ${gate.id} gap ends below the legal band`)
    }
    const insideTop = gate.thermal.y - gate.thermal.radius > gate.gapY
    const insideBottom = gate.thermal.y + gate.thermal.radius < gate.gapY + gate.gapHeight
    if (!insideTop || !insideBottom) fail(`gate ${gate.id} thermal is not inside its gap`)
  }
}

/** A deliberately silly player: random holds, each lasting a random 1-40 ticks. */
function randomInput(rng: Rng): [Rng, { holding: boolean; hold: number }] {
  const [afterRoll, roll] = nextFloat(rng)
  const [afterLength, length] = nextFloat(afterRoll)
  return [afterLength, { holding: roll < 0.5, hold: 1 + Math.floor(length * 40) }]
}

describe(`soak: ${RUNS} runs of random input`, () => {
  it('stays well-formed and always terminates', () => {
    let totalTicks = 0
    let crashes = 0
    let longest = 0
    let bestScore = 0
    let peakGates = 0

    for (let seed = 0; seed < RUNS; seed += 1) {
      let rng = createRng(0xc0ffee + seed * 7919)
      let state = createInitialState(seed)
      state = step(state, { holding: false, confirmPressed: true }, FIXED_DT)
      expect(state.phase).toBe('playing')

      let holding = false
      let remaining = 0
      let ticks = 0
      let ended = false

      for (; ticks < MAX_TICKS; ticks += 1) {
        if (remaining <= 0) {
          const [next, choice] = randomInput(rng)
          rng = next
          holding = choice.holding
          remaining = choice.hold
        }
        remaining -= 1

        // Events are drained every step, exactly as the shell does it.
        state = step({ ...state, events: [] }, { holding, confirmPressed: false }, FIXED_DT)
        peakGates = Math.max(peakGates, state.gates.length)
        checkInvariants(state, seed, ticks)

        if (state.phase !== 'playing') {
          ended = true
          break
        }
      }

      if (!ended) throw new Error(`seed ${seed} never terminated within ${MAX_TICKS} ticks`)
      expect(state.phase).toBe('gameover')
      expect(state.crashCause).not.toBeNull()

      crashes += 1
      totalTicks += ticks
      longest = Math.max(longest, ticks)
      bestScore = Math.max(bestScore, state.score)
    }

    expect(crashes).toBe(RUNS)
    // Sanity on the soak itself: if every run died on tick 1 the invariants above
    // would never have been exercised.
    expect(totalTicks / RUNS).toBeGreaterThan(60)
    expect(longest).toBeGreaterThan(120)
    expect(bestScore).toBeGreaterThan(0)
    expect(peakGates).toBeLessThanOrEqual(6)
  })

  it('a kite that is never touched always ends up on the ground', () => {
    for (let seed = 0; seed < 20; seed += 1) {
      let state = createInitialState(seed)
      state = step(state, { holding: false, confirmPressed: true }, FIXED_DT)
      let ticks = 0
      while (state.phase === 'playing' && ticks < 600) {
        state = step({ ...state, events: [] }, { holding: false, confirmPressed: false }, FIXED_DT)
        ticks += 1
      }
      expect(state.phase).toBe('gameover')
    }
  })

  it('a kite that is held forever survives at the ceiling until a column stops it', () => {
    let state = createInitialState(7)
    state = step(state, { holding: false, confirmPressed: true }, FIXED_DT)
    let ticks = 0
    while (state.phase === 'playing' && ticks < 60 * 60) {
      state = step({ ...state, events: [] }, { holding: true, confirmPressed: false }, FIXED_DT)
      expect(state.kite.y).toBeGreaterThanOrEqual(CEILING_Y)
      ticks += 1
    }
    // The ceiling is never fatal: whatever ends this run, it is not the ceiling.
    expect(state.crashCause === null || state.crashCause === 'column').toBe(true)
  })
})
