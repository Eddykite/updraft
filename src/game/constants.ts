/**
 * Every tuning number in UPDRAFT. One source of truth (spec §2).
 *
 * These are transcribed from the signed-off spec's constants table. Game feel is
 * expected to be retuned here (spec §8.1) — that is the one place a constant may
 * move without a spec revision, provided the reachability invariant test still
 * passes. Changing the *mechanic* is a spec revision.
 *
 * Units: px, px/s, px/s², seconds. +y is down, origin top-left.
 */

// --- Field ------------------------------------------------------------------

/** Logical play field width. Letterboxed into the real viewport by render/viewport.ts. */
export const FIELD_WIDTH = 540
/** Logical play field height (9:16 with FIELD_WIDTH). */
export const FIELD_HEIGHT = 960

// --- Kite -------------------------------------------------------------------

/** Fixed horizontal position of the kite; the world scrolls toward it. */
export const KITE_X = 150
/** Collision radius. The tail is decoration and never collides. */
export const KITE_RADIUS = 16
/** Kite y at the start of a run (mid-field). */
export const KITE_START_Y = FIELD_HEIGHT / 2

// --- Vertical motion --------------------------------------------------------

/** Downward acceleration with no input. */
export const GRAVITY = 1500
/** Upward acceleration while input is held (sign is negative: -y is up). */
export const LIFT_ACCEL = -2900
/** Net upward acceleration while held: |LIFT_ACCEL| - GRAVITY = 1400. */
export const NET_LIFT_ACCEL = -(LIFT_ACCEL + GRAVITY)
/** Vertical speed clamp, both directions. */
export const VY_CLAMP = 560
/** Soft ceiling: y is clamped here and vy is zeroed. Touching it is NOT fatal. */
export const CEILING_Y = 30
/** Fatal ground line: the run ends when y + KITE_RADIUS >= GROUND_Y. */
export const GROUND_Y = 930
/** Visual height of the ground band (FIELD_HEIGHT - GROUND_Y). */
export const GROUND_BAND_HEIGHT = FIELD_HEIGHT - GROUND_Y

// --- Gates ------------------------------------------------------------------

/** Width of a power-line column. */
export const GATE_WIDTH = 70
/** Lowest permitted top edge of a gap. */
export const GAP_Y_MIN = 80
/** Highest permitted bottom edge of a gap: gapY ∈ [GAP_Y_MIN, GAP_Y_MAX_EDGE - gapHeight]. */
export const GAP_Y_MAX_EDGE = 870
/** Delay before the first gate spawns, so the player gets a free moment to feel the controls. */
export const FIRST_GATE_DELAY = 1.2

// --- Thermals (spec §2.2 — outside the gap) ---------------------------------
// v1 put the ring *inside* the gap at gapCentre ± (h/2 - 45). That made the
// safest altitude in the game a free collecting altitude on 65% of gates and on
// 100% of them from t = 77 s, and the proof never mentions the inset — so no
// retune could reach it. v2 moves the ring outside the gap band entirely and
// leads it ahead of the column, so the kite meets the ring first and the column
// second and has to pay its way back in.

/** Thermal ring collision radius. */
export const THERMAL_RADIUS = 22
/**
 * How far ahead of its column's centre line the ring rides.
 *
 * `thermalX = gate.x + GATE_WIDTH / 2 - THERMAL_LEAD` = `gate.x - 29`, so the
 * ring's disc clears each column by 64 - 22 - 35 = 7 px of horizontal daylight:
 * it never overlaps the hazard it is drawn beside. It is also what makes the
 * detour cost something — a kite that left the corridor to collect has only
 * (64 - 35) / speed seconds before the column arrives.
 */
export const THERMAL_LEAD = 64
/**
 * Floor of the outset `E(t)`, and the replacement invariant in one constant.
 *
 * `E >= THERMAL_RADIUS` is exactly "the ring's disc lies entirely outside the
 * gap band", which is equivalent to "a kite that collects is at that instant at
 * least h/2 - KITE_RADIUS from the gap centre — it has left the safe corridor".
 * That equivalence holds for every gap height and every difficulty, which is the
 * mirror of why v1's free lunch was unreachable by retuning.
 */
export const THERMAL_OUTSET_FLOOR = THERMAL_RADIUS
/** Extra outset at p = 0: `E(t) = FLOOR + RANGE·(1 - p)²`, so E(0) = 76, E(90) = 22. */
export const THERMAL_OUTSET_RANGE = 54
/** Clear air the ring's disc keeps from the ceiling and from the fatal ground line. */
export const THERMAL_FIELD_MARGIN = 20
/**
 * Lowest legal y for a ring's centre: ceiling + radius + margin = 72.
 *
 * The margin is not decoration. The deepest point of a cheapest collecting line
 * lands within a pixel or two of the ring's own altitude, so without it a routine
 * collecting dive on the lowest legal gates would pass 9 px above the fatal
 * ground line. These two bounds are what narrow the gap-y range (spec §2.3).
 */
