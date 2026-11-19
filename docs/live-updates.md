# Live updates and hosting usage (#220)

The Dashboard, Plate Pipeline drawer, research panel and Publish used to poll their
APIs on timers. Each poll is a Vercel Function invocation and usually several
Firestore reads, whether or not anything changed. This page records how we measured
that cost, what replaced the polling, and the cost afterwards.

## Before and after

Both scenarios keep one Dashboard open on `/states/AK` with the Plate Pipeline drawer
open, and a local worker connected. The method is below.

### During a 40-plate run

10 minutes of observation, scaled to one hour.

| Calls per hour | Before | After | Change |
| --- | ---: | ---: | ---: |
| `GET /api/local-pipeline/runs` | 1,343 | 1,411 | +5% |
| `GET /api/jobs/runs` | 1,164 | 60 | −95% |
| `POST /api/worker/claim` | 770 | 771 | 0% |
| `POST /.well-known/workflow/v1/flow` | 740 | 724 | −2% |
| `POST /api/worker/jobs/[id]/report` | 346 | 347 | 0% |
| `POST /api/local-pipeline/runs/selection` | 6 | 6 | 0% |
| `POST /api/worker/capabilities` | 0 | 6 | new |
| **All requests** | **4,370** | **3,325** | **−24%** |
| From the browser | 2,495 | 1,465 | −41% |

| Firestore per hour | Before | After | Change |
| --- | ---: | ---: | ---: |
| Document reads | 121,253 | 105,565 | −13% |
| Query results | 7,791 | 5,783 | −26% |
| Writes | 4,322 | 7,535 | +74% |

### Drawer open, no run

5 minutes of observation, scaled to one hour.

| Calls per hour | Before | After | Change |
| --- | ---: | ---: | ---: |
| `GET /api/jobs/runs` | 1,180 | 60 | −95% |
| `GET /api/local-pipeline/runs` | 1,168 | 72 | −94% |
| `POST /api/worker/claim` | 715 | 715 | 0% |
| **All requests** | **3,064** | **846** | **−72%** |
| From the browser | 2,336 | 131 | −94% |

| Firestore per hour | Before | After | Change |
| --- | ---: | ---: | ---: |
| Document reads | 2,599 | 1,502 | −42% |
| Query results | 6,580 | 1,049 | −84% |
| Writes | 715 | 727 | +2% |

### Reading the numbers

- Idle is where signals pay off. The browser went from 2,336 calls an hour to 131,
  which are the 60-second safety refreshes of the queue and Gateway lists. The other
  715 calls an hour are the local worker asking for work every 5 seconds; that is the
  worker's own loop, not the browser.
- During a run, every claim and every result changes a job, so the `pipeline` topic
  moves every couple of seconds (302 signals in 10 minutes). The queue list then
  refreshes about as often as it polled before (1,411 against 1,343 an hour): the
  2-second refresh limit plus request time sets the pace either way. The savings in a
  busy run come from Gateway runs (1,164 to 60 an hour, now on its own topic) and from
  fewer job queries.
- Signals and wakes cost writes. During a run Firestore writes rise by about 3,200 an
  hour: about 1,800 small signal writes, one per coalesced change, which the listening
  tab receives as reads, and about 1,400 wake-ledger writes, two per wake (the claim
  and its outcome). The ledger also reads about 2,000 documents an hour. Document reads
  still fall by about 15,700 an hour.
- Most document reads during a run come from the pipeline list re-reading every job
  of each listed run, about 67 job reads per request. Making that list cheaper, or
  refreshing the drawer less often while a run is busy, would cut further. Both are
  outside this change.

### What the first measurement after the change caught

The first run after switching to signals cost more than polling: 5,673 requests and
144,730 document reads an hour (`docs/live-updates/after-first-attempt.json`). Two
causes, both fixed before the run above:

1. `GET /api/local-pipeline/runs` doubles as a watchdog. When a run's current job has
   finished or expired, it wakes the run's workflow in case a wake was lost. The
   claim, report and fail routes already wake the workflow right after a change. A
   poll landed at a random moment, but a signal-driven read lands right after the
   change, so most hooks were resumed twice (four receipts per hook instead of two)
   and the workflow ran about twice as often (1,713 workflow calls an hour against
   740). The first fix left the wake to those routes when the job had changed less
   than 10 seconds ago (two receipts per hook, 724 workflow calls an hour). Review
   found that this grace could skip the only quick recovery of a lost wake: a failed
   wake followed by one signal-driven read inside the 10 seconds, and no later read,
   left the workflow waiting. Wakes now go through a ledger instead, described under
   Server below, and the numbers above were measured with it.
