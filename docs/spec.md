# Plate review dashboard: design

## Problem Statement

The founder runs Plate Curator alone. It is a self-hosted curation tool that edits the License Plate Game Catalog and Publishes immutable Snapshots that installed copies of State Spotter read from Firestore. The founder wants to hand catalog review and tagging to a few invited contributors, but today that means giving each one a writable game checkout or access to the production publisher. Pipeline jobs run in an in-memory map on one machine, so a browser reload or a stopped GPU loses track of work. Approval isn't tied to the exact content that ships, and nobody can see at a glance what's waiting for review, whose machine is doing work, what was approved, or what players currently have.

For the Vercel Solutions Architect assessment, this is the customer scenario. The customer keeps Firebase, the GPU server and the game. Vercel is added for the review dashboard, its authenticated API and durable AI workflows. The deliverable is a small, deployed slice that proves the boundary works.

## Solution

`plate-curator-vercel` is a new public repository holding a Next.js review dashboard deployed on Vercel. It connects to a separate staging Firebase project and to a tagging worker on the customer's own GPU server.

- An Editor signs in, opens a Review batch, proposes changes to Plates (tags, grouping), and requests a tagging job. The local model on the GPU server returns tag Suggestions. The Editor accepts some, then submits the batch.
- The Owner reviews a frozen Batch revision and approves exactly that revision. The approval is invalidated if anyone edits the batch afterwards. The Owner then Publishes.
- Publishing writes a new immutable Snapshot to staging Storage and then advances the staging `config/catalog` pointer. A State Spotter build already running in the iOS simulator against the same staging project offers **Catalog update available → Reload now** and shows the change with no app update.
- Vercel Workflow carries each tagging request and each approval durably. Closing the browser, redeploying, or the GPU server going offline doesn't lose the run. It resumes when the result or the decision arrives.
- Reviewers get a public URL, demo Editor and Owner accounts, and a labelled replay of a completed local-model run for use when the GPU server is offline.

## User Stories

