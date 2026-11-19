# Plate review dashboard: design

## Problem Statement

The founder runs Plate Curator alone. It is a self-hosted curation tool that edits the License Plate Game Catalog and Publishes immutable Snapshots that installed copies of State Spotter read from Firestore. The founder wants to hand catalog review and tagging to a few invited contributors, but today that means giving each one a writable game checkout or access to the production publisher. Pipeline jobs run in an in-memory map on one machine, so a browser reload or a stopped GPU loses track of work. Approval isn't tied to the exact content that ships, and nobody can see at a glance what's waiting for review, whose machine is doing work, what was approved, or what players currently have.

For the Vercel Solutions Architect assessment, this is the customer scenario. The customer keeps Firebase, the GPU server and the game. Vercel is added for the review dashboard, its authenticated API and durable AI workflows. The deliverable is a small, deployed slice that proves the boundary works.

## Solution

`plate-curator-vercel` is a new public repository holding a Next.js review dashboard deployed on Vercel. It connects to a separate staging Firebase project and to a tagging worker on the customer's own GPU server.

- An Editor signs in, proposes changes to Plates (tags, grouping, State order), and requests a tagging job. Every change lands in one shared working draft for the environment; nobody picks a Batch. The local model on the GPU server returns tag Suggestions, and applied results land in the same draft.
- The Owner reviews the draft at a revision as a frozen diff, broken down by state, and Publishes exactly that revision. Edits saved after that revision stay in the draft for the next Publish.
- Publishing writes a new immutable Snapshot to staging Storage and then advances the staging `config/catalog` pointer. A State Spotter build already running in the iOS simulator against the same staging project offers **Catalog update available → Reload now** and shows the change with no app update.
- Vercel Workflow carries each tagging request and each Publish durably. Closing the browser, redeploying, or the GPU server going offline doesn't lose the run. It resumes when the result arrives.
- Reviewers get a public URL, demo Editor and Owner accounts, and a labelled replay of a completed local-model run for use when the GPU server is offline.

## User Stories

1. As an Owner, I want to invite contributors as Editors, so that review work no longer depends on me alone.
2. As an Owner, I want Editors to be unable to Publish, so that nothing reaches players without my approval.
3. As an Editor, I want to sign in with my Google account or sign up with my email, and be an Editor straight away, so that I never need a game checkout, a Firebase credential or an invitation to try the dashboard.
4. As an Editor, I want to see every unpublished change, by state, with clear status badges, so that I know what needs work.
5. As an Editor, I want to open a Plate and see its current published values next to my proposed values, so that I understand exactly what I'm changing.
6. As an Editor, I want to see each Plate's image, so that I can judge tags and grouping visually.
7. As an Editor, I want to edit a Plate's tags, so that search and grouping in the game improve.
8. As an Editor, I want to change a Plate's Template family or Template/Variant role, so that grouping errors get fixed.
9. As an Editor, I want my edit saved against the Plate revision I started from, so that I can't silently overwrite someone else's change.
10. As an Editor, I want a clear conflict view when someone else changed the same Plate first, showing their value and mine, so that I can choose what to keep.
11. As an Editor, I want two Editors to be able to work on different Plates in the shared draft at the same time, so that we don't block each other.
12. As an Editor, I want to request a tagging job for a Plate, so that the local model suggests tags I might have missed.
13. As an Editor, I want to see the job's state (queued, running, waiting on the GPU, done, expired), so that I know whether to wait or work by hand.
14. As an Editor, I want to close my browser while a job runs and find the result when I come back, from any device, so that I'm not tied to one tab.
15. As an Editor, I want to move through suggested tags with the keyboard, toggle each one, and see what will be added before saving, so that reviewing suggestions is fast and deliberate.
16. As an Editor, I want suggestions that are already present or invalid for the taxonomy marked or excluded, so that I don't add duplicates or junk.
17. As an Editor, I want to finish a Plate by hand when the GPU server is offline, so that the model is never a hard dependency.
18. As an Editor, I want every change I save, and every pipeline result applied, to land in one shared working draft, so that I never pick a Batch and nobody's work waits behind someone else's.
19. As an Editor, I want Review to list every unpublished change with who made it, so that I know what the next Publish will ship.
20. As an Owner, I want to see the draft at its current revision as a frozen diff against the live catalog, broken down by state, so that I publish exactly what I reviewed.
21. As an Owner, I want each Publish to record the draft revision, me, the time, and the baseline Snapshot version, so that there's an audit trail.
22. As an Owner, I want Publish to ship the revision I reviewed even when curators saved more since, and keep those later changes in the draft, so that curators never stop working while I release.
23. As an Owner, I want to be warned when the live Snapshot changed after the draft's baseline and affected Plates differ, so that I don't publish over someone else's release.
24. As an Owner, I want to Publish the whole draft with one confirmed action, and be told why and how many runs remain when pipeline work blocks it, so that releasing is deliberate.
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
40. As a reviewer at Vercel, I want changes that need the cloud to get a Preview Deployment wired to staging only, so that they are reviewed against real data without production risk, while everyday UI work is checked on local dev servers so the deployment budget lasts.
41. As a reviewer at Vercel, I want the public commit history to show the design first and each change validated, so that I can follow how the work evolved.
42. As the founder, I want nothing private (personal or work emails, private hostnames, internal infrastructure names) to ever reach the public repository, so that the repo is safe to share.
43. As the founder, I want Preview builds to be technically unable to reach production Firebase, so that a misconfigured Preview can't touch players.
44. As the founder, I want to measure valid-output rate, acceptance without edits, correction time and turnaround on a labelled set, so that any future switch to a hosted model is decided on cost per accepted Plate.
45. As the founder, I want to agree the redesign's goals in a conversation before any screen is drawn, so that the design solves the right problems.
46. As an Editor, I want the redesigned Home to still show every state's progress, so that nothing I rely on disappears.
47. As an Editor, I want the redesigned state workspace to keep the plate queue, State order, Template families, tags and Standard plate, so that I can curate the same work in a better layout.
48. As a reviewer at Vercel, I want the history to show the design, then the build on demo data, then the connection to staging, so that I can follow how the work evolved.
49. As the founder, I want the risky connection to staging and Workflow proved while the screens are being designed, so that an integration problem surfaces on day one, not the night before.

