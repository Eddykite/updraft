import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { FIXED_DT } from '../src/game/constants.js'
import { createInitialState, type GameState, type InputState } from '../src/game/state.js'
import { step } from '../src/game/update.js'

/**
 * Determinism and the golden replay (spec §3).
 *
 * `tests/golden/replay.json` holds one seed, one recorded input script, and the
 * exact run that pair produces. Accidental nondeterminism — an unseeded random,
 * a clock read, a Map iteration order, a mutated input — fails here instantly.
 *
 * An *intentional* change to game feel also fails here, which is the point: the
 * numbers in that file only move when someone decides to move them, in a diff a
 * reviewer can see. There is no regeneration flag, and the recorder that
 * produced the script is deliberately not in the repo.
 */

interface Golden {
  readonly seed: number
  readonly script: { readonly totalTicks: number; readonly runs: readonly number[] }
  readonly expected: {
    readonly tickOfDeath: number
    readonly crashCause: string
    readonly finalScore: number
    readonly elapsedSeconds: number
    readonly gatesSpawned: number
    readonly thermalsCollected: number
    readonly finalStreak: number
    readonly maxMultiplier: number
    readonly maxLiveGates: number
    readonly finalKiteY: number
    readonly finalKiteVy: number
    readonly trajectoryChecksum: number
  }
}

const GOLDEN = JSON.parse(
  readFileSync(fileURLToPath(new URL('./golden/replay.json', import.meta.url)), 'utf8'),
) as Golden

/** Expand the run-length script: alternating runs of ticks, starting RELEASED. */
function expand(runs: readonly number[]): boolean[] {
  const script: boolean[] = []
  runs.forEach((length, index) => {
    for (let i = 0; i < length; i += 1) script.push(index % 2 === 1)
  })
  return script
}

interface Replay {
  readonly final: GameState
  readonly ticks: number
  readonly thermals: number
  readonly maxMultiplier: number
  readonly maxLiveGates: number
  readonly checksum: number
}

/**
 * FNV-1a over the whole trajectory, quantised to 1/1000 px. A run that ends on
 * the same tick with the same score but took a different path through the air
 * still fails.
 */
function replay(seed: number, script: readonly boolean[]): Replay {
  let state = createInitialState(seed)
  state = step(state, { holding: false, confirmPressed: true }, FIXED_DT)

  let ticks = 0
  let thermals = 0
  let maxMultiplier = 1
  let maxLiveGates = 0
  let hash = 0x811c9dc5
  const mix = (n: number): void => {
    hash ^= Math.round(n * 1000) | 0
    hash = Math.imul(hash, 0x01000193) >>> 0
  }

  for (const holding of script) {
    if (state.phase !== 'playing') break
    state = step({ ...state, events: [] }, { holding, confirmPressed: false }, FIXED_DT)
    for (const event of state.events) if (event.type === 'thermal_collected') thermals += 1
    maxMultiplier = Math.max(maxMultiplier, state.multiplier)
    maxLiveGates = Math.max(maxLiveGates, state.gates.length)
    mix(state.kite.y)
    mix(state.kite.vy)
    mix(state.score)
    mix(state.gates.length)
    mix(state.distance)
    ticks += 1
  }

  return { final: state, ticks, thermals, maxMultiplier, maxLiveGates, checksum: hash >>> 0 }
}

const SCRIPT = expand(GOLDEN.script.runs)

describe('the golden replay', () => {
  it('has a script of the length the file claims', () => {
    expect(SCRIPT).toHaveLength(GOLDEN.script.totalTicks)
  })

  it('reproduces the frozen run exactly', () => {
    const result = replay(GOLDEN.seed, SCRIPT)
    const expected = GOLDEN.expected

    // If these fail and you did not mean to change game feel, something in
    // src/game/** stopped being deterministic. If you DID mean to, say so in the
    // pull request and update tests/golden/replay.json on purpose.
    expect(result.ticks).toBe(expected.tickOfDeath)
    expect(result.final.phase).toBe('gameover')
    expect(result.final.crashCause).toBe(expected.crashCause)
    expect(result.final.score).toBe(expected.finalScore)
    expect(result.final.streak).toBe(expected.finalStreak)
    expect(result.final.nextGateId).toBe(expected.gatesSpawned)
    expect(result.thermals).toBe(expected.thermalsCollected)
    expect(result.maxMultiplier).toBe(expected.maxMultiplier)
    expect(result.maxLiveGates).toBe(expected.maxLiveGates)
    expect(result.final.tick).toBe(expected.tickOfDeath)
    expect(result.final.elapsed).toBeCloseTo(expected.elapsedSeconds, 6)
    expect(result.final.kite.y).toBeCloseTo(expected.finalKiteY, 6)
    expect(result.final.kite.vy).toBeCloseTo(expected.finalKiteVy, 9)
    expect(result.checksum).toBe(expected.trajectoryChecksum)
  })

  it('ends with the crash event the shell needs to write the best score', () => {
    const result = replay(GOLDEN.seed, SCRIPT)
    expect(result.final.events).toEqual([
      { type: 'crashed', cause: GOLDEN.expected.crashCause, score: GOLDEN.expected.finalScore },
    ])
  })
})

