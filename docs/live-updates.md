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
| `GET /api/local-pipeline/runs` | 1,343 | 1,396 | +4% |
| `GET /api/jobs/runs` | 1,164 | 60 | −95% |
| `POST /api/worker/claim` | 770 | 767 | 0% |
| `POST /.well-known/workflow/v1/flow` | 740 | 779 | +5% |
| `POST /api/worker/jobs/[id]/report` | 346 | 341 | −1% |
| `POST /api/local-pipeline/runs/selection` | 6 | 6 | 0% |
| `POST /api/worker/capabilities` | 0 | 6 | new |
| **All requests** | **4,370** | **3,354** | **−23%** |
| From the browser | 2,495 | 1,456 | −42% |

| Firestore per hour | Before | After | Change |
| --- | ---: | ---: | ---: |
| Document reads | 121,253 | 100,667 | −17% |
| Query results | 7,791 | 5,726 | −27% |
| Writes | 4,322 | 6,056 | +40% |

### Drawer open, no run

5 minutes of observation, scaled to one hour.

| Calls per hour | Before | After | Change |
| --- | ---: | ---: | ---: |
| `GET /api/jobs/runs` | 1,180 | 0 | −100% |
| `GET /api/local-pipeline/runs` | 1,168 | 12 | −99% |
| `POST /api/worker/claim` | 715 | 706 | −1% |
| **All requests** | **3,064** | **718** | **−77%** |
| From the browser | 2,336 | 12 | −99% |

| Firestore per hour | Before | After | Change |
| --- | ---: | ---: | ---: |
| Document reads | 2,599 | 1,423 | −45% |
| Query results | 6,580 | 742 | −89% |
| Writes | 715 | 718 | 0% |

### Reading the numbers

- Idle is where signals pay off. The browser went from 2,336 calls an hour to 12: one
  call in 5 minutes, the queue list's catch-up read after the first snapshot. With no
  run queued or running, the queue and Gateway lists refresh for safety every 10
  minutes, which a 5-minute run cannot show; in steady state that adds about 12 calls
  an hour. The other 706 calls an hour are the local worker asking for work every 5
  seconds; that is the worker's own loop, not the browser.
- During a run, every claim and every result changes a job, so the `pipeline` topic
  moves every couple of seconds (298 signals in 10 minutes). The queue list then
  refreshes about as often as it polled before (1,396 against 1,343 an hour): the
  2-second refresh limit plus request time sets the pace either way. An open run's
  results ride on the same request. The savings in a busy run come from Gateway runs
  (1,164 to 60 an hour, now on its own topic) and from fewer job queries. The run was
  measured before the idle lists' safety refresh moved to 10 minutes; with no Gateway
  run active, Gateway's 60 calls an hour now drop to about 6.
- Signals cost writes. During a run Firestore writes rise by about 1,700 an hour,
  almost all of them small signal writes, one per coalesced change, which the
  listening tab receives as reads. Workflow wakes write nothing. Document reads fall
  by about 20,600 an hour.
- The workflow's 90-second re-check costs about 40 workflow calls an hour per active
  run. This run had two active workflows, and workflow calls rose by 39 an hour (5%)
  over the baseline. Each hook still received two wakes, as before the change.
- Most document reads during a run come from the pipeline list re-reading every job
  of each listed run, about 66 job reads per request. Making that list cheaper, or
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
   left the workflow waiting. A per-transition wake ledger replaced the grace
   (`after-ledger.json`), and review found the ledger itself could leave a run
   waiting or hold a worker's reply. Now reads never wake a workflow: each request
   that commits a transition wakes it after its reply, and a waiting workflow
   re-checks its own state every 90 seconds (Server, below). The numbers above were
   measured with that.
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
the run that found the two problems above, `after-grace.json` for the run with the
10-second wake grace, and `after-ledger.json` and `idle-after-ledger.json` for the
runs with the wake ledger. The ledger cost about 1,500 writes and 4,900 document reads
an hour more than the final run.

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
  signal. It is best effort: a failed or late bump is logged and never fails the caller.
- Bumps for one topic coalesce: one write in flight and at most one queued, however
  many changes arrive meanwhile. The write in flight keeps its slot until Firestore
  answers, even past the 10 seconds, so a topic's writes go out in order.
- Worker heartbeats bump only when the dashboard would show something different: a
  new worker, different availability, or a worker returning after it went stale.
  Routine heartbeats do not.
- Workflow wakes come from the request that commits the change. The worker claim,
  report and fail routes, and the image choice, cancel and retry routes, wake the
  run's workflow after their reply (`wakeAfterReply` in `lib/server/local-queue.ts`,
  through `waitUntil`), so a slow wake never holds the reply. A send that is refused,
  or takes longer than 10 seconds, is sent again after 1, 5 and 30 seconds with no
  request needed. A hook that no longer exists is not retried. Reads never wake a
  workflow; the pipeline list only reconnects a run whose workflow is missing.
- While a run waits on a stage, its workflow re-checks its own persisted state every
  90 seconds (`workflows/local-pipeline.ts`), so a lost wake costs at most 90 seconds
  and needs no browser. The run keeps one timer, due at a claimed job's lease deadline
  or after 90 seconds, whichever is earlier. Wakes reuse it and a new one starts only
  after it fires, because a sleep cannot be cancelled and each one pending costs a
  workflow call when it elapses. A wake only re-reads the stage, so a duplicate wake
  is harmless. The re-check costs about 40 workflow calls an hour per active run. A run
  that finishes on a wake leaves its one timer pending; when it fires, the runtime
  refuses the event for the finished run and does not replay the workflow.

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
  unavailable". Views of one request then poll on one shared schedule, at the
  shortest interval any of them asks for (30 seconds, or a shorter safety refresh),
  however far apart they subscribed. They get their normal safety refresh back when
  the listener recovers.
- The queue list and an open run's results share one request per round: the run's
  results ride on the list request that selects the run, or turn the list's
  unselected request into one. Rounds can overlap, so each request takes a response
  only from a round newer than the last one it took, and a slow response never rolls
  a view back.
- Some views keep a slow safety refresh while visible, for state that changes without
  a Firestore write:

| View | Safety refresh | Why |
| --- | --- | --- |
| Pipeline queue, Gateway runs, while a run in that list is queued or running | 60 s | a worker going stale is a matter of time, not a write |
| Pipeline queue, Gateway runs, otherwise | 10 min | every change they show is signalled; this recovers a lost signal |
| Publish eligibility, while pipeline work runs or the Publish lock is held | 60 s | eligibility follows the same worker and lock state |
| Plate image preview | 60 s | covers a lost signal for a finished enhancement |
| Research job status | 60 s | the server marks a job past its deadline only when it is read |
| Batch run status, from a publish request until the run finishes | 5 s | Vercel Workflow run status is not a Firestore write |
| Publish control | 5 min | the control is shared by every environment, but signals are per environment |
| Publish eligibility and Batch run status, otherwise | 5 min | recovers a lost signal while idle |

Publish views listen in every state, not only while work is in flight, so a publish
or pipeline run started in another tab reaches an idle view.

### Not changed

- Review page polling (`useBatches` with a 5 s interval in the Review workspace)
  belongs to #216 and #224.
- The Batch tag-run hook (`use-tag-run`) still polls while a Batch tag run is
  active. It was outside the brief's list.
