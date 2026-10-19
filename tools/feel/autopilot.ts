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
  VY_CLAMP,
} from '../../src/game/constants.js'
import { scrollSpeed } from '../../src/game/difficulty.js'
import { integrate } from '../../src/game/physics.js'
import { createRng, nextRange, type Rng } from '../../src/game/rng.js'
import { gapCentre } from '../../src/game/spawner.js'
import { step } from '../../src/game/update.js'
import { createInitialState, type Gate, type GameState, type Kite } from '../../src/game/state.js'

/** How the model player chooses what altitude to aim for. */
export type Strategy =
  /**
   * Fly gap centres, always. In v2 this collects **exactly zero** rings, and
   * that is a theorem rather than a tendency: the ring sits `h/2 + E` from the
   * gap centre with `E >= THERMAL_RADIUS`, so the centre line misses the collect
   * disc at every gap height and every difficulty. In v1 the same strategy took
   * 59% of the rings, which is why `collector` minus `safe` measured nothing.
   */
  | 'safe'
  /**
   * Commit to the ring's own altitude and hold it until the ring is taken. A
   * naive player: maximum commitment, maximum exposure, and in v2 usually fatal,
   * because the ring's altitude is lethal 29 px later.
   */
  | 'greedy'
  /**
   * Take every ring it can afford, by flying the **detour**: dive out to the
   * shallowest altitude that still touches the ring, turn back as late as the
   * physics allow, and be inside the gap again before the columns arrive.
   *
   * This is the shape of play the spec's reference model prices, and it is a
   * genuinely different manoeuvre from v1's version of this profile, which was
   * an aiming tweak — the ring used to be inside the gap, so "collecting" was
   * just picking a legal altitude and holding it. Here it is a trip outside the
   * safe corridor and back, and `collector` minus `safe` is what that trip
   * costs with everything else held constant.
   */
  | 'collector'
  /**
   * Take a ring only when the detour is affordable with at least
   * `riskTolerance` px of clearance to spare. Declines the ones that cost more
   * than the player's own error budget.
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

/**
 * The gate the player is currently flying at: the first one not yet behind the kite.
 *
 * `shift` is how far the world will have scrolled by the time the decision being
 * made lands — `scrollSpeed * latency`, in px. Pass it when the answer is being
 * used to *steer*, so the gate is the one the kite will be flying at in the frame
 * the input arrives in; leave it at 0 for present-tense bookkeeping.
 */
function targetGate(state: GameState, shift = 0): Gate | undefined {
  return state.gates.find((gate) => gate.x - shift + GATE_WIDTH >= KITE_X - KITE_RADIUS)
}

/**
 * Execution slack the model collector keeps in hand, in px.
 *
 * `offsetAfterTurningBack` is continuous maths; the controller is a bang-bang
 * loop running at 60 Hz that cannot reverse instantaneously, so a collector that
 * turns back at the exact moment the arithmetic allows arrives a frame late and
 * dies. This is the gap between the two, and it is **measured, not assumed**:
 * swept over the five reference seeds to 150 s, a frame-perfect collector dies
 * on every seed at 9 px of slack, on two of five at 12, and on none at 16.
 *
 * It is a property of this instrument, not of the game — nothing in src/game
 * knows about it, and it must not be read as a gameplay constant. That it comes
 * out equal to KITE_RADIUS is a coincidence of scale, not a derivation.
 */
const COLLECTOR_SLACK = 16

/**
 * Where the kite ends up `seconds` from now if it turns back right now and pulls
 * as hard as it can, measured as an offset from the gap centre toward the ring.
 *
 * Exact rather than conservative, including the speed clamp, because the whole
 * profile is the timing of this one decision: a model player that turns back too
 * early declines affordable rings and under-reports the layer, and one that
 * turns back too late flies into a column and makes every survival number in the
 * report a measurement of the controller instead of the game.
 */
function offsetAfterTurningBack(
  offset: number,
  outwardVelocity: number,
  seconds: number,
  inward: number,
): number {
  if (seconds <= 0) return offset
  // Phase 1: decelerate the dive and accelerate back, until the clamp.
  const toClamp = (outwardVelocity + VY_CLAMP) / inward
  const s1 = Math.min(seconds, Math.max(0, toClamp))
  let y = offset + outwardVelocity * s1 - 0.5 * inward * s1 * s1
  // Phase 2: hold the clamp.
  if (seconds > s1) y -= VY_CLAMP * (seconds - s1)
  return y
}