describe('determinism', () => {
  it('is byte-identical when the same seed and script are replayed twice', () => {
    const first = replay(GOLDEN.seed, SCRIPT)
    const second = replay(GOLDEN.seed, SCRIPT)
    expect(second.checksum).toBe(first.checksum)
    expect(second.final).toEqual(first.final)
  })

  it('gives a different course on a different seed', () => {
    const other = replay(GOLDEN.seed + 1, SCRIPT)
    expect(other.checksum).not.toBe(GOLDEN.expected.trajectoryChecksum)
  })

  it('is unaffected by replaying an unrelated seed in between', () => {
    const before = replay(GOLDEN.seed, SCRIPT)
    replay(12345, SCRIPT)
    const after = replay(GOLDEN.seed, SCRIPT)
    expect(after.checksum).toBe(before.checksum)
  })

  it('never mutates the state, input or events it was handed', () => {
    let state = createInitialState(GOLDEN.seed)
    state = step(state, { holding: false, confirmPressed: true }, FIXED_DT)

    for (let i = 0; i < 400; i += 1) {
      const input: InputState = { holding: i % 7 < 3, confirmPressed: false }
      const snapshot = structuredClone(state)
      const inputSnapshot = structuredClone(input)
      const next = step(state, input, FIXED_DT)
      expect(state).toEqual(snapshot)
      expect(input).toEqual(inputSnapshot)
      expect(next).not.toBe(state)
      state = next
      if (state.phase !== 'playing') break
    }
  })

  it('reproduces a run from the seed shown on the game-over screen', () => {
    // The game-over screen prints state.seed; that plus the input script is all a
    // bug report needs.
    const run = replay(GOLDEN.seed, SCRIPT)
    expect(run.final.seed).toBe(GOLDEN.seed)
    const reproduced = replay(run.final.seed, SCRIPT)
    expect(reproduced.final).toEqual(run.final)
  })
})

describe('restarting', () => {
  const press: InputState = { holding: false, confirmPressed: true }
  const idle: InputState = { holding: false, confirmPressed: false }

  it('starts the first run on the seed the shell chose', () => {
    const started = step(createInitialState(4242), press, FIXED_DT)
    expect(started.phase).toBe('playing')
    expect(started.seed).toBe(4242)
    expect(started.events).toEqual([{ type: 'run_started' }])
    expect(started.tick).toBe(0)
  })

  it('does nothing on the title screen until something is pressed', () => {
    const title = createInitialState(1)
    expect(step(title, idle, FIXED_DT)).toBe(title)
  })

  it('does not step while paused', () => {
    const paused: GameState = { ...createInitialState(1), phase: 'paused' }
    expect(step(paused, { holding: true, confirmPressed: true }, FIXED_DT)).toBe(paused)
  })

  it('gives each restart a fresh course, deterministically', () => {
    const dead = replay(GOLDEN.seed, SCRIPT).final
    const restarted = step(dead, press, FIXED_DT)
    expect(restarted.phase).toBe('playing')
    expect(restarted.score).toBe(0)
    expect(restarted.tick).toBe(0)
    expect(restarted.gates).toEqual([])
    expect(restarted.crashCause).toBeNull()
    expect(restarted.seed).not.toBe(dead.seed)
    // Same dead state in, same next seed out: a whole session is deterministic.
    expect(step(dead, press, FIXED_DT).seed).toBe(restarted.seed)
  })

  it('carries undrained events across the restart', () => {
    const dead = replay(GOLDEN.seed, SCRIPT).final
    expect(dead.events.length).toBeGreaterThan(0)
    const restarted = step(dead, press, FIXED_DT)
    expect(restarted.events).toEqual([...dead.events, { type: 'run_started' }])
  })
})