2. Gateway runs listened to the `pipeline` topic, so it refetched on every local job
   change. It now listens to `gateway`, which only hosted jobs bump.

## Method

Both runs used the same scripts and settings on one development machine. Nothing ran
against staging.

1. Start the Firestore and Auth emulators under the `demo-plate-curator` project.
2. Start the app with `scripts/live-usage/serve.sh`. It sets a `demo-` project, points
   Firestore and Auth at the emulators, uses the fixture catalog, enables the local
   Plate Pipeline, and blanks every staging credential. It also turns on the usage
   counter (`USAGE_COUNTER_FILE`, `NEXT_PUBLIC_USAGE_COUNTER`). The counter is off
   unless that variable is set, and production never sets it.
3. Run `scripts/live-usage/measure.ts`. It refuses to start unless the project is a
   `demo-` project on the emulators. It:
   - creates an owner account in the Auth emulator and a worker token for the local
     pipeline scope,
   - signs in with headless Chromium, opens `/states/AK` and the Plate Pipeline drawer,
     and leaves both open for the whole run,
   - starts a scripted worker that uses the real worker loop and API but returns fixed
     tags and descriptions after 4 seconds per job, so no model is called,
   - after 60 seconds, queues the first 40 Alaska fixture plates for tag and describe
     (skipped with `USAGE_IDLE=1`),
   - observes for 10 minutes, then subtracts the counter snapshot taken at the start
     from the one taken at the end and scales to one hour.

The run scenario was measured before and after the change. The idle scenario was added
afterwards, so its baseline ran the same scripts against commit `49f4497`, the last
commit before change signals.

The server counter (`lib/dev/usage-counter.ts`) counts requests per route and
Firestore operations per collection: document reads, query results and writes. It
wraps the server's Firestore client, so it counts everything the API and workflow
steps read through it. The browser side counts its own requests and its listener
snapshots.

```sh
# Emulators (Java 21 on PATH). The repo's firebase.json has no Auth emulator, so use a
# copy that adds one; serve.sh expects Firestore on 8185 and Auth on 9185 unless
# FIRESTORE_PORT and AUTH_PORT say otherwise.
npx firebase-tools emulators:start --config <config> --only firestore,auth \
  --project demo-plate-curator

# The app:
USAGE_DIR=<scratch> LOCAL_PIPELINE_SCOPE=usage220 scripts/live-usage/serve.sh

# The scenario. Playwright is not a dependency, so point PLAYWRIGHT_MODULE at an install.
GCP_PROJECT_ID=demo-plate-curator \
  FIRESTORE_EMULATOR_HOST=localhost:8185 FIREBASE_AUTH_EMULATOR_HOST=localhost:9185 \
  LOCAL_PIPELINE_SCOPE=usage220 USAGE_COUNTER_FILE=<scratch>/usage-counts.json \
  USAGE_LABEL=after USAGE_OUTPUT=docs/live-updates PLAYWRIGHT_MODULE=<playwright> \
  node --conditions=react-server --import tsx scripts/live-usage/measure.ts
```

Optional settings: `USAGE_MINUTES` (10), `USAGE_RUN_AT_SECONDS` (60), `USAGE_JOB_MS`
(4000), `USAGE_IDLE` (`1` queues no run) and `USAGE_BASE_URL`
(`http://localhost:3315`). The idle runs used `USAGE_MINUTES=5 USAGE_IDLE=1`. Start
each run from fresh emulators and a fresh dev server, because jobs left over from an
earlier run change what the worker claims.

The raw results are in `docs/live-updates/`: `before.json` and `after.json` for the
run, `idle-before.json` and `idle-after.json` for idle, `after-first-attempt.json` for
the run that found the two problems above, and `after-grace.json` for the run with the
10-second wake grace that the ledger replaced. Requests in that run matched the final
one exactly; it had about 2,700 fewer document reads and 1,400 fewer writes an hour,
the ledger's cost.

### Limits of the measurement

- A run of 40 plates with two stages does not finish in 10 minutes at 4 seconds per
  job. Both runs report results the whole time, which is the busy case.
- The idle runs start from empty emulators, so the pipeline list has no runs to read.
  Each list request reads the listed runs and their jobs, so with real history the
  idle reads before the change are higher than shown here.
- The research database client is not wrapped by the counter, so research reads are
  not in these numbers. The research panel lives on the plate page, which neither run
  opened.
- React Strict Mode mounts effects twice in development, so each page asks for a live
  grant twice. Production asks once.
- The scenario covers the Dashboard and drawer. Publish and research status use the
  same mechanism and are covered by tests, not by this measurement.