/**
 * Altitude the player is aiming for.
 *
 * `collector` is the interesting one, and in v2 it is a **detour** rather than a
 * choice of line: the ring sits outside the gap, so there is no legal altitude
 * through the gate that also touches it. The profile is therefore a dive and a
 * recovery, and the only decision in it is *when to turn back*.
 *
 * It commits to the ring's own altitude and holds that commitment until the
 * physics say one more frame of diving would cost it the gate — then it aims at
 * the gap centre and pulls. Because it is still moving outward when it turns, it
 * coasts on past the turn and takes the ring on the way through, which is the
 * same shape of line the reference model in cost.ts prices.
 *
 * It decides on the **led** kite rather than the raw one — where the kite is
 * going once the inputs already in flight have landed, not where it is now.
 * That is not a refinement: judging the turn on the raw state makes the whole
 * profile a cliff, because at 83 ms of latency the kite dives for five more
 * frames after the decision and arrives 40-odd px deeper than the arithmetic
 * assumed. Measured, before the fix was made: a frame-perfect collector survived
 * 120 s and a competent one died at a median of 4 s. A difference that large
 * between two adjacent points on the latency axis is the signature of a
 * controller sitting on its own stability edge, not of an unfair game.
 *
 * The timing has to be computed rather than guessed. Turning back when the ring
 * is *taken* is far too late: at t = 0 the ring is 206 px from the gap centre
 * and the columns arrive 29 px of world travel later, which is 161 ms — not
 * enough to recover from the ring's altitude at any acceleration the kite has.
 *
 * (v1's version of this function deliberately did *not* retarget on collect,
 * because the ring was inside the gap and flinching toward the centre mid-gate
 * killed the thermal profiles. That reasoning is now inverted: the ring is
 * outside the gap, the kite is not between the columns when it takes it, and
 * hauling back in immediately is not a flinch but the manoeuvre.)
 */
function aimFor(state: GameState, profile: PlayerProfile, led: Kite): number {
  // Which gate, in the frame this decision lands in. Everything else here is
  // evaluated there — the kite via `led`, the deadline via `- profile.latency` —
  // and the gate lookup used to be the one term left in the present tense
  // (GOK-23). The consequence was not subtle: for the `latency` worth of frames
  // around every transition the controller steered at the gate *behind* it,
  // whose `gate.x` the kite has already passed, so `seconds` clamped to 0,
  // `offsetAfterTurningBack` returned `offset` unchanged, the limit test tripped
  // and the collector aimed at the old gap's centre — refusing, for those
  // frames, to begin the detour it was about to need. It cost nothing at 0 ms
  // and killed the profile outright from about 4 frames up.
  //
  // Predicting this is no more clairvoyant than `lookAhead` predicting the
  // kite: the world's scroll is deterministic, and `unanticipatedFrames: 0` is
  // *defined* above as the player who predicts the whole queue.
  const shift = scrollSpeed(state.elapsed) * profile.latency
  const gate = targetGate(state, shift)
  if (gate === undefined) return KITE_START_Y

  const centre = gapCentre(gate)
  if (profile.strategy === 'safe') return centre
  // Taken already: the only thing left to fly is the gate.
  if (gate.thermal.collected) return centre
  // A naive player commits to the ring and never reconsiders. Usually fatal,
  // which is the point of having the profile.
  if (profile.strategy === 'greedy') return gate.thermal.y

  const safeHalfWidth = gate.gapHeight / 2 - KITE_RADIUS
  if (safeHalfWidth <= 0) return centre

  // Offsets and velocities are measured toward the ring, so the two sides share
  // one piece of arithmetic. Coming back is a climb when the ring is below and a
  // fall when it is above, and those are not the same number.
  const u = gate.thermal.y > centre ? 1 : -1
  const offset = u * (led.y - centre)
  const outward = u * led.vy
  const inward = u > 0 ? NET_LIFT_ACCEL : GRAVITY

  // Seconds until the gap constraint bites — the moment the kite's rim reaches
  // the column's leading edge — measured from where the *led* kite is, not from
  // now. `led` is the kite once the inputs already in flight have landed, so the
  // gate is `latency` closer by then; pairing a led altitude with a present-tense
  // deadline overstates the time available by exactly the latency, and at 83 ms
  // that is 15 px of dive the arithmetic never sees.
  const seconds = Math.max(
    0,
    (gate.x - (KITE_X + KITE_RADIUS)) / scrollSpeed(state.elapsed) - profile.latency,
  )

  // An opportunist insists on keeping `riskTolerance` px in hand *on top of*
  // the execution slack, which makes it turn back earlier and so take fewer
  // rings. It needs no separate decision about whether a ring is worth it: a
  // dive that cannot reach the collect disc within its own margin simply
  // aborts, which is the same thing a player does.
  const nerve = profile.strategy === 'opportunist' ? profile.riskTolerance : 0
  const limit = safeHalfWidth - COLLECTOR_SLACK - nerve
  if (offsetAfterTurningBack(offset, outward, seconds, inward) >= limit) return centre
  return gate.thermal.y
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

/**
 * The controller's decision for one tick, with no latency queue and no noise.
 *
 * Exported so the golden-replay recorder drives the *same* controller the report
 * does rather than a re-implementation of it: a recorder that quietly disagrees
 * with the model player would freeze a run nobody can reproduce. At zero latency
 * and zero noise the controller is a pure function of the state, which is what
 * makes this equivalent to a step of `playRun` with such a profile.
 */
export function decideHolding(state: GameState, profile: PlayerProfile): boolean {
  return wantsToClimb(
    state.kite.y,
    state.kite.vy,
    aimFor(state, profile, state.kite),
    profile.deadZone,
  )
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
    // Present tense on purpose, unlike the lookup inside `aimFor`: this one is
    // only deciding *when to redraw* the per-gate aim error. Jitter is
    // bookkeeping, not steering, and leading it would resample a frame or two
    // early for no gain.
    const gate = targetGate(state)
    if (gate !== undefined && gate.id !== jitterGateId) {
      jitterGateId = gate.id
      jitter = draw(profile.aimJitter)
    }

    const led = lookAhead(state.kite, pending, profile.unanticipatedFrames)
    const target = aimFor(state, profile, led) + jitter
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