1. As an Owner, I want to invite contributors as Editors, so that review work no longer depends on me alone.
2. As an Owner, I want Editors to be unable to Publish, so that nothing reaches players without my approval.
3. As an Editor, I want to sign in with my Google account or sign up with my email, and be an Editor straight away, so that I never need a game checkout, a Firebase credential or an invitation to try the dashboard.
4. As an Editor, I want to see a queue of open Review batches with clear status badges, so that I know what needs work.
5. As an Editor, I want to open a Plate and see its current published values next to my proposed values, so that I understand exactly what I'm changing.
6. As an Editor, I want to see each Plate's image, so that I can judge tags and grouping visually.
7. As an Editor, I want to edit a Plate's tags, so that search and grouping in the game improve.
8. As an Editor, I want to change a Plate's Template family or Template/Variant role, so that grouping errors get fixed.
9. As an Editor, I want my edit saved against the Plate revision I started from, so that I can't silently overwrite someone else's change.
10. As an Editor, I want a clear conflict view when someone else changed the same Plate first, showing their value and mine, so that I can choose what to keep.
11. As an Editor, I want two Editors to be able to work on different Plates in the same batch at the same time, so that we don't block each other.
12. As an Editor, I want to request a tagging job for a Plate, so that the local model suggests tags I might have missed.
13. As an Editor, I want to see the job's state (queued, running, waiting on the GPU, done, expired), so that I know whether to wait or work by hand.
14. As an Editor, I want to close my browser while a job runs and find the result when I come back, from any device, so that I'm not tied to one tab.
15. As an Editor, I want to move through suggested tags with the keyboard, toggle each one, and see what will be added before saving, so that reviewing suggestions is fast and deliberate.
16. As an Editor, I want suggestions that are already present or invalid for the taxonomy marked or excluded, so that I don't add duplicates or junk.
17. As an Editor, I want to finish a Plate by hand when the GPU server is offline, so that the model is never a hard dependency.
18. As an Editor, I want to submit a batch for review, so that the Owner knows it's ready.
19. As an Editor, I want any edit after submission to reopen the batch as a new revision, so that it's obvious the earlier submission is stale.
20. As an Owner, I want to see a submitted Batch revision as a frozen diff against the live catalog, so that I approve exactly what will ship.
21. As an Owner, I want my approval to record the revision, me, the time, and the baseline Snapshot version, so that there's an audit trail.
22. As an Owner, I want approval of a superseded revision to be rejected, so that I can't approve content that has since changed.
23. As an Owner, I want to be warned when the live Snapshot changed after the batch's baseline and affected Plates differ, so that I don't publish over someone else's release.
24. As an Owner, I want to Publish an approved revision with one confirmed action, so that releasing is deliberate.
25. As an Owner, I want Publish to write the Snapshot before advancing the pointer, so that players never point at a missing Snapshot.
26. As an Owner, I want a retried or double-clicked Publish to never create two versions, so that the version line stays clean.
27. As an Owner, I want a Publish that uploaded but failed to advance the pointer to be reconciled from its record, so that a partial failure is recoverable.
28. As an Owner, I want to see the currently published version and what changed in it, so that I know what players have.
29. As an Owner, I want to roll catalog content back by publishing the previous content as a new, higher version, so that clients that already fetched the bad version also recover.
30. As an Owner, I want to see each Workflow run's steps and where it's waiting, so that I can explain and debug the process.
31. As a GPU server operator, I want the worker to make only outbound HTTPS calls, so that no inbound port opens on my network.
32. As a GPU server operator, I want the worker to hold a scoped, revocable token that can only claim jobs and report results, so that a leaked token can't publish or edit.
33. As a GPU server operator, I want a claimed job to expire if my worker stops, so that it can be claimed again when capacity returns.
34. As a GPU server operator, I want a result for an expired claim, or for a Plate that has changed since the job started, to be refused, so that stale work never lands.
35. As a GPU server operator, I want each result to record backend, model, prompt/taxonomy version and duration, so that model quality and cost can be measured.
36. As a player, I want the open game to offer a reload when a new catalog version is published, so that I see fixes without updating the app.
37. As a player, I want the reload prompt to wait until I'm not in a game or joining one, so that it never interrupts play.
38. As a reviewer at Vercel, I want a public demo URL with demo Editor and Owner credentials, so that I can exercise both roles.
39. As a reviewer at Vercel, I want canned example batches and a labelled replay of a completed local-model run, so that I can test while the GPU server is offline.
40. As a reviewer at Vercel, I want every pull request to get a Preview Deployment wired to staging only, so that changes are reviewed against real data without production risk.
41. As a reviewer at Vercel, I want the public commit history to show the design first and each change validated, so that I can follow how the work evolved.
42. As the founder, I want nothing private (personal or work emails, private hostnames, internal infrastructure names) to ever reach the public repository, so that the repo is safe to share.
43. As the founder, I want Preview builds to be technically unable to reach production Firebase, so that a misconfigured Preview can't touch players.
44. As the founder, I want to measure valid-output rate, acceptance without edits, correction time and turnaround on a labelled set, so that any future switch to a hosted model is decided on cost per accepted Plate.
45. As the founder, I want my existing Home and state pages moved onto Next.js unchanged first, so that the migration is proven before anything is redesigned.
46. As an Editor, I want the ported Home to show the same states and progress as today, so that nothing I rely on disappears in the move.
47. As an Editor, I want the ported state page to show the same Plates in the same State order with the same Template families, so that I can keep curating the same way.
48. As a reviewer at Vercel, I want the public history to show the original screens, then the port, then the redesign, so that I can see exactly what moved and what changed.
49. As the founder, I want to lead a light redesign of the ported screens while backend work continues in parallel, so that the two-day deadline holds.

## Implementation Decisions

**Vercel's role and what stays**
- The role is Augment, with Connect for the data path. Vercel hosts the dashboard UI, the authenticated API (Vercel Functions) and durable orchestration (Vercel Workflow).
- What stays and why:
  - Firebase (Firestore and Storage): the game reads it directly.
  - The customer's GPU server and Ollama: existing capacity, no per-call fee.
  - The existing private Plate Curator and its Pi deployment: they remain the production release path in this phase.
  - The game: unchanged upstream.
- The three Vercel primitives: Preview Deployments (staging review of every PR), Functions (authenticated API), Workflow (the AI-stack primitive, for durable model jobs and human approval).