## Implementation Decisions

**Vercel's role and what stays**
- The role is Augment, with Connect for the data path. Vercel hosts the dashboard UI, the authenticated API (Vercel Functions) and durable orchestration (Vercel Workflow).
- What stays and why:
  - Firebase (Firestore and Storage): the game reads it directly.
  - The customer's GPU server and Ollama: existing capacity, no per-call fee.
  - The existing private Plate Curator and its Pi deployment: they remain the production release path in this phase.
  - The game: unchanged upstream.
- The three Vercel primitives: Preview Deployments (staging review of changes that need the cloud, built locally and uploaded), Functions (authenticated API), Workflow (the AI-stack primitive, for durable model jobs and Publish).

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
- Owner is an allowlist of user IDs held in server configuration, never something a user can claim. Editors can't publish, so open sign-up can't reach players.
- Google sign-in works on `localhost` and the Production domain only: Firebase's authorized domains don't accept wildcards, so Preview URLs offer email sign-up instead.
- Open sign-up is protected by per-user rate limits on writes, the resettable demo batch, and the staging budget alert.
- Session strategy for the port: the browser holds the Firebase ID token and calls Route Handlers with it, and the server verifies it on every request. This keeps the original app's client-side data loading for parity. Server Components render only the non-private frame. A server-readable session cookie is a later option, not part of this demo.
- Three separate checks, never substituted for one another: the curator's Firebase identity (who is asking), the server-side role (what they may do), and the deployment's Vercel OIDC identity (whether this server may reach Google at all).
- Roles are `editor` and `owner`, stored server-side per user. Every route checks its role on the server, and the UI hiding a control is never the check.
- Demo accounts: one Editor and one shared staging Owner, with credentials in the submission, for reviewers who'd rather not use their own account.

