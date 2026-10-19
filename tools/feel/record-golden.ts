/**
 * Re-record `tests/golden/replay.json`.
 *
 * The golden replay is a seed, a frozen input script, and the exact run that
 * pair produces. It is not a test of play quality — it is the tripwire for
 * accidental nondeterminism and for gameplay changes made without saying so.
 *
 * ## Why this file exists now, when v1 deliberately had no recorder
 *
 * v1's replay.json said the recorder was kept out of the repo on purpose, so
 * that updating the numbers meant deciding to update them, and described the
 * recorder in prose for anyone who had to write it again. v2 is exactly the
 * situation that prose was written for — and the prose described a controller
 * that aimed at "the next gate's thermal clamped 46 px inside the gap edges",
 * which is a line that no longer exists, because the ring is no longer inside
 * the gap. Rebuilding it from the description would have produced a recorder
 * for a game that is not this one.
 *
 * So the recorder is now the model player, which is already in the repo, already
 * flies a real collecting line, and is already pinned by tests of its own. The
 * guard against a casually-updated golden is unchanged in substance: this is a
 * separate command that nothing runs automatically, and its output is a diff a
 * reviewer can see.
 *
 * Run with `pnpm feel:golden`, which prints the file; redirect it over
 * tests/golden/replay.json, and say in the pull request that you did.
 */

import { FIXED_DT } from '../../src/game/constants.js'
import { createInitialState } from '../../src/game/state.js'
import { step } from '../../src/game/update.js'
import { decideHolding, type PlayerProfile } from './autopilot.js'

export const GOLDEN_SEED = 20261018

/** The hands that fly the recording: a frame-perfect collector. */
export const GOLDEN_PROFILE: PlayerProfile = {
  strategy: 'collector',
  latency: 0,
  deadZone: 0,
  unanticipatedFrames: 0,
  aimJitter: 0,
  perception: 0,
  riskTolerance: 0,
}

/** How long the recorded player flies before letting go for good. */
export const GOLDEN_FLYING_TICKS = 3_000

/**
 * Capture the input script the model player produces, then release the button
 * and let the kite fall until it dies.
 *
 * `playRun` reports outcomes rather than inputs, so the controller is driven
 * here through `decideHolding` — the same decision function, read for its
 * inputs instead of its statistics. The release tail is what makes the run
 * *end*: a competent
 * collector does not crash on its own inside the window, and a golden replay
 * that never reaches game over cannot pin a tick of death.
 */
export function recordScript(seed: number, flyingTicks: number): boolean[] {
  const script: boolean[] = []
  let state = step(createInitialState(seed), { holding: false, confirmPressed: true }, FIXED_DT)

  for (let tick = 0; tick < flyingTicks && state.phase === 'playing'; tick += 1) {
    const holding = decideHolding(state, GOLDEN_PROFILE)
    script.push(holding)
    state = step({ ...state, events: [] }, { holding, confirmPressed: false }, FIXED_DT)
  }

  // Let go. The kite falls, and the run ends.
  let guard = 0
  while (state.phase === 'playing') {
    if (++guard > 10_000) throw new Error('the released kite never died — check the ground rule')
    script.push(false)
    state = step({ ...state, events: [] }, { holding: false, confirmPressed: false }, FIXED_DT)
  }
  return script
}

/** Run-length encode the script: alternating runs of ticks, starting RELEASED. */
export function encode(script: readonly boolean[]): number[] {
  const runs: number[] = []
  let current = false
  let length = 0
  for (const holding of script) {
    if (holding === current) {
      length += 1
    } else {
      runs.push(length)
      current = holding
      length = 1
    }
  }
  runs.push(length)
  return runs
}

/**
 * Replay a script and summarise the run, in the shape replay.json records.
 *
 * tests/determinism.test.ts has its own copy of this walk, deliberately, so
 * that editing one and forgetting the other fails loudly instead of quietly
 * agreeing. Be precise about what that buys, though: the two are a verbatim
 * copy, so a misconception shared by both is invisible to both. It pins the
 * recorded numbers against drift, not the reasoning behind them.
 */
function summarise(seed: number, script: readonly boolean[]): Record<string, unknown> {
  let state = step(createInitialState(seed), { holding: false, confirmPressed: true }, FIXED_DT)
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

  return {
    tickOfDeath: ticks,
    crashCause: state.crashCause,
    finalScore: state.score,
    elapsedSeconds: Number(state.elapsed.toFixed(6)),
    gatesSpawned: state.nextGateId,
    thermalsCollected: thermals,
    finalStreak: state.streak,
    maxMultiplier,
    maxLiveGates,
    finalKiteY: Number(state.kite.y.toFixed(6)),
    finalKiteVy: Number(state.kite.vy.toFixed(6)),
    trajectoryChecksum: hash >>> 0,
  }
}

// --- entry point -------------------------------------------------------------
// Run with `pnpm feel:golden > tests/golden/replay.json`, on purpose, and say so
// in the pull request.

const script = recordScript(GOLDEN_SEED, GOLDEN_FLYING_TICKS)
console.error(`recorded ${script.length} ticks on seed ${GOLDEN_SEED}`)
console.log(
  JSON.stringify(
    {
      $schema: 'tests/determinism.test.ts reads this file; tools/feel/record-golden.ts writes it.',
      about: [
        'UPDRAFT golden replay (spec v2 §3). Seed + a recorded input script, frozen with the',
        'exact outcome it produces under the constants in src/game/constants.ts.',
        '',
        'If this file has to change, that is a game-feel or mechanic change and it must be',
        'stated as one in the pull request. There is no regeneration flag: updating these',
        'numbers means running tools/feel/record-golden.ts on purpose and saying so.',
        '',
        'Regenerated once for spec v2 (GOK-17), in the same commit as the changes that',
        'required it. Every gameplay constant that moved changes this file, and a silently',
        'updated golden is how a tuning change hides.',
        '',
        'How the script was recorded: the model player in tools/feel/ flying a frame-perfect',
        "collector line (strategy 'collector', no latency, no noise) for 3000 ticks, then",
        'releasing the button for good so the kite falls and the run ends. v1 kept its',
        'recorder out of the repo and described it in prose instead; that prose described a',
        'line aimed 46 px inside the gap edges, which is a line v2 does not have.',
      ],
      seed: GOLDEN_SEED,
      script: { totalTicks: script.length, runs: encode(script) },
      expected: summarise(GOLDEN_SEED, script),
    },
    null,
    2,
  ),
)