export const THERMAL_Y_MIN = CEILING_Y + THERMAL_RADIUS + THERMAL_FIELD_MARGIN
/** Highest legal y for a ring's centre: (fatal kite y) - radius - margin = 872. */
export const THERMAL_Y_MAX = GROUND_Y - KITE_RADIUS - THERMAL_RADIUS - THERMAL_FIELD_MARGIN
/**
 * Where a gate is created, in field coordinates.
 *
 * `FIELD_WIDTH + THERMAL_LEAD` = 604 rather than 540: the ring rides 64 px ahead
 * of its column, so at 540 it would pop into view 29 px inside the right edge
 * instead of entering from off-screen. The first gate therefore arrives about
 * 0.36 s later than in v1, on top of the unchanged FIRST_GATE_DELAY.
 */
export const GATE_SPAWN_X = FIELD_WIDTH + THERMAL_LEAD

// --- Difficulty (spec §2.4 — two ramps, no top) -----------------------------
//
//   p = clamp(elapsed / 90, 0, 1)            phase 1, the teaching ramp
//   q = max(0, 1 - 2^(-(elapsed - 90) / 60)) phase 2, halves what is left every 60 s
//
// v1 stopped at p = 1 and a frozen course is survivable indefinitely — 100% of
// 200 competent model runs reached the old 240 s cutoff, and 40/40 at 1800 s, so
// the score measured patience. The second ramp keeps tightening strictly at
// every t while never reaching the floors below, which are physical limits
// rather than taste (spec §2.4).
//
// q is 0 while p < 1 and p is 1 whenever q > 0, so all three parameters are a
// single sum with no branch: continuity at t = 90 is a property of the
// arithmetic rather than of a conditional somebody might get wrong.

/** Seconds for phase 1 to run its course. */
export const DIFFICULTY_RAMP_SECONDS = 90
/** Phase 2 closes half the remaining distance to the floors every this many seconds. */
export const SECOND_RAMP_HALF_LIFE = 60
/** Scroll speed at p = 0. */
export const SPEED_BASE = 180
/** Scroll speed at p = 1 is SPEED_BASE + SPEED_RANGE = 420. */
export const SPEED_RANGE = 240
/** Phase 2 adds this much more: the speed ceiling is 180 + 240 + 140 = 560. */
export const SPEED_RANGE_2 = 140
/** Gap height at p = 0. */
export const GAP_BASE = 260
/** Gap height at p = 1 is GAP_BASE - GAP_RANGE = 150. */
export const GAP_RANGE = 110
/** Phase 2 takes this much more: the gap floor is 260 - 110 - 40 = 110. */
export const GAP_RANGE_2 = 40
/** Gate spawn interval at p = 0, in seconds. */
export const INTERVAL_BASE = 1.6
/** Spawn interval at p = 1 is INTERVAL_BASE - INTERVAL_RANGE = 0.9 s. */
export const INTERVAL_RANGE = 0.7
/** Phase 2 takes this much more: the interval floor is 1.6 - 0.7 - 0.22 = 0.68 s. */
export const INTERVAL_RANGE_2 = 0.22

/**
 * The floors, approached and never reached. Derived in spec §2.4, not picked:
 *
 * - speed 560 — the kite sees 390 px of track ahead, which at 560 px/s is 0.696 s
 *   of warning against the 0.683 s a player needs to execute the largest legal
 *   centre change and still react. (It is also exactly VY_CLAMP: the world never
 *   comes at you faster than you can climb.)
 * - gap 110 — executing the largest legal centre change at the interval floor
 *   peaks the kite at 336 px/s, where a 100 ms misjudgement is 33.7 px, so a fair
 *   gap needs 2·(16 + 33.7) = 99.3 px beside the kite.
 * - interval 0.68 s — moving the largest legal delta and settling takes T/√2, so
 *   T >= T/√2 + 0.2 gives T >= 0.6828 s, leaving 199 ms of reaction time.
 *
 * Exported so the difficulty test asserts against the derivation rather than
 * against a number retyped from the formulas it is checking.
 */
export const SPEED_LIMIT = SPEED_BASE + SPEED_RANGE + SPEED_RANGE_2
export const GAP_FLOOR = GAP_BASE - GAP_RANGE - GAP_RANGE_2
export const INTERVAL_FLOOR = INTERVAL_BASE - INTERVAL_RANGE - INTERVAL_RANGE_2

// --- Reachability invariant (spec §2, the fairness rule) ---------------------

/**
 * Deliberate headroom. A course that is only *just* flyable is not fun, so the
 * spawner is allowed only half of the kite's true reach between gates.
 */
