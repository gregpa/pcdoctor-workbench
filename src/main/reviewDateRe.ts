// v2.4.49 (B48-AUDIT-1/2): allowlist for renderer-supplied review-date
// strings. Extracted from ipc.ts so tests can import the constant without
// pulling the entire IPC handler module (which transitively pulls
// electron-updater, better-sqlite3, etc., none of which are loadable from
// a vitest node environment). Mirrors the pattern of scheduledTaskNames.ts
// from v2.4.48.

/**
 * Any reviewDate value supplied by the renderer must match YYYY-MM-DD before
 * flowing into path.join, existsSync, or any other filesystem sink.
 *
 * Defence-in-depth shape:
 *   - api:archiveWeeklyReviewToObsidian: without this, '../../etc/passwd'
 *     would let `${reviewDate}.md` join into the destination path and a
 *     maliciously named source file would satisfy the existsSync check,
 *     causing copyFile to an attacker-chosen destination.
 *   - api:getWeeklyReview: the value flows into files.find(f => f.startsWith(reviewDate))
 *     which is filesystem-bounded, but the value is also logged into
 *     error messages and (in future code paths) might flow into path.join.
 *     Validate at the boundary, not the sink.
 *
 * Pattern is intentionally strict: 4-digit year, 2-digit month, 2-digit
 * day, separated by literal hyphens, anchored at both ends. The renderer
 * only emits ISO YYYY-MM-DD strings (verified via WeeklyReview.review_date
 * type) — manual override is via the file system, not the IPC.
 */
export const REVIEW_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