**Domain terms introduced** (they extend the glossary and don't redefine existing terms):
- **Shared draft**: the one working set of Proposed edits and State orders per review environment. Every curator change and applied pipeline result lands in it.
- **Review batch**: a named set of Proposed edits. Since #216 the only Batches are the shared draft, the frozen releases Publish ships, and per-person Batches from before the shared draft, kept as history.
- **Proposed edit**: a change to one existing Plate's fields. It holds the base revision the Editor saw (a content hash of the Plate as currently proposed: the baseline Snapshot's Plate merged with any existing Proposed edit), so a save made over someone else's newer Proposed edit is refused. It also holds the proposed field values, the author and the update time. It is not an Inbox candidate.
- **Batch revision**: an integer that increases on every change to a batch. Publish always names one.
- **Curator state**: the curator-owned progress per state (`in_progress`, `needs_ordering`, `done`) and the saved State order. It is separate from the Snapshot, which carries catalog content only.
- **Tagging job**: one request for local-model tag suggestions on one Plate, tied to that Plate's revision at request time (its input hash), so an edit to a different Plate in the batch doesn't invalidate it.
- **Suggestion**: a validated tag proposed by a Tagging job, with the model identity that produced it.
- **Claim**: a worker's time-limited lease on a Tagging job, identified by a claim ID.
- **Publish record**: one record per draft revision that is Published. It holds the from and to versions, the Snapshot checksum, and its state.

