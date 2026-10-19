/**
 * Re-derive spec §2.3's reachability row. `pnpm feel:reach`.
 *
 * Its own command because it is slow — a joint fixed point solved inside a
 * bisection inside a model evaluation, minutes a checkpoint in phase 1, about a
 * quarter of an hour for the eight. `pnpm feel` prints the pinned row instead,
 * and tests/cost.test.ts re-derives the two cells the verdict turns on.
 *
 * Run this when a gameplay constant moves, when the cost model changes, or when
 * someone wants to see the numbers land rather than read them off a constant.
 * The output is the source for `SELF_CONSISTENT_WORST_GATE`.
 */

import { deriveSelfConsistentRow } from './cost.js'
import { SPEC_REVISION_SHORT, SPEC_VERSION } from '../spec-revision.js'

console.log(`UPDRAFT — §2.3 reachability, against spec ${SPEC_VERSION} (${SPEC_REVISION_SHORT}).`)
console.log('')
deriveSelfConsistentRow()
