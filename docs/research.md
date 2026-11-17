# Research agent setup and operation

Tracking: [#170](https://github.com/Memoriuhl/plate-curator-vercel/issues/170).
The [approved design](superpowers/specs/2026-11-17-eve-research-design.md) defines the
desktop/Ollama and Vercel/Eve execution options.

## Where the files live

| Path | Purpose |
| --- | --- |
| `agent/instructions.md` | Research sequence, evidence rules, and completion criteria |
| `agent/agent.ts` | Explicit Gateway model, optional tools, model-call gate, and limits |
| `agent/channels/eve.ts` | Terminal/HTTP channel authentication |
| `agent/tools/` | Wikipedia, existing web search, page reading, and draft submission |
| `lib/research/` | Evidence, validation, budgets, persistent state, and research jobs |
| `worker/research-legacy.ts` | Calls the existing desktop story implementation |
| `worker/research-benchmark.ts` | Freezes inputs and drives comparisons |
| `fixtures/research-eval.json` | Draft comparison corpus and rubric |

Before editing agent-facing prompts or tool descriptions, invoke
`mattpocock-skills:writing-for-agents`, as Jonathan requested. Keep the runtime's
enforced limits in code and give the prompt clear steps and completion criteria.

## Talk to the agent locally

Run commands from this feature checkout. Install its pinned dependencies with
`npm ci`, then start the terminal interface:

```sh
npm run research:chat
```

This opens Eve's development terminal. `/login` configures a Vercel/AI Gateway
connection, `/new` starts another conversation, `/info` shows the resolved agent,
and `/exit` leaves the terminal. The existing desktop/Ollama pipeline remains the
application's desktop executor; this command is the Eve authoring interface.

Model calls stay disabled until the pilot's model and spend limit are authorized.
Once authorized, set `RESEARCH_ENABLE_MODEL_CALLS=true` in an ignored `.env.local`
or the executing process environment. The selected model is explicit in `agent.ts`;
the initial candidate is `openai/gpt-6.1-sol`, verified in the Gateway catalog.

For existing web search, configure `SERPER_API_KEY` and optionally `BRAVE_API_KEY`
on the executing host. Without keys, Wikipedia remains available and web search
reports its unavailable status. API keys belong in the environment or Eve's login
store, never in prompts, committed files, or benchmark artifacts.

Example conversation after the pilot is enabled:

> Research Arizona's Arizona Highways plate. Explain its purpose, suggest up to
> four useful fun facts, and show the source supporting each claim.

The terminal is conversational. A pipeline request instead asks for a structured
draft, which stays pending until a curator accepts fields through the application.

## Talk to the deployed agent

The Next.js integration mounts the agent at `/eve/v1/*` on the application domain.
Production access requires the research channel's verified Owner identity and
session ownership checks. During initial runtime setup it is deliberately closed
to production callers; the job/auth integration enables access after its tests pass.

After deployment and authentication are configured, connect using the configured
target and a fresh authenticated token:

```sh
npm run research:remote -- --url "$RESEARCH_EVE_URL" \
  -H "Authorization: Bearer $RESEARCH_FIREBASE_ID_TOKEN"
```

The token must belong to a current active Owner. A removed user loses access, and
an Owner cannot read another user's session by guessing its ID. An expired Firebase
token needs renewal. Deployment Protection may additionally require its bypass
header; it is separate from the agent's authentication.

Verify compiled runtime plumbing without a paid model call:

```sh
npm run research:build
```

The generated `.eve/` and `.output/` directories are ignored. `npm run build` builds
the Next.js application; the Vercel integration also registers the Eve service.

## Preserve the baseline

`npm run research:baseline` validates the draft corpus without contacting a model.
Freeze its inputs from an explicit catalog Snapshot:

```sh
npm run research:baseline -- --input snapshot.json \
  --output eval-results/research-baseline/manifest.json
```

This refuses missing plates and an existing output file. The draft corpus must be
reviewed and frozen before measured runs. Model and prompt identities, source text,
cache use, rejections, raw outputs, and known/missing costs belong with the results.
Raw artifacts under `eval-results/research-*` stay local and ignored.

## Current verification scope

The runtime has been compiled and its production health/auth boundaries checked
without model requests. Fixture tests verify retrieval, evidence boundaries,
desktop adaptation, and per-run budgets. Those checks establish plumbing; a real
staged run and the final benchmark establish model output quality. Deployment,
credentials, and real-run evidence are recorded separately in #170 as they occur.