**Shared draft** (owned by the domain module; it replaced per-person Batches and the Submit and Approve steps in #216):
- One draft per review environment. Dashboard moves and merges, Plate edits and applied pipeline results all write into it. Curators never pick a Batch.
- Plate saves check the content hash and the per-Plate edit version the curator saw. Saves to different Plates retry with jitter if the draft advances. A pipeline result checks the content it started from before applying its field changes.
- Dashboard order and family moves send the selected Plates and a placement anchor. Firestore applies each move to the current State order in commit order across server instances. Concurrent moves of different Plates to the same anchor both survive in that order. The transaction saves a move's result with its changes, so a retry with the same operation ID returns the original result. Each move requires the first Plate to be the sole active Standard Template, and grouping changes enforce Publish's family rules.
- Each change also records its before-images in a change log, so an earlier revision can be rebuilt.
- Publish is Owner-only. It freezes the draft at the revision shown into an immutable release and ships the whole release. It records who, when, the revision and the baseline catalog version.
- After a Publish, the draft rebases onto the new catalog version. Published edits drop out and edits made after the published revision stay. Change log entries up to the published revision are pruned.
- A rebase works from the committed publish receipt that moved the pointer, not from whatever release looks published. While that publish is still finishing (the pointer moved, the receipt isn't settled), reads leave the draft where it is. The draft's baseline only moves forward, so a delayed post-publish step for an older release can't move it back.
  - The rebase traces every version between the draft's baseline and the live pointer. Each committed publish in that span is replayed in order, including this draft's releases committed before an outside move, so changes made after a release survive the move. When the receipts cannot trace the span (the publishes don't chain because the pointer went back between them, or the span is longer than the 20 publishes a rebase traces), the draft is not moved: its baseline, edits and change log stay as they are. A catalog conflict names the span and lists every value and State order the draft put back after one of its accepted, unabandoned releases from that baseline, with the value the draft wants, because live may now hold what that release shipped. Publish is blocked, and an Editor's save doesn't clear it. When the Owner keeps the draft's values, the put-backs join the draft and it moves onto live in one write; a Plate live no longer has becomes a removed-Plate conflict.
  - A committed publish is replayed from its own Snapshot's State order for the States it ordered, not from the curator order, which holds only the latest publish. An order a later publish restored is therefore not mistaken for a pending change.
- A change made after the published revision that clears a field the release added is carried as an explicit clear on the new baseline, so the rebase never drops it. A cleared image and its source, a cleared family grouping, and the other optional keys are published without their keys, and a cleared Template role also drops the derived `isTemplate` flag, so the next Snapshot stays valid. Undoing a deletion is refused while a release that deletes the Plate is publishing or waits for Retry or Abandon; once that release is abandoned, or its run ended before preparing a Snapshot, the undo is accepted. One that slips past becomes a conflict.
- The draft's last-publish record (who, when, which revision) comes from that committed receipt.
- When the pointer moves outside this draft's releases and changes a value the draft also changed, the draft lists the conflicting fields. An outside change that removes a Plate the draft changed keeps those values as a removed-Plate conflict instead of dropping them. Publish is blocked until the Owner keeps the draft values; the Publish view lists each conflict, says what the Owner must review, and links to Review. For a removed Plate it shows the pending values and labels the keep as omitting them; for a catalog conflict it shows the put-backs and labels the keep as publishing them.
- A Publish of a newer revision answers 409 `release_in_progress` while an earlier release of the draft is publishing or waits for Retry or Abandon. Acceptance is fenced per draft: the transaction that accepts a new command checks and advances a per-draft fence read before that check, so of two racing requests only one revision is accepted and started; the other answers 409 `release_in_progress`. Before an existing freeze is reused, through the draft's Publish or the release's own, the draft is settled and its latest conflicts and floor are checked (409 `draft_conflicts` or `superseded_revision`). A replay of the already accepted command still answers as before.
  - A fresh command for an accepted release (Retry, or Publish again on its recovery page) takes the same fence. It answers 409 `release_superseded` once a newer revision of the draft was accepted, since that revision carries the release's values with the corrections made after it, and 409 `release_in_progress` while another release of the draft is publishing or waits for Retry or Abandon. The release being retried doesn't hold the draft against itself. At acceptance the command is refused unless the fence still names this release as the draft's latest accepted one; a retry that is accepted advances the fence, so a draft Publish that checked before it refuses too. The recovery view stops offering Publish again for the same reasons.
- Publish waits while pipeline runs are queued or running. The Publish view says so and shows how many runs remain.
- When the live pointer moves past the draft's baseline, the draft rebases onto it the next time it is read.
- Per-person Batches from before the shared draft are folded into it once by `npm run migrate:shared-draft`, newest value per field and per State order. Published Batches stay readable as history.
  - Before writing, the migration takes the Publish lock as a migration hold, in the same transaction that checks no pipeline run is queued or running. Publishes and new pipeline runs wait until the fold is written. The hold lapses after 10 minutes, so a rerun can take over from an interrupted one. The fold's own write transaction checks the hold's token, expiry and pointer version again, so a hold lost after the last confirmation is never written over.
  - A folded Batch keeps its last save time (`lastChangedAt`) and records `foldedAt` separately. The dry run, an apply, and a rerun after an interrupted apply all pick the same State order.
  - Conflict Batches are left out. They open read-only in Review, and their changes are redone in the shared draft.
- Old Batches and releases are read-only history. A curator write, review checkpoint or pipeline run that names one answers 409 `history_read_only`; the shared draft is the only write target. Review records checkpoints only for the shared draft.
- Old `?batch=` links on the Dashboard and Review open the shared draft with a notice when the Batch was folded, is still open, or no longer exists. The page's anchor (such as `#families`) is kept, including when the notice is dismissed. A published Batch, a release, or a conflict Batch opens read-only in Review.
- A release and the migration's fold are each written in one Firestore request, capped at 10 MiB. Both refuse past a 9 MiB budget (`draft_too_large`, with a message saying what to do) instead of failing on every retry. The migration checks this on the dry run and before closing any Batch. Writing them in bounded chunks would lift the budget.
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
- *Publish run*: it starts when the Owner publishes a frozen release of the draft, and its steps Publish that release. The Approval run that waited for Submit and Approve was retired with the shared draft.
- Every step with an external effect is safe to repeat: create-only uploads, conditional pointer advances, and writes keyed by job, claim or Publish record ID.

**Publish**
- Owner-only, and only for a frozen release of the shared draft.
- One Publish at a time: a Publish lock document is claimed in a transaction (with a lease) before anything is uploaded, so two publishers never race for the same next version.
- A release whose run is still live holds the draft's Publish button. A release that failed before preparing a Snapshot, or that the Owner abandoned, no longer does, so the corrected draft revision can publish. A release that stopped after preparing its Snapshot waits for recovery (retry or Abandon) and stays reachable from the Publish view.
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

**A redesigned dashboard, alongside the existing curator**
- The dashboard is a redesign of Plate Curator's Home (the states overview) and state page, built directly in Next.js. There is no 1:1 port of the old screens. All other curator views stay in the private app: inbox, pipeline console, rarity, strip art, users, image crop/upload/replace.
- The new dashboard runs **alongside** the existing curator, which stays the production path and the rollback. Contributors move to the new review flow first. Production publishing moves over only after the new flow has shadowed one release.
- The work runs in phases. Each one starts with a conversation, then the work, then the founder's approval: agree the plan, design conversation, design the screens, build them in Next.js on demo data, hook-up conversation, connect to staging, review flow, local-model suggestions, Publish, demo and checks, write-up.
- The riskiest boundary is proved early, in parallel with design: Vercel reaching staging Firebase with no stored key, and a Workflow wait that survives a redeploy. That work also lands the bare Next.js app the screens are later built into, so the build phase starts from it instead of scaffolding again.
- The design captures today's two screens as "before" screenshots and a checklist of the workflows they support: state progress, the plate queue, State order, Template families, tags, the Standard plate. The new design must give each one a home.
- Designs are annotated with the architecture: what renders on the server, what streams, what refreshes after a Publish, and what waits durably.

**Dashboard UI**
- Three layers with separate jobs: Geist as the reference for typography, colour and hierarchy; shadcn/ui for the components; UI SDK only for the suggested-tag picker's behaviour.
- shadcn/ui throughout: queue, badges, detail panels, dialogs, the Publish confirmation.
- Unsaved, saved in the draft and published are visibly different states, so a curator can always answer "what happened to my change?".
- Vercel's UI SDK is used only inside the suggested-tag picker, for keyboard focus and selection.
- The light visual redesign follows one standards document in the repo, distilled from Vercel's Web Interface Guidelines, Next.js 16, React best practices, shadcn/ui and UI SDK docs. Every dashboard change is generated and reviewed against that same document.

**Game side**
- Uses the existing local branch with live catalog reload. It is built for the simulator with a local, untracked environment file pointing at staging. Nothing is pushed or merged upstream.

**Repository hygiene**
- Every commit uses the GitHub no-reply identity.
- A local commit hook rejects other author emails.
- GitHub Actions routes verification and hygiene jobs to the repository-scoped ARM64 Linux runner labeled `plate-curator-device`. The device runs these jobs for same-repository pull requests and the configured branch pushes while the repository is private. Hygiene scans for secrets, verifies author emails, and searches for a private list of forbidden strings. The list is stored as a CI secret and a gitignored local file, never in the repo. Before making the repo public, disconnect the device runner and move the jobs to GitHub-hosted runners.

**How work is accepted**
- Every change arrives as a pull request into `main`, the trunk. No branch deploys on push except `release`. UI changes are checked on a worker's local dev server, reached over the private network. A Preview is made on purpose, by building locally and uploading the output (`vercel build` then `vercel deploy --prebuilt`), only when a change needs the cloud: OIDC, Workflow or a reviewer link.
- A release fast-forwards `release` to a reviewed commit on `main` (`git push origin main:release`). Vercel builds that one commit as a staged Production deployment that doesn't take the domain. The founder smoke-tests its URL as the demo Editor and Owner, then promotes it with `vercel promote`, with no rebuild. `vercel rollback` moves the domain back. This follows Vercel's build, test, promote practice while keeping builds to one per release.
- Each pull request is reviewed against this spec and its acceptance checks, and its tests run, before it merges.
- The founder approves each stage before it starts and merges.

## Testing Decisions

**What makes a good test here:** it exercises behaviour through a public interface and asserts outcomes a user or the game would observe. Examples:
- a stale save is refused, with the current value returned
- publishing revision N leaves edits made after N in the draft
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
- Redeploy while a Publish run waits.

The Workflow run view is the evidence for each.

**Workflow coverage:** before the build is approved, every item on the design's workflow checklist is shown working on the Preview against demo data. The check is recorded in the pull request.

**Preview checks:**
- Every PR gets a Playwright smoke pass on the local dev server against demo data. Each staged release, before promotion, and each deliberate Preview gets the same pass, once as the demo Editor and once as the demo Owner, against staging.
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
4. Publish the draft at the revision shown.
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
  - why Publish names a revision
  - why staging can't reach production
  - catalog rollback (publish old content as a higher version) versus dashboard rollback (revert the Vercel deployment). They're independent; follow the [release-control rollback requirements](publish-recovery.md#deployment-compatibility-and-release-gate) before reverting to older code.
- **Sources:**
  - Firebase, separate projects per environment: https://firebase.google.com/docs/projects/dev-workflows/general-best-practices
  - Vercel OIDC to Google Cloud: https://vercel.com/docs/oidc/gcp
  - Firestore multiple databases: https://firebase.google.com/docs/firestore/manage-databases
