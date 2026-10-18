/**
 * A model player, so feel questions get measured instead of guessed.
 *
 * Feel tuning (spec §8.1) is a judgement call, but two of the questions on
 * GOK-5 are not opinions — "is a two-minute run reachable" and "do thermals
 * read as worth the risk" are both claims about the *distribution of outcomes*
 * over many runs, and a human playing a handful of them cannot see that.
 *
 * So: drive the real `step()` with a synthetic player. Nothing here is imported
 * by the game; this tree is a measuring instrument, not shipped code.
 *
 * The controller is time-optimal bang-bang on a target altitude — accelerate
 * toward it, then brake so as to arrive with vy ~ 0. That is what a competent
 * player approximates, and it is deliberately *not* perfect: `latency` delays
 * what it sees and `deadZone` stops it correcting errors a human would not
 * notice, which is where the difference between "fair" and "twitchy" shows up.
 */

import {
  FIXED_DT,
  GATE_WIDTH,
  GRAVITY,
  KITE_RADIUS,
  KITE_START_Y,
  KITE_X,
  NET_LIFT_ACCEL,
} from '../../src/game/constants.js'
import { integrate } from '../../src/game/physics.js'
import { createRng, nextRange, type Rng } from '../../src/game/rng.js'
import { gapCentre } from '../../src/game/spawner.js'
import { step } from '../../src/game/update.js'
import { createInitialState, type Gate, type GameState, type Kite } from '../../src/game/state.js'

/** How the model player chooses what altitude to aim for. */
export type Strategy =
  /** Fly gap centres. Never aims at a thermal — though see `collector` on why it may still get some. */
  | 'safe'
  /** Aim at the ring's centre, every time. A naive player: maximum commitment, maximum exposure. */
  | 'greedy'
  /**
   * Take every ring, but on the cheapest line that still touches it — the point
   * of the collect band nearest the gap centre.
   *
   * This is what a competent player actually does, and it is the profile that
   * isolates the true price of a thermal: `collector` minus `safe` is the cost
   * of the reward, with strategy held constant everywhere else.
   */
  | 'collector'
  /**
   * Take a ring only when the cheapest collecting line still leaves at least
   * `riskTolerance` px of clearance. Declines the ones that cost more than the
   * player's own error budget.
   */
  | 'opportunist'

export interface PlayerProfile {
  readonly strategy: Strategy
  /** Seconds between deciding and the input landing. 0 = frame-perfect. */
  readonly latency: number
  /** Altitude error (px) the player does not bother correcting. */
  readonly deadZone: number
  /**
   * How many of the frames already in flight the player FAILS to predict.
   *
   * An integer, because the controller can only ever respond to an integer: it
   * replays `pending.length - unanticipatedFrames` committed inputs and steers on
   * the altitude that produces. This used to be a fraction in [0, 1] of the
   * pending queue, which was a mistake the GOK-14 review caught — `round(frac *
   * pending.length)` meant a 5-frame queue had exactly six reachable controllers,
   * `0.7` and `0.8` were byte-identical, and "lead 0.7" denoted a *different*
   * controller at every latency. A sweep along that axis could not distinguish a
   * cliff in the game from the axis's own resolution. This is the quantity the
   * controller actually responds to, so it is the quantity that gets swept.
   *
   * This knob matters more than any game constant, and getting it wrong is the
   * easiest way to measure the controller instead of the game.
   *
   * At `latency / FIXED_DT` (nothing predicted) the player steers on what they
   * saw `latency` ago. That is a closed loop with pure delay, and bang-bang
   * control plus pure delay oscillates — it dies in seconds no matter how UPDRAFT
   * is tuned. At 0 they replay every input already in flight, which makes latency
   * cost them *nothing*: in a deterministic world, perfectly predicted delay is
   * not delay. Both ends are fictions; a human is somewhere in between, leading
   * the kite with a rough internal model of it. Values above the queue length are
   * clamped, so a profile can be reused across latencies.
   */
  readonly unanticipatedFrames: number
  /**
   * Half-width (px) of random aim error, resampled per gate. Models imprecision.
   *
   * Half-width, not std-dev: `draw` samples uniformly on [-s, s], so sigma is
   * s/sqrt(3) ~ 0.58s. The docs here used to say std-dev, which overstated every
   * number on this axis by about 1.7x.
   */
  readonly aimJitter: number
  /**
   * Half-width (px) — same uniform distribution as `aimJitter` — of error in the
   * player's read of their *own* altitude, resampled every frame.
   *
   * It perturbs the control loop continuously rather than once per gate. It
   * stands in for everything a model player otherwise gets for free: reading a
   * moving kite against a parallax background, estimating vertical speed by eye,
   * and the fact that attention is not a constant.
   *
   * It is *not* the dominant difficulty axis, despite what sensitivity.ts used to
   * claim: white noise fed into a bang-bang controller is largely filtered by the
   * kite's own inertia, and at full prediction even +-32px leaves survival
   * untouched. `unanticipatedFrames` is the axis that bites.
   */
  readonly perception: number
  /**
   * Clearance (px) to the nearer column that an `opportunist` insists on before
   * going for a ring. Ignored by the other strategies.
   *
   * This is a step function, not a dial, and the step is the finding rather than
   * a defect: see `opportunistKnee` in geometry.ts. The clearance of the cheapest
   * collecting line is `min(h/2, THERMAL_EDGE_INSET + THERMAL_RADIUS) -
   * KITE_RADIUS`, which is 67px for most of the ramp and 59px at its hardest, so
   * every tolerance below 59 takes every ring and every tolerance above 67
   * declines every ring. Reporting a tolerance from the first band as if it
   * measured caution is reporting an identity — the GOK-14 review was right about
   * that, and report.ts now prints the knee instead.
   */
  readonly riskTolerance: number
}

