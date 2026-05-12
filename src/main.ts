/**
 * ai-roster-adviser entry point — SCAFFOLD ONLY.
 *
 * See README + ai-ops-meta `architect-backlog.md` Phase 3 grounding-source
 * agents section. Design lives in `docs/architecture.md` §6.8.
 *
 * When implemented, this file boots:
 *   1. Boot self-check (AP-3 + AP-4 + AP-6): Google OAuth scope check;
 *      sheet-shape probe + persisted mapping; header hash compare on every
 *      sync (fail loud on drift — no auto-reprobe per AP-6).
 *   2. SQLite cache open at /var/lib/ai-roster-adviser/cache.db.
 *   3. 15-min systemd timer triggers `googleSheets.sync()` to refresh cache.
 *   4. Unix-socket RPC server accepting `roster.query.v1` + `roster.range.v1`.
 *   5. Privacy filter: `notes` never leave the agent — `status: 'sick'` is the
 *      only signal exposed for sensitive entries.
 */

async function main(): Promise<void> {
  // eslint-disable-next-line no-console
  console.error(
    JSON.stringify({
      level: 'error',
      service: 'ai-roster-adviser',
      msg: 'scaffold_only',
      hint: 'see ai-ops-meta architect-backlog.md Phase 3 grounding-source agents',
    }),
  );
  process.exit(1);
}

main().catch((err: unknown) => {
  // eslint-disable-next-line no-console
  console.error(
    JSON.stringify({
      level: 'fatal',
      service: 'ai-roster-adviser',
      msg: 'unhandled_rejection',
      error: err instanceof Error ? err.message : String(err),
    }),
  );
  process.exit(2);
});