**Repositories and environments**
- The new public repo `plate-curator-vercel` is the only place assessment code lives. Plate Curator stays private and untouched. Only the contract pieces needed are recreated in the new repo: Snapshot shape and validation, the tag taxonomy rules, and the local-model tagging prompt.
- The new repo is the Next.js app plus a small worker package that runs on the GPU server.
- A separate Firebase project, `license-plate-game-staging`, follows Firebase's guidance of one project per environment. It was chosen over a named database in production's project because that would need a game code change and would share production's Storage, Auth and IAM.
  - Firestore is in `nam5`, matching production.
  - It runs the game's own Firestore and Storage rules.
  - Anonymous sign-in is on.
  - The baseline `config/catalog` is at version 11, the same catalog the game bundles.
- Both Vercel Preview and the demo's Production environment point at staging. Production Firebase has no credentials anywhere in Vercel.

**Server access from Vercel to Firebase**
- Vercel Functions authenticate to Google Cloud through Vercel OIDC federation with Google Workload Identity Federation, so no long-lived service-account key is stored in Vercel.
  - The provider's attribute condition accepts only this Vercel project's tokens.
  - The mapped service account has access only to the staging project.
- Server code uses Google Cloud's Firestore and Storage clients with an external-account credential.
- The first gate is a short spike proving this path end to end. If it fails, the fallback is a staging-only service-account key stored as a Sensitive Vercel env var, and the write-up says so.

**Identity and roles**
- Dashboard sign-in uses the staging Firebase Auth project with two methods: Google, and self-service sign-up with any email and password. Anyone who signs up becomes an Editor automatically on their first authenticated request, so reviewers can click around with their own account.
- Owner is an allowlist of user IDs held in server configuration, never something a user can claim. Editors can't approve or publish, so open sign-up can't reach players.
- Google sign-in works on `localhost` and the Production domain only: Firebase's authorized domains don't accept wildcards, so Preview URLs offer email sign-up instead.
- Open sign-up is protected by per-user rate limits on writes, the resettable demo batch, and the staging budget alert.
- Session strategy for the port: the browser holds the Firebase ID token and calls Route Handlers with it, and the server verifies it on every request. This keeps the original app's client-side data loading for parity. Server Components render only the non-private frame. A server-readable session cookie is a later option, not part of this demo.
- Three separate checks, never substituted for one another: the curator's Firebase identity (who is asking), the server-side role (what they may do), and the deployment's Vercel OIDC identity (whether this server may reach Google at all).
- Roles are `editor` and `owner`, stored server-side per user. Every route checks its role on the server, and the UI hiding a control is never the check.
- Demo accounts: one Editor and one shared staging Owner, with credentials in the submission, for reviewers who'd rather not use their own account.

**Domain terms introduced** (they extend the glossary and don't redefine existing terms):
- **Review batch**: a named set of Proposed edits for a small group of Plates.
- **Proposed edit**: a change to one existing Plate's fields. It holds the base revision the Editor saw (a content hash of the Plate as currently proposed: the baseline Snapshot's Plate merged with any existing Proposed edit), so a save made over someone else's newer Proposed edit is refused. It also holds the proposed field values, the author and the update time. It is not an Inbox candidate.
- **Batch revision**: an integer that increases on every change to a batch. Submit, approve and publish always name one.
- **Curator state**: the curator-owned progress per state (`in_progress`, `needs_ordering`, `done`) and the saved State order. It is separate from the Snapshot, which carries catalog content only.
- **Tagging job**: one request for local-model tag suggestions on one Plate, tied to that Plate's revision at request time (its input hash), so an edit to a different Plate in the batch doesn't invalidate it.
- **Suggestion**: a validated tag proposed by a Tagging job, with the model identity that produced it.
- **Claim**: a worker's time-limited lease on a Tagging job, identified by a claim ID.
- **Publish record**: one record per approved Batch revision that is Published. It holds the from and to versions, the Snapshot checksum, and its state.