export interface RunResult {
  readonly seed: number
  /** Seconds survived. */
  readonly duration: number
  readonly score: number
  readonly gatesPassed: number
  readonly thermalsCollected: number
  /**
   * Gates that went by with their ring untaken.
   *
   * Counted per gate id, not as `gatesPassed - thermalsCollected`: a ring is
   * collected on contact but its gate only counts as passed when its trailing
   * edge clears the kite, so the subtraction went negative whenever a run ended
   * between those two moments — and printed `rings 101% of gates`.
   */
  readonly thermalsMissed: number
  /** Rings taken on gates that are fully behind the kite. The honest denominator pair. */
  readonly thermalsTakenOnPassedGates: number
  readonly peakMultiplier: number
  readonly crashCause: 'ground' | 'column' | null
  /**
   * True if the run hit `maxSeconds` instead of ending.
   *
   * Every duration-based statistic is censored by this, and at the competent
   * operating point *every* run is — the ramp freezes at DIFFICULTY_RAMP_SECONDS,
   * so a player still alive then is alive forever and the cutoff is the only
   * thing making their duration finite. Report exposure-based rates (deaths per
   * gate) rather than mean durations whenever this is true.
   */
  readonly censored: boolean
}

/** The gate the player is currently flying at: the first one not yet behind the kite. */
function targetGate(state: GameState): Gate | undefined {
  return state.gates.find((gate) => gate.x + GATE_WIDTH >= KITE_X - KITE_RADIUS)
}

/**
 * Altitude the player is aiming for.
 *
 * `collector` is the interesting one: it takes every ring on the *cheapest* line
 * that touches it rather than aiming at the ring's centre, which is what a
 * competent player does and what makes `collector` minus `safe` a clean read on
 * what a thermal actually costs.
 *
 * `opportunist` then declines the rings whose cheapest line is still tighter
 * than their nerve. If the opportunist ends up collecting nearly all of them,
 * the "risk" in the risk/reward layer is not real.
 */
function aimFor(state: GameState, profile: PlayerProfile): number {
  const gate = targetGate(state)
  if (gate === undefined) return KITE_START_Y

  const centre = gapCentre(gate)
  if (profile.strategy === 'safe') return centre

  // Note the absence of a `gate.thermal.collected` test. An earlier version
  // retargeted to the gap centre the instant the ring was taken, which put a
  // step change into the target *while the kite was between the columns* and
  // killed the thermal-chasing profiles within 33 ms of latency. That was the
  // controller, not the game. No player flinches toward the centre of a gap they
  // are already inside, and they do not need to: the ring always sits inside the
  // safe band, so its altitude is a legal line through the gate. Commit to the
  // altitude and hold it until the gate is behind you.
  if (profile.strategy === 'greedy') return gate.thermal.y

  // The cheapest collecting line: clearance to the nearer column is maximised at
  // the gap centre and falls off linearly either way, so the best altitude that
  // still touches the ring is the point of the collect band nearest the centre.
  const safeLow = gate.gapY + KITE_RADIUS
  const safeHigh = gate.gapY + gate.gapHeight - KITE_RADIUS
  if (safeLow > safeHigh) return centre
  const reach = gate.thermal.radius + KITE_RADIUS
  const nearest = Math.min(Math.max(centre, gate.thermal.y - reach), gate.thermal.y + reach)
  const cheapest = Math.min(Math.max(nearest, safeLow), safeHigh)

  if (profile.strategy === 'collector') return cheapest

  // opportunist: only if that line still leaves them room for their own error.
  const clearance = Math.min(cheapest - safeLow, safeHigh - cheapest)
  return clearance >= profile.riskTolerance ? cheapest : centre
}

/**
 * Bang-bang: hold when climbing is needed, release in time to arrive with vy ~ 0.
 * Braking distances use the real accelerations, so the model player is exactly as
 * capable as the physics allows and no more.
 */
