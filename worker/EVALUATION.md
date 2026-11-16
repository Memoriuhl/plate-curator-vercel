# Tagging comparison

Set `GAME_REPO` to the image repository. Local defaults are `OLLAMA_URL=http://localhost:11434` and `MODEL=gemma4:12b`. Set `AI_GATEWAY_API_KEY` in the process environment for hosted runs; `AI_GATEWAY_MODEL` overrides `google/gemini-3.5-flash-lite`. Never put credentials in artifacts.

`npm run eval` preserves the original serial evaluation and its quality threshold exit status. `npm run eval:run -- --backend local --concurrency 4 --label trial --max-requests 300` runs one measured lane. Use `--backend hosted` for hosted inference. These measured commands record results without treating lower model agreement as a command failure.

`npm run eval:compare -- --label trial --max-requests 300` first checks one hosted Plate, then runs local concurrency 1 and 4 and hosted concurrency 1, 4, 8 and 16. The request cap covers preflight, all lanes, and every retry, including local adapter retries. Exhaustion writes a capped run and stops. An unsuccessful preflight stops before the matrix. `--preflight-only --backend hosted` checks the single Plate without starting the matrix.

Outputs live in a dated `eval-results/compare-*` folder: per-run JSON, `preflight.json`, `summary.csv`, and a self-contained `report.html`. Keep them uncommitted. Local worker terminal snapshots are private artifacts, read without interacting with the worker. The current production worker does not log successful claims, so unchanged terminal output cannot establish absence of contention.

`--max-rate-limit-ratio 0.2` stops new hosted requests and retries once observed HTTP 429 attempts exceed 20% of completed attempts. Already in-flight requests finish; unstarted Plates are recorded as stopped and excluded from scoring. The failing attempt remains scored and counted. The default leaves the existing retry behavior unchanged. `MODEL` selects the local model per command.

Latency is enqueue-to-completion, including bounded-pool queue wait. Per-Plate duration starts when its pool slot opens; inference sums actual request time. Successful completions determine throughput and latency percentiles. Scores use the existing micro scorer; failed Plates score empty suggestions, while capped Plates are excluded. Attempt records preserve failed-response status and any charges captured before parsing failure. Unknown costs remain unknown; known partial totals include a missing-cost count. Estimated costs use the model catalog prices in USD per token, fetched once for the command. Reported response charges have not been reconciled against billing. Local energy and hardware cost are unmeasured.

For the job worker, `MODEL_BACKEND=hosted` selects hosted inference and `CONCURRENCY=N` opens N independent claim loops (1–64). Defaults remain local and one job. Each job keeps its own lease and report retries. A failed job leaves its lease to expire while other lanes continue. A 401 stops new claims and lets in-flight work finish. Do not point experimental workers at a deployed API.