**Batch lifecycle** (a state machine owned by the domain module):
- `open` → `submitted` → `approved` → `published`.
- Any Proposed edit to a `submitted` or `approved` batch returns it to `open` with a new Batch revision, and the approval is cleared.
- Approval must name the batch's current revision and fails otherwise.
- A batch whose baseline Snapshot version is behind the live pointer, where affected Plates differ, is flagged `conflict` until revalidated.
- Approval and Publish are separate Owner commands. Approving records the decision on an exact revision; publishing is its own deliberate action on that approved revision.
- Grouping edits keep Template family invariants: exactly one Template per family, `isTemplate` always consistent with `templateRole`, and a regroup that changes a Template's family carries its Variants' consequences into the same batch, as the original curator's rules do.
- At most one Standard plate per jurisdiction. Changing it updates the previous Standard plate in the same transaction.
- Editable in this demo: tags and grouping fields (`templateFamily`, `templateRole`, `variantOfPlateId`, `isStandard`). Other ported controls are display-only and say so; none silently writes.

**Firestore collections in staging** (written only by the dashboard's server code; the game never reads them):
- review batches, with their Proposed edits as a subcollection
- tagging jobs
- Publish records
- user roles
- Curator state (progress and State order), seeded from the existing curator's current values
- an audit log

Shared staging doesn't isolate pull requests from one another. The server stamps every batch and job with its environment namespace (the demo's Production or a specific Preview), taken from the deployment, never from the client, and every query filters by it. Preview test runs use their own batches, and the demo batch is resettable.

The existing `config/catalog` pointer and the `catalog/v{N}.json` Snapshots keep their current shape exactly.

**Plate data source**
- The dashboard reads the baseline catalog from the Snapshot the live pointer names and overlays Proposed edits. It never depends on the Pi or the game repo.
- Home's progress and ordering come from Curator state, not from the Snapshot.
- The demo uses a small, fixed set of Plates whose images are uploaded to staging Storage as pre-sized WebP. The dashboard and the worker load images from there directly; the Next.js image optimizer isn't used for them, because it doesn't forward authentication. Plates outside the pictured set show their metadata and an honest missing-image state, never a fabricated image.

**Worker job contract (HTTPS, worker to API)**
- Claim: the worker asks for the next queued job. It receives the job plus a claim ID and lease expiry, or "nothing queued".
- Report: the worker posts the result with its claim ID: validated suggestions, backend, model, prompt/taxonomy version, duration, and usage when available.
- The API refuses a report when the claim expired, the claim ID doesn't match, or the Plate's revision no longer matches the job's input hash. A repeated report of an accepted result is acknowledged without a second write.
- The workflow's wait, the worker's lease and the inference deadline are three separate timers.
- If the deployment is protected, the worker uses Vercel's protection bypass for automation and still authenticates with its own token.
- The worker always talks to one stable URL per environment. The report route persists the result, then resumes the run's hook; the Workflow runtime routes that resumption to the deployment that owns the run, so redeploying mid-run doesn't strand it.
- An expired lease returns the job to the queue.
- The worker authenticates with a scoped bearer token that the API stores hashed and that the Owner can revoke.
- The worker runs the existing local-model call against Ollama with the current default model. The model call sits behind an adapter interface, so a future AI SDK adapter or hosted model can implement the same contract.

**Workflows** (Vercel Workflow SDK):
- *Tagging run*:
  1. The run registers its result hook, then a step creates the Tagging job, so a fast worker can never report before anyone is listening.
  2. The hook waits for the worker's result, which the authenticated report route resumes after persisting it. It has a timeout. If resuming fails after the result was saved, delivery is retried from the saved result.
  3. A step writes the Suggestions to the job.
  4. On timeout, the job is marked expired and the run ends visibly.
- *Approval run*:
  1. It starts when a batch is submitted.
  2. The run registers its decision hook first, then marks the batch as awaiting a decision; the dashboard only offers Approve while that mark exists. The hook waits for the Owner's decision on a specific Batch revision. The decision route persists the decision before resuming, so a failed resume is retried from the saved decision. A step records it.
  3. A second hook, registered the same way before Publish is offered, waits for the Owner's separate Publish command on that approved revision; then a step Publishes.
  4. A re-submit supersedes the waiting run.
- Every step with an external effect is safe to repeat: create-only uploads, conditional pointer advances, and writes keyed by job, claim or Publish record ID.

