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
import { scrollSpeed } from '../../src/game/difficulty.js'
import { integrate } from '../../src/game/physics.js'
import { createRng, nextRange, type Rng } from '../../src/game/rng.js'
import { gapCentre, reach } from '../../src/game/spawner.js'
import { step } from '../../src/game/update.js'
import {
  createInitialState,
  thermalX,
  type Gate,
  type GameState,
  type Kite,
} from '../../src/game/state.js'
import { DIP_DEPTHS, roundTrip } from './geometry.js'

/** How the model player chooses what altitude to aim for. */
export type Strategy =
  /** Fly gap centres. Never leaves the safe line, and so never takes a ring at all. */
  | 'safe'
  /** Aim at the ring's centre, every time. A naive player: maximum commitment, maximum exposure. */
  | 'greedy'
  /**
   * Dip only as far as the very edge of the collect band — the shallowest line
   * that touches the ring at all.
   *
   * Under the old placement this was the *cheapest* line and therefore what a
   * competent player flew. Under the revised one it is a trap, and keeping it as
   * a profile is how that gets measured rather than asserted: touching from the
   * edge of the band only happens at the single instant the ring is level with
   * the kite, which is the latest possible contact and the least time to recover.
   */
  | 'skimmer'
  /**
   * Dip to the depth with the most room for error at the current difficulty —
   * `bestDipDepth` in geometry.ts, somewhere between the two extremes above.
   *
   * This is what a competent player converges on, and it is the profile that
   * isolates the true price of a thermal: `collector` minus `safe` is the cost
   * of the reward, with strategy held constant everywhere else.
   */
  | 'collector'
  /**
   * Fly the collector's line, but only commit to a ring when the round trip —
   * get to the dip, touch it, climb back — has at least `riskTolerance` px of
   * spare reach at both ends. Otherwise stay on the gap centre and give up the
   * streak.
   *
   * Unlike the old opportunist this is a genuine per-gate judgement: the climb
   * out is fixed by the ramp, but the *approach* depends on where the previous
   * gap left the kite, so the same tolerance accepts some rings and declines
   * others on the same run.
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
   * Spare reach (px) an `opportunist` insists on, at both ends of the round trip,
   * before committing to a ring. Ignored by the other strategies.
   *
   * The GOK-14 review was right that the old version of this knob was a step
   * function of its own definition: the clearance it tested was a constant, so
   * every tolerance below it took every ring and every tolerance above it took
   * none, and quoting a number from inside the first band as caution was quoting
   * an identity. The test is seed-dependent now — the climb out is fixed by the
   * ramp, but the approach depends on where the previous gap left the kite — so
   * the same tolerance can accept one ring and decline the next. report.ts prints
   * the accept rate, which is only a meaningful number because of that.
   */
  readonly riskTolerance: number
  /**
   * Override for `safetyMargin` — how close to a column this player will lean
   * when positioning for the next ring. Omit to derive it from the noise terms.
   *
   * It exists so report.ts can sweep it. The margin is the instrument's own
   * caution, it is subtracted from the approach to every ring, and a design whose
   * feasibility rested on it would be a design measured by my own timidity rather
   * than by the game.
   */
  readonly leanMargin?: number
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
  /** Gates an `opportunist` reached a decision about. 0 for every other strategy. */
  readonly ringsOffered: number
  /**
   * Of those, the ones it decided against. The pair is the only honest way to
   * report caution: a count of declines alone says nothing without its
   * denominator, and the old `opportunist` had no denominator at all because it
   * could never decline anything.
   */
  readonly ringsDeclined: number
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

/** px of scroll before this gate's trailing edge is clear of the kite. */
function scrollUntilClear(gate: Gate): number {
  return gate.x + GATE_WIDTH - (KITE_X - KITE_RADIUS)
}

/** px of scroll before this gate's ring first comes within reach, dipping `depth` short. */
function scrollUntilContact(gate: Gate, depth: number): number {
  const reachPx = gate.thermal.radius + KITE_RADIUS
  const closing = Math.sqrt(Math.max(0, reachPx * reachPx - depth * depth))
  return thermalX(gate) - KITE_X - closing
}

/** The altitudes of a gate's safe band — every y in it clears both columns. */
function safeBand(gate: Gate): { low: number; high: number } {
  return { low: gate.gapY + KITE_RADIUS, high: gate.gapY + gate.gapHeight - KITE_RADIUS }
}

/** Is this gate's ring still worth aiming at — uncollected, and not yet swept past? */
function ringIsLive(gate: Gate): boolean {
  return !gate.thermal.collected && thermalX(gate) >= KITE_X - (gate.thermal.radius + KITE_RADIUS)
}

/**
 * The altitude a ring-seeking strategy dips to on this gate: `depth` px short of
 * the ring's centre, on the gap's side of it.
 */
function dipLine(gate: Gate, depth: number): number {
  const towardGap = gate.thermal.y > gapCentre(gate) ? -1 : 1
  return gate.thermal.y + towardGap * depth
}

