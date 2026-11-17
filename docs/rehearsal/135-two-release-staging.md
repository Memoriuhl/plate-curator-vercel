# #135: two-release staging rehearsal

Plan and source inventory for [#135](https://github.com/Memoriuhl/plate-curator-vercel/issues/135), the catalog delivery and recovery slice of [#72](https://github.com/Memoriuhl/plate-curator-vercel/issues/72). This document records no executed rehearsal or staging write. All execution fields below are deliberately blank.

## Execution boundary and readiness

**No agent holds staging Publish authority. Real Publish stays guarded until Jonathan explicitly enables it. Mac simulator steps belong to the orchestrator.** Keep the same installed staging iOS build for both releases. No production writes, whole-Snapshot restore, new Plates, hosted Tagging, or source changes are part of this rehearsal.

Inventory taken 2026-11-16 at dashboard `ff47d5911bd72c4d5b4aa6ad202e074b5688afb4` and sibling `License-Plate-Game` `bff46fb5c59fb656741e0e61d6d7ad663a07f4dc` (read-only). Repository-root `AGENTS.md` and `docs/HANDOFF.md` were absent in this dashboard checkout; the supplied repository instructions and sibling `AGENTS.md` were read.

Parent #72's comments report earlier staging publications v11 to v12 and hosted v12 to v13, including a revision-mismatch fix and a run remaining pinned to its original deployment. Those are historical dashboard publication evidence, not proof of #135's two simulator adoptions. Do not hardcode v13 as the current baseline or treat that earlier staging approval as this rehearsal's execution record.

**Verified game correction:** Mac verification of sibling `License-Plate-Game` at `d72d9fd5` (PR #224 merge), on `gameplay-mechanics`, supersedes the older inventory: commit `eda0e48d` “prompt for every newer catalog version” makes metadata-only updates prompt. The metadata-only silence blocker applies only to older `bff46fb5`. The button is **Load new plates**; its difference from **Reload now** is an acceptance note, not a blocker.

The loader still reads the Firestore pointer once per launch. No `onSnapshot` on `config/catalog`, live watcher or foreground refresh was found; searches for `AppState` and intervals found none in `src/catalog`. **First-gate readiness check: does an already-open app discover a later Publish?** If it does not, log `readiness/watcher` and report to the orchestrator; do not substitute a manual restart or add Plate IDs to force a prompt.

### Mode A: Firestore emulator dry run (runnable now by anyone)

Use isolated emulator fixtures to rehearse the Batch, approval, publication and inverse sequence below, recording local results separately. Confirm all write targets are local/emulated, including Snapshot storage dependencies. This can prove the exercised local transitions and version/value bookkeeping, plus stale-baseline handling when available. It cannot prove deployed staging rules, identities, storage, durable infrastructure, or native simulator discovery, prompts and adoption. Emulator success does not authorize staging or establish #135 acceptance.

### Mode B: staging (only after Jonathan’s explicit go)

The staging steps below require Jonathan’s explicit enablement of real Publish; Owner role alone is insufficient. Parent #72 comments mention earlier staging publications through v13 while the release lead says staging is guarded at v11. **Open question: what is the actual pointer version?** Read `config/catalog`; never hardcode the baseline or treat historical approval as authority for this rehearsal.

## Source and test inventory

Dashboard paths are relative to this repository. Game paths are relative to sibling `License-Plate-Game/`. These are static coverage findings; tests were not run for this documentation-only change.

| Source / test paths | What the implementation or assertion establishes | Remaining #135 gap |
| --- | --- | --- |
| Dashboard `app/api/batches/[id]/submit/route.ts`, `approve/route.ts`, `lib/review/batch.ts` | Normal revision-checked submit/approve transitions; approval is Owner-only; edits reopen the Batch and invalidate approval. Submit starts a durable run and approve resumes its hook. | Actual staging Editor/Owner identities and exact reviewed diff need execution evidence. |
| Dashboard `app/api/batches/[id]/publish/route.ts`, `workflows/approval.ts`, `lib/review/run-status.ts`, `app/api/batches/[id]/run/route.ts` | Owner and environment gate; Publish resumes the durable command rather than publishing directly. Run checks approved revision, retries locked/unavailable outcomes, and exposes version/failure. | An accepted request is not a committed Snapshot or game adoption. Record final run outcome. |
| Dashboard `lib/publish/publish.ts`, `validation.ts`, `bytes.ts`, `gcs-snapshots.ts` | Builds current baseline N+1 with edits, preserves IDs, validates grouping and state orders, removes a cleared Variant link rather than emitting null, uploads immutable bytes and verifies checksum; reconciles retries. | Exact staging Tag plus family edits and inverse have not been demonstrated on device. |
| Dashboard `lib/publish/firestore.ts` | Lease and revision guard; transaction advances `config/catalog` and marks the Publish record committed together, checks baseline version, then finalizes curator order and Batch. | Need actual committed versions and outcomes for both releases; upload alone is insufficient. |
| Dashboard `lib/server/context.ts`, `lib/gcp/firestore.ts` | Publish uses `GCP_PROJECT_ID` for Firestore and `FIREBASE_STORAGE_BUCKET` for Snapshot storage; auth uses `NEXT_PUBLIC_FIREBASE_PROJECT_ID`. `publishAllowed()` permits Vercel production environments or explicit `ALLOW_PUBLISH`. | A deployment label, function name, or enabled button does not establish the Firebase target. Verify all resolved targets. |
| Dashboard `components/publish/workspace.tsx`, `components/review/diff.tsx`, `components/review/run-status.tsx`, `app/(curator)/publish/page.tsx` | Owner review groups edited/regrouped/reordered changes; requests the current approved Batch revision and presents run status/result. | Capture approved revisions, both diffs, and final versions during rehearsal. |
| Dashboard `tests/publish/publish.test.ts` | Tag-only change produces N+1 with stable IDs; combined field/order/cleared-link publication; grouping validation; Owner restriction, stale approval, lock loss, pointer movement, checksum collision and crash/retry convergence. | In-memory dependencies do not prove deployed services, live watcher, simulator reload, or two-release recovery. |
| Dashboard `tests/publish/gcs.test.ts`, `tests/review/approval-route.test.ts`, `tests/review/approval-workflow.test.ts`, `tests/review/run-status.test.ts` | Storage adapter behavior; submit stores run, approve resumes approval, Publish only resumes command; superseded runs cannot publish; successful workflow returns version; status maps outcomes. | Mocked seams do not prove staging permissions or actual durable execution. |
| Dashboard `tests/publish-ui.test.tsx`, `tests/review/batch-scenarios.ts`, `tests/shared-batch-lifecycle.test.tsx` | Diff grouping and role visibility; Batch lifecycle, revision and editing behavior. | UI coverage cannot establish the game's exact displayed values. |
| Game `app/_layout.tsx`, `src/catalog/snapshot/loader.ts`, `cache.ts`, `validate.ts`, `src/catalog/index.ts` | Launch initializes cached catalog; after Firebase init, one pointer read fetches/validates/caches a newer Snapshot and checks prompt state. `initCatalog()` adopts cache on reload. | No live catalog watcher found here: an already-open app is not shown discovering a subsequent Publish. |
| Game `src/stores/catalogUpdateStore.ts`, `src/features/catalogUpdate/catalogUpdate.ts`, `src/shared/ui/CatalogUpdateHost.tsx`, `useLaunchOverlay.ts` | Version comparison, dismissal and preview logic. Verified build prompts for every newer catalog version, including metadata-only updates (`eda0e48d`). Button invokes reload through Expo Updates with development reload fallback. Overlay blocks `/game` and `/join`, waits for splash and launch overlay slot. | Silence applies only to older `bff46fb5`. Load new plates versus Reload now is an acceptance note; already-open discovery remains unproven. |
| Game `src/stores/__tests__/catalogUpdateStore.test.ts`, `src/features/catalogUpdate/__tests__/catalogUpdate.test.ts` | Newer-version comparison and dismissal; existing-ID updates produce no new IDs; older store asserts hidden for existing-ID-only edits; superseded by `eda0e48d`; double tap invokes mocked reload once. | That older assertion does not describe the verified build; record current test evidence. Mocked reload does not prove native tap-through or changed/restored Tag/family values. |
| Game `src/catalog/snapshot/__tests__/loader.test.ts`, `src/catalog/__tests__/initCatalog.test.ts` | Newer blob caching, unchanged-version no fetch, invalid/mismatched blob and network fallback; a simulated fresh module graph adopts prior downloaded cache after JS reload. | No live watcher test found; no real reload or exact two-release Tag/family adoption assertion. |

## Mode B pre-flight: stop before writing if any check fails

1. **Orchestrator + Owner:** record explicit staging enablement from Jonathan before real Publish; reserve a quiet staging window with no competing publisher. Record dashboard source/deployment identifier, game source/build identifier, date and responsible roles. Do not store credentials, IP addresses, private hostnames, token-bearing Snapshot URLs, or unredacted environment dumps in any artifact.
2. **Owner / dashboard operator:** inspect effective deployed configuration and resolved service targets using approved read-only access. Confirm dashboard auth project (`NEXT_PUBLIC_FIREBASE_PROJECT_ID`), server Firestore project (`GCP_PROJECT_ID`), catalog read target, and the project owning `FIREBASE_STORAGE_BUCKET` all resolve to **`license-plate-game-staging`**. Confirm the runtime `config/catalog` being read is the same pointer Publish will write. Record only project ID and pass/fail. The forbidden production project is **`license-plate-game-1df0d`**. Stop for any mismatch or unknown target. Do not change configuration as part of this runbook.
3. **MAC SIMULATOR — orchestrator:** confirm the actual running Firebase app's `projectId` is **`license-plate-game-staging`**, not just a local environment file or build label. Confirm authenticated catalog access and that Firebase/catalog sync is enabled. Record sanitized runtime verification evidence, installed build and its source revision; never switch builds between releases.
4. **MAC SIMULATOR — orchestrator:** perform the first-gate readiness check: does the already-open app discover a later Publish? Record the mechanism and evidence. The verified source has only a launch-time pointer read; if discovery fails or cannot be established, log `readiness/watcher`, report to the orchestrator and stop. Do not substitute a manual restart. Metadata-only prompting is supported by `eda0e48d`; the label difference is an acceptance note.
5. **Owner + MAC SIMULATOR orchestrator:** establish starting pointer version V0 and applied in-memory version V0. Let initial sync finish; resolve pending old updates before starting the capture. Select an eligible foreground catalog/home route where the prompt can appear, with no blocking overlay or active game/join route. Record route and initial values. Keep app open through each subsequent Publish; no manual restart, developer reload, reinstall, cache deletion or build switch may substitute for automatic detection.
6. **Owner:** verify staging Editor can prepare/submit and staging Owner can approve/Publish; verify Publish is enabled for this deployment without using the control. Read current pointer again immediately before each Publish. Abort/rebaseline on an intervening release or fixture edit.

7. **Jonathan:** deploy License-Plate-Game [PR #227](https://github.com/Memoriuhl/License-Plate-Game/pull/227) (`curatorLive` / `curatorLiveAccess` rules) to staging only; never run `firebase deploy` from this repository. Otherwise both browsers show **Live updates unavailable** + **Refresh**. Existing staging Batches need staging-guarded `npm run backfill:signals`; confirm completion before using them.
8. Link the other lead's [#112](https://github.com/Memoriuhl/plate-curator-vercel/issues/112)-[#115](https://github.com/Memoriuhl/plate-curator-vercel/issues/115) smoke-check evidence; do not duplicate it. Tagging evidence (#9/#120) lives in the private notes folder: reference by name only, do not copy.

### Fixture selection

Choose one existing, active Plate with a stable ID, shipped image, visible Tags section, and visible Template family relationship in this installed game. Prefer a Variant whose original and destination families each have their own unchanged Template in the same Jurisdiction. Moving that Variant keeps both Templates intact and minimizes the inverse to one Plate. Confirm destination parent ID and role are valid and that both family memberships can be distinguished in the game. Avoid the sole Template of a family, unrelated pending edits, new/retired Plates, and fixtures requiring order or image changes.

Choose a valid Tag change visible in the game (record the entire ordered Tags array, not only one added/removed label). Record every affected grouping field: `templateFamily`, `templateRole`, `variantOfPlateId`, including whether a field is absent, null, or present. Do not conflate absence with null: Publish deletes a cleared Variant link. If the available UI cannot restore the original representation exactly, choose a different fixture or log a blocker before Publish. Record any additional Plate affected by regrouping and include it in both diffs; otherwise require that only the selected Plate changes and there are no state-order changes.

### Before/after record (complete before submit)

```text
Run/date:
Dashboard revision/deployment identifier (sanitized):
Game revision / installed build (unchanged across both releases):
Dashboard auth / server / catalog / storage project checks:
Simulator runtime Firebase project check:
Watcher + metadata-only test paths/revision for actual build:
Prompt-eligible route / readiness evidence:
Starting pointer version / applied version: V0=___ / ___
Plate ID / Jurisdiction / visible name:
Original full tags array T0:
Changed full tags array T1:
Original grouping G0 (family, role, parent; absent/null explicit):
Changed grouping G1 (family, role, parent; absent/null explicit):
Original and destination Template IDs / unchanged family members:
Allowed changed Plate IDs and fields (include any required companion edits):
Baseline capture / Tag and family view navigation:
Release A Batch ID / baseline / submitted revision / approved current revision:
Release B Batch ID / baseline / submitted revision / approved current revision:
Publication receipts / run outcomes / capture references:
```

## Release A: changed Batch

1. **Editor:** create a fresh staging rehearsal Batch against V0. Set the selected Plate to T1 and G1 together using normal curation controls. Keep ID, image, unrelated metadata and state order unchanged. Inspect the complete diff against the baseline record; it must match the allowlist exactly. Save sanitized before/after diff evidence.
2. **Editor:** submit the finished Batch. Record Batch ID, baseline and submitted revision. Wait for its durable run to reach waiting-for-approval.
3. **OWNER AUTHORITY REQUIRED:** open that submitted revision in Review, verify both Tags and family changes and all companion edits, then approve. Record approval's reviewed revision and the resulting current Batch revision separately: transitions increment revision; do not assume they are the same number. Any edit after review requires resubmission and fresh approval.
4. **MAC SIMULATOR — orchestrator:** start a short recording showing V0's selected Plate values and the prompt-eligible foreground route. Leave this same app running while the Owner publishes.
5. **OWNER STAGING PUBLISH AUTHORITY REQUIRED:** reconfirm staging target and pointer V0, open Publish, select this exact approved Batch, inspect the diff again and invoke normal Publish once. Record request time, run ID/phase, final outcome, and committed version V1 from the completed result and `config/catalog`. An HTTP 202, uploaded object, or success toast alone is insufficient. With no competing release require V1 = V0 + 1.
6. **MAC SIMULATOR — orchestrator:** without manually restarting or refreshing the app, observe the update prompt arriving after Publish. Record arrival time, exact title/button text, and available cached/pending version evidence matching V1. Use a predeclared observation window (for example 60 seconds); a timeout is a logged failed observation, not a fabricated product SLA. If no prompt appears, stop and diagnose the watcher/cache/overlay stage; do not create extra edits to force it.
7. **MAC SIMULATOR — orchestrator:** tap **Load new plates** in the verified build. Record the label difference from **Reload now** as an acceptance note, not a blocker. After reload settles, return to the same Plate ID if navigation resets. Capture its complete Tags T1 and visible family/parent relationship G1; correlate the applied catalog version to V1 using existing runtime diagnostics if available. A prompt or reload animation alone does not prove adoption. If no applied-version surface exists, log that evidence limitation and retain exact value captures plus the publication version.

## Release B: inverse Batch, newer version

1. **Editor + Owner:** only after Release A adoption is established, read the current pointer and fixture again. Require V1, T1 and G1. If another release intervened, stop the controlled sequence, inspect the new baseline and coordinate a fresh rehearsal; never overwrite unrelated changes with a stale inverse.
2. **Editor:** create a separate fresh Batch against V1. Restore exactly T0 and G0 for each allowlisted field/Plate. Do not restore an entire old Snapshot or reuse/reset the published Batch. Compare both saved diffs: A is T0/G0 to T1/G1; B must be T1/G1 to T0/G0. Check absent/null representation, full Tags array, both families' Templates, companion edits, unchanged IDs and no unrelated fields or state orders. Save this inverse-diff comparison before submit.
3. **Editor:** submit the inverse Batch; record its distinct ID, baseline and submitted revision. **OWNER AUTHORITY REQUIRED:** approve the exact reviewed inverse, recording both reviewed and current revisions. Wait for the correct durable run to reach waiting-for-publish.
4. **MAC SIMULATOR — orchestrator:** continue or start the matched recovery capture showing applied V1/T1/G1, then leave the same installed build open on its prompt-eligible route.
5. **OWNER STAGING PUBLISH AUTHORITY REQUIRED:** reconfirm staging and current pointer V1, review inverse diff, then Publish normally. Record final committed version V2 and run outcome. Require V2 > V1; in this uninterrupted rehearsal require V2 = V1 + 1. Recovery is a forward publication, never a pointer decrement.
6. **MAC SIMULATOR — orchestrator:** verify a second automatic prompt within the recorded observation window. Capture it and tap **Load new plates** (record the acceptance label note). Return to the same Plate, verify full Tags equal T0 and grouping equals G0, and record applied-version evidence for V2. Original values at an old version or after manual restart do not establish this recovery flow.
7. **Orchestrator:** retain one short capture or matched pair connecting both Publish results to both automatic prompts, taps and exact displayed values. Add sanitized evidence links and the completed table to #135 and parent #72 during execution. This document change does not post issue comments or claim acceptance. Report pass only if both publications and both simulator adoption checks pass; otherwise report the failed stage and leave acceptance open.

## Variant C: stale baseline (pending #124 / #119 merges)

After [#124](https://github.com/Memoriuhl/plate-curator-vercel/pull/124) / [#119](https://github.com/Memoriuhl/plate-curator-vercel/pull/119) merge, retain a Batch approved against v11, then publish v12 through another Batch. The v11-approved Batch must be **BLOCKED** as stale baseline. Use **Copy to new Batch**, review and re-approve against v12, then Publish to v13. These versions describe the scenario, not the current staging pointer; rebase on the actual pointer. Record the blocked outcome and copied Batch baseline, approval and committed version. Mode B authority still applies. Pending until #124 merges; pause/revoke (#126/#127) steps get added later.

## Compact version-and-values evidence

| State / UTC time | Committed pointer version | Batch ID / baseline / reviewed revision / current approved revision | Final Publish outcome / run reference | Plate ID / full Tags / family / role / parent (absent explicit) | Simulator applied version / prompt / tap / visible-value capture |
| --- | --- | --- | --- | --- | --- |
| Starting | V0 = ___ | baseline only | baseline read ___ | ___ / T0 ___ / G0 ___ | V0 ___ / baseline capture ___ |
| Changed | V1 = ___ (= V0+1) | ___ | ___ | same ID ___ / T1 ___ / G1 ___ | ___ / arrival ___ / tap ___ / values ___ |
| Restored | V2 = ___ (= V1+1; > V1) | ___ | ___ | same ID ___ / exact T0 ___ / exact G0 ___ | ___ / arrival ___ / tap ___ / values ___ |

## Failure-stage log and follow-up

| UTC / release | Failed stage | Expected / observed | Pointer / cached / applied versions | Batch / revisions / run phase / error and reasons | Sanitized evidence / next action / responsible role |
| --- | --- | --- | --- | --- | --- |
| ___ | readiness/target, readiness/watcher, fixture, submit, approve, Publish request, Snapshot commit, watcher/download, prompt/overlay, reload, values, inverse diff, recovery | ___ | ___ | ___ | ___ |

Stop on project mismatch, unknown authority, competing release, invalid family, stale approval or unexpected diff. For Publish failures record readable reasons and whether the pointer advanced before deciding on a normal retry; do not issue a second publication blindly. For no prompt distinguish pointer unchanged, no live subscription, download/cache failure, metadata-only suppression and blocked overlay. For wrong values distinguish cached versus applied version and wrong Plate/navigation. If A committed but recovery fails, report the remaining T1/G1 staging state and coordinate the inverse through Owner authority; do not claim restoration.

Open questions for execution: Does the already-open verified build discover a later Publish, and through what mechanism? What is the actual pointer version given the v11/v13 reports? Where are that revision's metadata-only and watcher regression tests? Can its existing diagnostics expose applied version without source changes? Which valid staging Variant/families and Tag values are available now? Has Jonathan explicitly enabled real staging Publish for the reserved window? These require runtime/Owner evidence; this inventory does not infer the answers from deployment names or old screenshots.