**Publish**
- Owner-only, and only for the batch's approved current revision.
- One Publish at a time: a Publish lock document is claimed in a transaction (with a lease) before anything is uploaded, so two publishers never race for the same next version.
- If the create-only upload finds `catalog/v{N+1}.json` already exists, the Publish compares its checksum with the Publish record: a match means a retry of this Publish (continue to the pointer step); a mismatch means another release took that version (stop, release the lock, and re-read the pointer).
- Validates the full resulting Snapshot against the game's Snapshot contract before uploading.
- Uploads `catalog/v{N+1}.json` with a create-only precondition.
- Then advances `config/catalog` in a transaction only if it still names version N.
- Records the outcome on the Publish record.
- If the upload succeeded but the pointer step failed, a retry reconciles by Publish record and checksum instead of creating a new version.

**Data loading and caching**
- One server-only data-access layer over a pure domain layer. Server code calls it directly, never the app's own HTTP endpoints. Route Handlers adapt browser and worker requests to the same operations and return narrow serializable shapes.
- Authenticated, mutable responses are `private, no-store`. Immutable Snapshots are keyed by version and checksum. Pointer reads are fresh at every review and Publish decision.
- SWR is the single client-side query owner for polling, focus and reconnect refresh. It polls only while a job is active, and unsaved field values live in a separate local draft so a refresh never overwrites typing.
- Browser-only state the original kept in `localStorage` (active state, queue position) moves to the URL or to an effect after hydration.

**Bringing the existing app over (Replace for the frontend)**
- The dashboard is the existing Plate Curator Home (the states overview) and the state page, ported to Next.js. It isn't a new screen. All other curator views stay behind in the private app: inbox, pipeline console, rarity, strip art, users, image crop/upload/replace.
- The public history shows the migration honestly, in order:
  1. this spec
  2. the original Home and state page source, copied verbatim into a `legacy/` folder with no images, as the "before"
  3. a crude 1:1 Next.js port, checked against the original
  4. the redesign
  5. the Vercel-native review flow

  The `legacy/` folder is deleted once the port is verified.
- The port keeps behaviour, layout and wording 1:1, with intentional, labelled exceptions: controls outside the demo's editable fields are display-only, image editing and presence are removed, and saving goes to a Review batch. It swaps only the data path. Reads come from the staging Snapshot instead of the game repo's `plates.json` through Express. Saves become Proposed edits in a Review batch instead of direct catalog writes. Images are display-only.
- Images use Firebase Storage download-token URLs, the same mechanism the game uses for Snapshots. They are unguessable but not per-user, which fits: plate art is already public in the shipped app.
- The light redesign is founder-led, after the port lands. It runs in parallel with the backend work.

**Dashboard UI**
- Three layers with separate jobs: Geist as the reference for typography, colour and hierarchy; shadcn/ui for the components; UI SDK only for the suggested-tag picker's behaviour.
- shadcn/ui throughout: queue, badges, detail panels, dialogs, the Publish confirmation.
- Unsaved, saved, submitted, approved and published are visibly different states, so a curator can always answer "what happened to my change?".
- Vercel's UI SDK is used only inside the suggested-tag picker, for keyboard focus and selection.
- The light visual redesign follows one standards document in the repo, distilled from Vercel's Web Interface Guidelines, Next.js 16, React best practices, shadcn/ui and UI SDK docs. Every dashboard change is generated and reviewed against that same document.

**Game side**
- Uses the existing local branch with live catalog reload. It is built for the simulator with a local, untracked environment file pointing at staging. Nothing is pushed or merged upstream.

**Repository hygiene**
- Every commit uses the GitHub no-reply identity.
- A local commit hook rejects other author emails.
- A GitHub Actions check (within the private-repo allowance; free once public) on every pull request runs a secret scanner, verifies author emails, and searches for a private list of forbidden strings. The list is stored as a CI secret and a gitignored local file, never in the repo. Branch protection requires the check to pass.

**How work is accepted**
- Every change arrives as a pull request with a Vercel Preview.
- Each pull request is reviewed against this spec and its acceptance checks, and its tests run, before it merges.
- The founder approves each stage before it starts and merges.

## Testing Decisions

**What makes a good test here:** it exercises behaviour through a public interface and asserts outcomes a user or the game would observe. Examples:
- a stale save is refused, with the current value returned
- approval of an old revision fails
- a second Publish of the same revision produces no second version
- a report on an expired claim is refused

