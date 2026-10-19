/**
 * Which revision of the specification this tree is written against.
 *
 * The spec is GOK-2's `spec` document, and it is the contract: §2.1's constants,
 * §2.2's cost table, §2.3's reachability floors and §3's test strategy are all
 * read out of it by hand into code. Every one of those is a *copy*, and a copy
 * that nothing checks is a second source of truth.
 *
 * GOK-27 is what that costs. `PUBLISHED_COST_TABLE` in tools/feel/cost.ts held
 * v2's phase-2 cells long after v2.1 had replaced them, the whole suite stayed
 * green — every assertion compared the model to the copy, and nothing compared
 * the copy to the document — and the instrument spent a revision reporting a
 * 2.01 px shortfall against a cell that no longer existed. Spec §3 now requires
 * that whatever holds published numbers in code carries the revision it was
 * copied from, and that a test asserts that revision is current.
 *
 * ## The protocol
 *
 * This constant is the single repo-wide answer to "which revision is current".
 * Each transcription carries its own copy of the revision it was read from —
 * `PUBLISHED_COST_TABLE_REVISION` is the first — and a test asserts the two are
 * equal.
 *
 * So: **when the spec moves, bump this constant first.** Every transcription
 * that has not been re-read off the new revision goes red immediately, naming
 * itself, and stays red until someone opens the new §2.2 and checks the numbers
 * against it. Bumping a transcription's own revision without re-reading the
 * table is still possible — nothing in a repo with no network access can prove
 * otherwise — but it is now a deliberate act in the same diff as the numbers,
 * rather than the silent default.
 *
 * Nothing here can reach Paperclip, so this is not a live check. What it buys is
 * that staleness surfaces at the moment the document moves instead of surviving
 * a revision undetected, which is the exact failure it exists for.
 */

/**
 * GOK-2 `spec` revision `1983e25b-d61a-45a9-bbf6-2393282b6cd8` — **v2.2**,
 * revision 7, 2026-10-19. Ruled on GOK-27.
 *
 * Short form `1983e25b`, which is how the issue threads refer to it.
 */
export const SPEC_REVISION = '1983e25b-d61a-45a9-bbf6-2393282b6cd8'

/** The short form the issue threads and the spec's own prose use. */
export const SPEC_REVISION_SHORT = SPEC_REVISION.slice(0, 8)

/** The spec version string that revision publishes, for report headers. */
export const SPEC_VERSION = 'v2.2'