## What replaced polling

The server bumps a signal document after it commits a change. Browsers listen to that
document and refetch their own data. The API responses stay the source of truth; a
signal carries only a revision number.

| Topic | Bumped when | Listeners |
| --- | --- | --- |
| `pipeline` | a jobs transaction writes a job, run, draft batch or enhanced image; a worker's visible capabilities change | pipeline queue and run detail, plate image previews, Publish eligibility |
| `gateway` | a jobs transaction writes a hosted (Gateway) job | Gateway runs |
| `research` | a research job is written | research job status |
| `publish` | the Publish lock is claimed or released, a workflow is linked to an accepted publish request, the Catalog pointer advances, or the publish control changes | Batch run status, publish control, Publish eligibility |

Signal documents live at `curatorLive/{envKey}/batchRevisions/topic:<topic>`, beside
the Batch revision signals. The existing grant-gated rule for that collection covers
them, so no Firestore rule change is needed in staging. The staging rule already
includes that path (License-Plate-Game, #227).

### Server

- `signalChange` (`lib/live/change-signals.ts`) runs after the transaction commits and
  returns at once: the write runs in the background, so a publish lease renewal, a
  worker's claim or report reply, or a workflow wake never waits for it. On Vercel,
  `waitUntil` keeps the function alive until the write settles, at most 10 seconds per
  write. It is best effort: a failed or late bump is logged and never fails the caller.
- Bumps for one topic coalesce: one write in flight and at most one queued, however
  many changes arrive meanwhile.
- Worker heartbeats bump only when the dashboard would show something different: a
  new worker, different availability, or a worker returning after it went stale.
  Routine heartbeats do not.
- Workflow wakes go through a ledger stored on the run (`lib/jobs/wake-ledger.ts`),
  one entry per job transition: run, attempt, step, job, state, claim and time. The
  claim, report and fail routes wake right after their change; the pipeline list
  wakes as a watchdog. Whoever claims an entry sends the wake and records it as
  delivered or failed; the others skip it while it is delivered or being sent (held
  for 15 seconds). A failed wake can be taken over by the next caller at once, and
  the server also tries it again after 1 and 5 seconds without waiting for a request,
  stopping if the job has moved on.

### Browser

`lib/client/live-hub.ts` and `useLiveRefresh` in `lib/client/live-signal.tsx`:

- One listener per topic per tab, shared by every view in the tab, with one live
  grant from `POST /api/live-access`, renewed a minute before it expires.
- The tab refreshes at most once per 2 seconds. Signals and polls mark views as owing
  a refresh; a round runs at once if the tab has not refreshed in the last 2 seconds,
  otherwise once at the end of the window. Views that read the same API request (the
  same SWR key) refetch it once per round.
- The first snapshot after attaching causes one refresh, because a change can land
  between a view's first fetch and its listener attaching. A view that subscribes
  after the tab's listener already saw that snapshot gets one catch-up read of its
  own.
- A hidden tab detaches its listeners, cancels any queued round and stops renewing
  its grant. Refreshes owed while hidden stay marked. When the tab becomes visible it
  replaces a grant close to expiry, listens again, and refreshes once if anything was
  owed or a revision moved while it was hidden.
- If a listener fails, an expired grant is renewed once. Any other failure, or a
  second one, puts the topic in fallback and the drawer shows "Live updates
  unavailable". Each view then polls on one schedule, the shorter of 30 seconds and
  its own safety refresh, and gets its normal safety refresh back when the listener
  recovers.
- Some views keep a slow safety refresh while visible, for state that changes without
  a Firestore write:

| View | Safety refresh | Why |
| --- | --- | --- |
| Pipeline queue, Gateway runs | 60 s | a worker going stale is a matter of time, not a write |
| Publish eligibility, while pipeline work runs or the Publish lock is held | 60 s | eligibility follows the same worker and lock state |
| Plate image preview | 60 s | covers a lost signal for a finished enhancement |
| Research job status | 60 s | the server marks a job past its deadline only when it is read |
| Batch run status, from a publish request until the run finishes | 5 s | Vercel Workflow run status is not a Firestore write |
| Publish control | 5 min | the control is shared by every environment, but signals are per environment |

Publish views listen in every state, not only while work is in flight, so a publish
or pipeline run started in another tab reaches an idle view.

### Not changed

- Review page polling (`useBatches` with a 5 s interval in the Review workspace)
  belongs to #216 and #224.
- The Batch tag-run hook (`use-tag-run`) still polls while a Batch tag run is
  active. It was outside the brief's list.