/** The altitude a ring-seeking strategy wants on this gate, ignoring everything else. */
function ringLine(gate: Gate, profile: PlayerProfile): number {
  switch (profile.strategy) {
    case 'greedy':
      return dipLine(gate, DIP_DEPTHS.greedy)
    case 'skimmer':
      return dipLine(gate, DIP_DEPTHS.skimmer)
    default:
      return dipLine(gate, DIP_DEPTHS.collector)
  }
}

/**
 * Altitude the player is aiming for.
 *
 * Two phases, and the second one is where the first pass of this rewrite went
 * wrong badly enough to be worth recording. The obvious controller — aim at the
 * ring ahead of you, then at the gap once you have it — kills every collecting
 * profile inside ten seconds, because by the time a gate is behind the kite the
 * *next* gate's ring is already about 70 px away. There is not enough open air
 * between two gates to start the excursion from a standing start at the gap
 * centre, at any difficulty.
 *
 * What a player actually does, and what this does now, is sit on the side of the
 * gap they are flying through that the next ring is on. The gap's safe band is
 * roughly 120 px tall, so leaning on it is most of the approach, taken during the
 * traverse where it is free. The band is inset by the player's own error budget
 * first (`safetyMargin`), because leaning on an edge you cannot hold is not a
 * plan.
 *
 * That it took a rewrite to find this is itself a finding about the mechanic: the
 * skill it asks for is *positioning a gate early*, not reacting when the ring
 * arrives. See the feel notes on GOK-5.
 */
function aimFor(state: GameState, profile: PlayerProfile, decide: (gate: Gate) => boolean): number {
  const gate = targetGate(state)
  if (gate === undefined) return KITE_START_Y

  const centre = gapCentre(gate)
  // `safe` is the baseline every other profile is measured against, so it stays
  // exactly what it says: gap centres, never anything else.
  if (profile.strategy === 'safe') return centre

  // Phase 1: the ring ahead of the gate is still live, and we are in the open air
  // in front of the columns. Fly it.
  if (ringIsLive(gate) && decide(gate)) {
    return ringLine(gate, profile)
  }

  // Phase 2: through the gap, with the next ring already in mind. Lean toward it,
  // but only as far as this gap's safe band minus the player's own error budget —
  // leaning on an edge you cannot hold is not a plan, and the lean is the one
  // thing in this file that trades the current gate's safety for the next ring.
  const next = state.gates.find((g) => g.id === gate.id + 1)
  if (next === undefined || !ringIsLive(next) || !decide(next)) return centre

  return leanToward(ringLine(next, profile), gate, safetyMargin(profile))
}

/**
 * How close to a column this player will fly when leaning toward the next ring.
 *
 * Quadrature, not a sum: the dead zone, the per-gate aim error and the per-frame
 * read error are independent, so adding their worst cases would model a player
 * who is maximally wrong in three ways at once and would overstate the margin by
 * about 1.7x. The 4px floor is because the band's edge *is* the column — a
 * bang-bang controller oscillates around its target, and a frame-perfect player
 * who leans on the literal edge dies on the oscillation.
 *
 * This number matters: it is subtracted from the lean, and the lean is most of
 * the approach to a ring. `leanMargin` overrides it, and report.ts sweeps that
 * override, because a design whose feasibility rests on the instrument's own
 * caution is not a design that has been measured.
 */
export function safetyMargin(profile: PlayerProfile): number {
  if (profile.leanMargin !== undefined) return profile.leanMargin
  const { deadZone: z, aimJitter: j, perception: p } = profile
  return 4 + Math.sqrt(z * z + j * j + p * p)
}

/**
 * The altitude in `gate`'s gap closest to `toward`, keeping `inset` px away from
 * both columns. Falls back to the gap centre when the band is narrower than the
 * margin asks for — leaning is never worth more than getting through.
 */
function leanToward(toward: number, gate: Gate, inset: number): number {
  const band = safeBand(gate)
  const low = band.low + inset
  const high = band.high - inset
  if (low > high) return gapCentre(gate)
  return Math.min(Math.max(toward, low), high)
}

/**
 * Does an `opportunist` go for this gate's ring?
 *
 * Both legs have to clear `riskTolerance`. The climb out of the dip is fixed by
 * the ramp (`recoveryWindow`). The approach is the seed-dependent half, and the
 * reason this is a judgement rather than an identity: it runs from the best
 * position the *previous* gap allows — its safe band clamped toward the ring — to
 * the dip line, over the open air between the two gates. When the two gaps are
 * offset the wrong way the band cannot lean far enough and the ring is declined.
 *
 * `reach` is the spawner's own settle-and-arrive distance, so the model player is
 * exactly as capable as the fairness rule assumes and no more.
 */
