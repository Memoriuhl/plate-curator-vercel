# Research enrichment implementation

Scope: HANDOFF.md supplied on 2026-11-17; isolated checkout only. No paid calls,
deploys, Publish, Resume, existing workers, live candidate changes or extra agents.

1. Gateway Tag: separate persisted Tag selection, reuse hosted adapter from the
   durable coordinator, preserve projected inputs, shared IO bound and Apply.
   Verified commit `4449e34` is in the delivery bundle (parent Git metadata is
   sandbox read-only). Service/UI/queue/drag checks, typecheck and lint passed.
2. Prerequisite: incorporate t1y7's `873fa055`, then its superseding fail-fast
   correction `feadd045`, resolving the Gateway dispatch additions. Preserve the
   Florida source fix. Missing Wiki/Description stops dependent text work before
   dispatch. Empty standalone research stops before inference. Queue panel changes
   are only the inherited upstream patch; this lane does not redesign that panel.
3. Bulk research: add one Research/enrich stage, per-field Fill missing/Replace
   planning from Batch input and projected input. Reuse bounded Wikipedia and
   research validators. One synthesis call over captured evidence; separate
   allowlisted Desktop/Eve selection saved on run and jobs. Eve uses its existing
   authenticated session transport, evidence store, budgets and submit tool.
4. Clear optional draft values explicitly through revision-checked edits, starting
   with Description, then story and colors where the schema permits. Preserve
   image/provenance pairing and identity/grouping fields.
5. Verify at queue/service and rendered-editor seams using stubbed inference.
   Include no-result/failure, Preview refusal, multi-plate, persisted policies,
   model usage/provenance, explicit clear and preserved drag/Tag regressions.

Delivery: `hc send` is blocked by the sandbox's Herdr core-lock permission.
Normal Git staging is blocked at the parent worktree's index.lock. Use allowed
temporary Git metadata to produce importable commit bundles without touching the
parent refs. Integration must restack the feature commits after final queue/Eve
prerequisites; this combined local lineage must never be pushed as main.

Verification: the full serial Vitest run passed 1,637 tests and all 57 hygiene
tests passed. Additional focused cancellation/invalid-draft tests passed after
that run. Typecheck, lint (two existing React Compiler warnings) and Eve build
were run. The sandbox refuses new localhost listeners (EPERM), so emulator and
rendered browser evidence remain integration gates. An optimized Next build
stalled in Turbopack's compilation phase and was interrupted; do not call it a
successful production build. No hosted request or paid inference was made.

The connected messaging tool also requires approval, which this session's
approval policy forbids. Delivery to t1y7 is therefore still pending. The first
commit bundle is independently importable from the combined baseline.