Tests don't assert internal call order or private state. Unit tests never touch the network or a model.

**Seams** (the fewest, at the highest level):
1. **The dashboard's domain module.** This is the main seam. Batch lifecycle, Proposed edits, role checks, Tagging job claims and reports, and Publish all live in one server-side module with injected adapters: store, Snapshot storage, pointer, clock, identity, ID generation. Route handlers and workflow steps are thin calls into it.
   - Most behaviour is tested here with in-memory adapters.
   - The Firestore adapter is tested against the Firebase emulator: the transactional revision check, the conditional pointer advance, and the create-only upload.
2. **The worker's loop.** Claim, run, report, tested with a fake API and a fake model adapter. The fakes cover a lease expiring mid-run, a refused report, and the model being unreachable.
3. **The game's existing catalog watcher.** This is an existing seam with an existing emulator test that publishes a tag edit and expects the reload offer. It's rerun against the new Publish path's output.

**Durability, checked by running the system:**
- Close the browser while a Tagging job is pending and resume from another session.
- Stop the worker mid-claim, let the lease expire, and reclaim.
- Redeploy while an Approval run waits.

The Workflow run view is the evidence for each.

**Port parity:** before the redesign starts, the ported Home and state page are compared side by side with the original on the same staging catalog. The checks:
- the same states and progress
- the same Plates in the same State order
- the same Template families and Variants
- the same tags and metadata fields

The comparison is recorded in the port PR.

**Preview checks:**
- Every PR's Preview gets a Playwright smoke pass, once as the demo Editor and once as the demo Owner, against staging.
- The pass confirms that the Owner-only controls fail on the server for the Editor.

**AI behaviour:**
- A labelled set of 25 Plate images, covering plain and ambiguous cases, is run through the worker. The set records valid-output rate, acceptance without edits, correction time, turnaround and retries.
- The raw rows are kept so the cost-per-accepted-Plate arithmetic can be checked.

**Prior art:**
- Plate Curator's pure-function server tests with injected dependencies, including the Snapshot publisher's tests.
- Its Firestore emulator suite.
- The game's live-catalog-reload emulator test.

**End to end:** the demo baseline, run once for real and recorded with the Preview URL, the Workflow run ID and the before/after catalog versions:
1. Edit a pictured Plate.
2. Run a real local tagging job.
3. Accept a Suggestion.
4. Submit, approve that exact revision, and Publish.
5. Reload in the simulator.

## Out of Scope

- Publishing to production Firebase, or changing the production publisher or the Pi deployment.
- Pushing or merging anything to the License-Plate-Game repository, and any change to the game's own code beyond the existing local live-reload branch.
- Remote plate images, image upload or replacement, the image refiner, and bulk or multi-state pipelines.
- A hosted model or AI Gateway route. The adapter boundary is designed for one, and a benchmark is backlog.
- A separate reviewer role distinct from Owner.
- Apple sign-in, and Google sign-in on Preview URLs.
- A TestFlight build for reviewers and a staging-only Owner login for them. Both are backlog after submission.
- Migrating the catalog off Firestore.

## Further Notes

- **Deadline:** the submission is due two days from 2026-11-15. Work runs two tracks at a time:
  1. dashboard plus worker first
  2. then game reload against staging

  Each stage starts only after the founder approves it.
- **Risks, in order:**
  - **Vercel OIDC with Google Cloud clients:** spike first; the fallback is described above.
  - **UI SDK is beta:** verify keyboard and focus in the demo browser.
  - **Local model cold start:** about two minutes on the GPU host. Warm it before demos and show the replay when offline.
  - **Generated code drifting from the spec:** caught by reviewing every pull request against it.
- **Interview talking points this design is built to support:**
  - concurrent edits
  - Owner-only Publish
  - recovery when the GPU server stops
  - why approval names a revision
  - why staging can't reach production
  - catalog rollback (publish old content as a higher version) versus dashboard rollback (revert the Vercel deployment). They're independent.
- **Sources:**
  - Firebase, separate projects per environment: https://firebase.google.com/docs/projects/dev-workflows/general-best-practices
  - Vercel OIDC to Google Cloud: https://vercel.com/docs/oidc/gcp
  - Firestore multiple databases: https://firebase.google.com/docs/firestore/manage-databases
