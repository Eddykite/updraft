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

// --- Thermals ---------------------------------------------------------------

/** Thermal ring collision radius. */
export const THERMAL_RADIUS = 22
/** Thermal sits at gapCentre ± (gapHeight / 2 - THERMAL_EDGE_INSET); side chosen by RNG. */
export const THERMAL_EDGE_INSET = 45

// --- Difficulty -------------------------------------------------------------
// p = clamp(elapsed / DIFFICULTY_RAMP_SECONDS, 0, 1), linear, frozen at p = 1.

/** Seconds to reach maximum difficulty. */
export const DIFFICULTY_RAMP_SECONDS = 90
/** Scroll speed at p = 0. */
export const SPEED_BASE = 180
/** Scroll speed at p = 1 is SPEED_BASE + SPEED_RANGE = 420. */
export const SPEED_RANGE = 240
/** Gap height at p = 0. */
export const GAP_BASE = 260
/** Gap height at p = 1 is GAP_BASE - GAP_RANGE = 150. */
export const GAP_RANGE = 110
/** Gate spawn interval at p = 0, in seconds. */
export const INTERVAL_BASE = 1.6
/** Spawn interval at p = 1 is INTERVAL_BASE - INTERVAL_RANGE = 0.9 s. */
export const INTERVAL_RANGE = 0.7

// --- Reachability invariant (spec §2, the fairness rule) ---------------------

/**
 * Deliberate headroom. A course that is only *just* flyable is not fun, so the
 * spawner is allowed only half of the kite's true reach between gates.
 */
export const REACH_HEADROOM = 0.5
/** Lower clamp on the permitted change in gap centre between consecutive gates. */
export const MAX_CENTRE_DELTA_MIN = 120
/** Upper clamp on the permitted change in gap centre between consecutive gates. */
export const MAX_CENTRE_DELTA_MAX = 420

// --- Scoring ----------------------------------------------------------------

/** Points for passing a gate, before the multiplier. */
export const SCORE_PER_GATE = 10
/** Points for collecting a thermal, before the multiplier. */
export const SCORE_PER_THERMAL = 5
/** Multiplier = min(1 + floor(streak / STREAK_PER_MULTIPLIER), MULTIPLIER_CAP). */
export const STREAK_PER_MULTIPLIER = 2
/** Hard cap on the multiplier. */
export const MULTIPLIER_CAP = 5

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
/** Device pixel ratio is capped here when sizing the canvas. */
export const DPR_CAP = 2
/** Versioned localStorage key for the best score. Bump the suffix to invalidate. */
export const STORAGE_KEY = 'updraft.best.v1'
/** Minimum touch target for the mute control, per the concept doc. */
export const MUTE_HIT_AREA = 44
