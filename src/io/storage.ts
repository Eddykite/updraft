/**
 * Best score in localStorage: one versioned key, validated and clamped (spec §2, §7).
 *
 * **localStorage is untrusted input** — the user can edit it. Corrupt JSON, a
 * missing key, NaN, negative, absurdly large, wrong-type and old-version values
 * must all fall back to 0 rather than throwing or displaying garbage. That is a
 * tested requirement (spec §3), not a nicety.
 *
 * The key is STORAGE_KEY in game/constants.ts. One key holds the whole record:
 * `{"v":1,"best":1234,"muted":false}`. Mute lives here too so there is exactly
 * one thing to version, one thing to validate, and one thing to clear.
 *
 * Nothing in this module throws. Private browsing, a disabled storage partition
 * and a full quota are all normal conditions, not errors — the game keeps
 * playing, it just stops remembering.
 */

import { STORAGE_KEY } from '../game/constants.js'

/** Scores above this are not a player, they are an edited storage value. */
export const MAX_BEST = 9_999_999

/** The current record version. A value written by any other version is ignored. */
export const STORAGE_VERSION = 1

export interface Persisted {
  readonly best: number
  readonly muted: boolean
}

export const EMPTY: Persisted = { best: 0, muted: false }

/**
 * Parse whatever was in storage into a record we are willing to render.
 *
 * Pure, total, and exported precisely so the hostile-input cases are unit
 * testable without a DOM (spec §3). Anything unexpected — at any depth — falls
 * back to the matching field of `EMPTY` rather than throwing or propagating.
 */
export function parsePersisted(raw: string | null | undefined): Persisted {
  if (typeof raw !== 'string' || raw.length === 0) return EMPTY

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return EMPTY
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return EMPTY
  const record = parsed as Record<string, unknown>

  // An old (or forged) version is not upgraded or guessed at — it is discarded.
  if (record['v'] !== STORAGE_VERSION) return EMPTY

  return { best: sanitiseBest(record['best']), muted: record['muted'] === true }
}

/** Coerce an unknown into a score we can safely draw: a finite integer in [0, MAX_BEST]. */
export function sanitiseBest(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0
  return Math.min(Math.max(Math.floor(value), 0), MAX_BEST)
}

/** Serialise a record. Exported for the round-trip test. */
export function serialise(record: Persisted): string {
  return JSON.stringify({
    v: STORAGE_VERSION,
    best: sanitiseBest(record.best),
    muted: record.muted === true,
  })
}

/**
 * `localStorage` access that cannot throw.
 *
 * Touching the property itself throws in some privacy configurations, so even
 * the lookup is guarded.
 */
function store(): Storage | null {
  try {
    return globalThis.localStorage ?? null
  } catch {
    return null
  }
}

function readRecord(): Persisted {
  const storage = store()
  if (!storage) return EMPTY
  try {
    return parsePersisted(storage.getItem(STORAGE_KEY))
  } catch {
    return EMPTY
  }
}

function writeRecord(record: Persisted): void {
  const storage = store()
  if (!storage) return
  try {
    storage.setItem(STORAGE_KEY, serialise(record))
  } catch {
    // Quota, private mode, disabled storage: the game keeps playing, it just forgets.
  }
}

/** Read the best score, or 0 for anything unexpected. Never throws. */
export function readBest(): number {
  return readRecord().best
}

/** Persist a new best score. Never throws (private mode / quota are normal). */
export function writeBest(score: number): void {
  const current = readRecord()
  writeRecord({ ...current, best: sanitiseBest(score) })
}

/** Read the persisted mute flag; false for anything unexpected. Never throws. */
export function readMuted(): boolean {
  return readRecord().muted
}

/** Persist the mute flag. Never throws. */
export function writeMuted(muted: boolean): void {
  const current = readRecord()
  writeRecord({ ...current, muted: muted === true })
}