function wantsToClimb(y: number, vy: number, target: number, deadZone: number): boolean {
  const error = y - target // positive: the kite is below its target, must climb
  if (Math.abs(error) <= deadZone) return vy > 0 // hold station against gravity

  if (error > 0) {
    // Climbing. Release early enough that gravity arrests the climb on target.
    const brakingDistance = vy < 0 ? (vy * vy) / (2 * GRAVITY) : 0
    return brakingDistance < error
  }
  // Descending. Start holding early enough that lift arrests the fall on target.
  const brakingDistance = vy > 0 ? (vy * vy) / (2 * NET_LIFT_ACCEL) : 0
  return brakingDistance >= -error
}

/**
 * Integrate the kite forward through the inputs already committed, to steer on
 * where it is going rather than where it was.
 *
 * It replays all but `unanticipatedFrames` of `pending` — the decisions already
 * in flight — rather than assuming the current input is held throughout. Those
 * are the inputs that *will* land before this decision does, so they are exactly
 * what the kite is about to do. Leaving the last few unreplayed is how an
 * imperfect lead is modelled: the player sees part of the way to where the kite
 * is going, and the remainder is prediction error they have to correct for
 * later.
 */
function lookAhead(kite: Kite, pending: readonly boolean[], unanticipatedFrames: number): Kite {
  const blind = Math.min(Math.max(Math.round(unanticipatedFrames), 0), pending.length)
  const steps = pending.length - blind
  let ahead = kite
  for (let i = 0; i < steps; i += 1) ahead = integrate(ahead, pending[i] as boolean, FIXED_DT)
  return ahead
}

/** Frames of input queue a given latency produces. The resolution of the lead axis. */
export function latencyFrames(latency: number): number {
  return Math.max(0, Math.round(latency / FIXED_DT))
}

/** Play one run to its crash (or to `maxSeconds`) and report what happened. */
export function playRun(seed: number, profile: PlayerProfile, maxSeconds = 300): RunResult {
  let state = step(createInitialState(seed), { holding: false, confirmPressed: true }, FIXED_DT)

  const latencySteps = latencyFrames(profile.latency)
  const pending: boolean[] = Array.from({ length: latencySteps }, () => false)

  // Both noise sources come from one generator seeded off the run, so the whole
  // report is reproducible: two invocations of `pnpm feel` are comparable.
  let noiseRng: Rng = createRng(seed ^ 0x5f3759df)
  let jitterGateId = -1
  let jitter = 0

  function draw(spread: number): number {
    if (spread === 0) return 0
    const [next, value] = nextRange(noiseRng, -spread, spread)
    noiseRng = next
    return value
  }

  let gatesPassed = 0
  let thermalsCollected = 0
  let thermalsMissed = 0
  let thermalsTakenOnPassedGates = 0
  const collectedGates = new Set<number>()
  let peakMultiplier = 1

  while (state.phase === 'playing' && state.elapsed < maxSeconds) {
    const gate = targetGate(state)
    if (gate !== undefined && gate.id !== jitterGateId) {
      jitterGateId = gate.id
      jitter = draw(profile.aimJitter)
    }

    const target = aimFor(state, profile) + jitter
    const led = lookAhead(state.kite, pending, profile.unanticipatedFrames)
    // The player reads their own altitude imperfectly; velocity is left clean,
    // since differentiating noise would model a sensor rather than a person.
    const decision = wantsToClimb(
      led.y + draw(profile.perception),
      led.vy,
      target,
      profile.deadZone,
    )

    // The decision takes `latency` to reach the game. The queue is always both
    // pushed and shifted so its length stays exactly `latencySteps` — at zero
    // latency that returns the decision just made, with no special case.
    pending.push(decision)
    const holding = pending.shift() as boolean

    state = step(state, { holding, confirmPressed: false }, FIXED_DT)

    for (const event of state.events) {
      // thermal_collected always precedes its gate_passed — contact happens
      // inside the gate, the pass is scored on its trailing edge — so the set is
      // always populated by the time the gate is counted.
      if (event.type === 'thermal_collected') {
        thermalsCollected += 1
        collectedGates.add(event.gateId)
      }
      if (event.type === 'gate_passed') {
        gatesPassed += 1
        if (collectedGates.has(event.gateId)) thermalsTakenOnPassedGates += 1
        else thermalsMissed += 1
      }
      if (event.type === 'multiplier_up')
        peakMultiplier = Math.max(peakMultiplier, event.multiplier)
    }
    state = { ...state, events: [] }
  }

  return {
    seed,
    duration: state.elapsed,
    score: state.score,
    gatesPassed,
    thermalsCollected,
    thermalsMissed,
    thermalsTakenOnPassedGates,
    peakMultiplier,
    crashCause: state.crashCause,
    censored: state.crashCause === null,
  }
}