export const REACH_HEADROOM = 0.5
/**
 * Lower clamp on the permitted change in gap centre between consecutive gates.
 *
 * **60, not v1's 120** — a latent bug v2 would otherwise have shipped. The clamp
 * is a guard, not a tuning knob: it must never override the formula. Since
 * `0.5·reach(T) = 120` at `T = 0.828 s`, a floor of 120 starts *raising* the
 * permitted jump above what the kite can settle as soon as the interval drops
 * below 0.828 s. v1's interval bottomed out at 0.9 s so it never fired; v2's
 * reaches 0.68 s, so it would have fired from about t = 124 s — exactly in the
 * new endgame, and exactly as unflyable gates. At 60 it binds only below
 * T = 0.586 s, which is under the interval floor, so it is provably inert.
 */
export const MAX_CENTRE_DELTA_MIN = 60
/**
 * Upper clamp. Likewise inert: `0.5·reach(1.6) = 336` is the largest value the
 * formula ever produces at any legal interval.
 */
export const MAX_CENTRE_DELTA_MAX = 420
/**
 * How far the gap centre may move *toward* the ring's side, in px, at q = 0.
 *
 * The ring and the course spend the same vertical budget (spec §2.3). On a gate
 * where the gap centre jumps a long way *toward* the ring, both bills come due
 * at once — the previous gap sat on the far side, so the course move and the
 * detour add instead of cancelling — and the ring stops being takeable at any
 * survivable clearance, which would make it fake in the other direction. That
 * is the direction this constant caps, and the direction `worstGate` in
 * tools/feel/cost.ts prices. The cap is written on the *course*
 * rather than on the ring because the ring's position is what the player reads,
 * so it should not be the thing that quietly bends. It shrinks to 0 as the
 * second ramp tightens: `thermalTowardDelta(t) = 30·(1 - q)`.
 */
export const THERMAL_TOWARD_DELTA = 30

// --- Scoring ----------------------------------------------------------------

/** Points for passing a gate, before the multiplier. */
export const SCORE_PER_GATE = 10
/** Points for collecting a thermal, before the multiplier. */
export const SCORE_PER_THERMAL = 5
/** Multiplier = min(1 + floor(streak / STREAK_PER_MULTIPLIER), MULTIPLIER_CAP). */
export const STREAK_PER_MULTIPLIER = 2
/** Hard cap on the multiplier. */
export const MULTIPLIER_CAP = 5
/** The streak stops climbing here; 8 is exactly the streak that reaches the 5× cap. */
export const STREAK_MAX = 8
/**
 * What passing a gate without its ring costs the streak (spec §2.2).
 *
 * v1 reset the streak to 0. That is harmless when the ring is free — you never
 * miss — and actively wrong now that it is risky: it prices one cautious
 * decision at the entire multiplier, which converts a risk/reward layer into
 * forced greed and removes the choice at every streak above zero. The penalty is
 * exactly STREAK_PER_MULTIPLIER, i.e. one multiplier step down and two rings to
 * earn it back: about 55 points at the 5× cap, against about 325 under the reset
 * rule. One is a decision, the other is a cliff.
 *
 * It also makes the multiplier a measurement: at +1 per collect and -2 per miss
 * the streak drifts by `3c - 2` per gate, so holding a multiplier at all means
 * taking more than two-thirds of the rings, and holding the cap means taking
 * essentially all of them.
 */
export const STREAK_MISS_PENALTY = STREAK_PER_MULTIPLIER

// --- Loop -------------------------------------------------------------------

/** Fixed simulation timestep: 60 Hz. The simulation never sees a variable dt. */
export const FIXED_DT = 1 / 60
/**
 * Maximum catch-up steps per rendered frame. Prevents a spiral of death when a
 * backgrounded tab resumes (the game also pauses on visibilitychange).
 */
export const MAX_CATCH_UP_STEPS = 5

// --- Shell-side constants (not used by the simulation) ----------------------

/** The game-over screen ignores input for this long so a death-frame tap doesn't burn a restart. */
export const GAME_OVER_INPUT_LOCK = 0.4
/** The "hold to climb" hint fades out after this many seconds of the first run. */
export const HINT_FADE_SECONDS = 3
/** How long the hint takes to fade once it starts, in seconds. */
export const HINT_FADE_DURATION = 0.8
/**
 * How long the multiplier's grow-and-brighten takes to settle, in seconds.
 * One pulse per step up — it grows, it does not flash (accessibility).
 */
export const MULTIPLIER_PULSE_SECONDS = 0.22
/** Device pixel ratio is capped here when sizing the canvas. */
export const DPR_CAP = 2
/** Versioned localStorage key for the best score. Bump the suffix to invalidate. */
export const STORAGE_KEY = 'updraft.best.v1'
/** Minimum touch target for the mute control, per the concept doc. */
export const MUTE_HIT_AREA = 44