function willCommit(state: GameState, gate: Gate, profile: PlayerProfile): boolean {
  if (profile.strategy !== 'opportunist') return true
  if (!ringIsLive(gate)) return false

  const trip = roundTrip(state.elapsed, DIP_DEPTHS.collector)
  if (trip.recovery.capable - trip.travel < profile.riskTolerance) return false

  const line = dipLine(gate, DIP_DEPTHS.collector)
  const front = targetGate(state)
  const from =
    front === undefined || front.id === gate.id
      ? state.kite.y
      : leanToward(line, front, safetyMargin(profile))
  const approach =
    scrollUntilContact(gate, DIP_DEPTHS.collector) -
    (front === undefined || front.id === gate.id ? 0 : scrollUntilClear(front))
  if (approach <= 0) return false

  return (
    reach(approach / scrollSpeed(state.elapsed)) >= Math.abs(line - from) + profile.riskTolerance
  )
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

/**
 * Play one run to its crash (or to `maxSeconds`) and report what happened.
 *
 * `observe` is called with the state after every step and must not touch it: it
 * exists so a test can watch a real run frame by frame — what the course looked
 * like while somebody was actually flying it — without a second controller
 * having to be written and then trusted.
 */
export function playRun(
  seed: number,
  profile: PlayerProfile,
  maxSeconds = 300,
  observe?: (state: GameState) => void,
): RunResult {
  let state = step(createInitialState(seed), { holding: false, confirmPressed: true }, FIXED_DT)

  const latencySteps = latencyFrames(profile.latency)
  const pending: boolean[] = Array.from({ length: latencySteps }, () => false)

  // Both noise sources come from one generator seeded off the run, so the whole
  // report is reproducible: two invocations of `pnpm feel` are comparable.
  let noiseRng: Rng = createRng(seed ^ 0x5f3759df)
  let jitterGateId = -1
  let jitter = 0
  let ringsOffered = 0
  let ringsDeclined = 0

  /**
   * Whether to go for each gate's ring, decided once and then lived with — a
   * player commits or does not, they do not re-litigate it every frame.
   *
   * The decision is taken the first time the gate is looked at, which is while
   * the kite is still flying the gate *before* it, and therefore before any
   * leaning toward this ring has happened. Deciding later would let the
   * pre-positioning talk the opportunist into rings it would not otherwise have
   * taken, and the profile would collapse back toward the identity the GOK-14
   * review found in its predecessor.
   */
  const decisions = new Map<number, boolean>()
  function decide(gate: Gate): boolean {
    const known = decisions.get(gate.id)
    if (known !== undefined) return known
    const verdict = willCommit(state, gate, profile)
    decisions.set(gate.id, verdict)
    for (const id of decisions.keys()) if (id < gate.id - 3) decisions.delete(id)
    if (profile.strategy === 'opportunist') {
      ringsOffered += 1
      if (!verdict) ringsDeclined += 1
    }
    return verdict
  }

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

  // A structural frame budget, not just the two conditions below.
  //
  // The hang this replaced looped on `elapsed` while allowing restarts, and a
  // restart resets `elapsed` — so the loop could run forever and vitest, which
  // cannot interrupt synchronous code, reported nothing at all for 25 minutes
  // rather than going red. `playRun` passes `confirmPressed: false` so no
  // restart can happen under it, which makes that safe *by input pattern*. This
  // makes it safe by construction instead: whatever a future edit does to the
  // conditions, the loop cannot outrun the wall clock it was given (GOK-18).
  const frameBudget = Math.ceil(maxSeconds / FIXED_DT) + 120
  let frames = 0

  while (state.phase === 'playing' && state.elapsed < maxSeconds) {
    frames += 1
    if (frames > frameBudget) {
      throw new Error(
        `playRun exceeded its frame budget (${frameBudget} frames for ${maxSeconds}s) — ` +
          'the run is not advancing its own clock',
      )
    }
    const gate = targetGate(state)
    if (gate !== undefined && gate.id !== jitterGateId) {
      jitterGateId = gate.id
      jitter = draw(profile.aimJitter)
    }

    const target = aimFor(state, profile, decide) + jitter
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

    if (process.env['TRACE'] === '1') {
      const g = targetGate(state)
      console.log(
        [
          state.elapsed.toFixed(3),
          'y',
          state.kite.y.toFixed(1),
          'vy',
          state.kite.vy.toFixed(0),
          'aim',
          target.toFixed(1),
          g
            ? `gate${g.id} x=${g.x.toFixed(0)} gap=[${g.gapY.toFixed(0)},${(g.gapY + g.gapHeight).toFixed(0)}] ringX=${thermalX(g).toFixed(0)} ringY=${g.thermal.y.toFixed(0)} got=${String(g.thermal.collected)}`
            : 'no gate',
        ].join(' '),
      )
    }
    state = step(state, { holding, confirmPressed: false }, FIXED_DT)
    observe?.(state)

    for (const event of state.events) {
      // thermal_collected always precedes its gate_passed — the ring rides ahead
      // of the gate and the pass is scored on its trailing edge — so the set is
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
    ringsOffered,
    ringsDeclined,
    crashCause: state.crashCause,
    censored: state.crashCause === null,
  }
}
