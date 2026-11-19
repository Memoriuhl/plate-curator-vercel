# Hosted Tag benchmark, November 18, 2026

**Gemini 3.5 Flash Lite** was the only curated model to beat Gateway Gemma 4 26B’s **0.676 from the paid 16-slot run**. It scored **0.687 F1** at **$0.00112470 per plate** with **1.485 s p50**. The assessment’s **0.669** is from Gateway Gemma 4 26B’s free-tier 8-slot run. The new 16-slot Gemma lane scored 0.647.

## Results

| Gateway model | Micro F1 | p50 per plate (s) | Reported cost per plate | Lane wall time (s) |
| --- | ---: | ---: | ---: | ---: |
| `google/gemini-3.5-flash-lite` | 0.687 | 1.485 | $0.00112470 | 2.012 |
| `alibaba/qwen3.8-flash` | 0.662 | 28.321 | $0.00096940 | 86.394 |
| `google/gemma-4-31b-it` | 0.653 | 8.959 | $0.00027569 | 10.978 |
| `google/gemma-4-26b-a4b-it` | 0.647 | 2.717 | $0.00033366 | 3.064 |
| `google/gemini-3.8-flash` | 0.626 | 5.650 | $0.00405350 | 8.668 |
| `amazon/nova-2-lite` | 0.618 | 1.623 | $0.00082307 | 2.101 |
| `mistral/mistral-medium-3.5` | 0.601 | 1.410 | $0.00194170 | 1.516 |
| `openai/gpt-5.4-mini` | 0.596 | 1.337 | $0.00134610 | 1.728 |
| `anthropic/claude-haiku-5.5` | 0.584 | 3.579 | $0.00056359 | 4.797 |
| `openai/gpt-5.4-nano` | 0.521 | 1.672 | $0.00047375 | 2.117 |

All ten lanes completed 15 plates. Gateway returned the requested model for every response. There were no plate failures, retries, or rate-limit responses.

Gateway reported **$0.178577485** for 150 scored requests and **$0.012519235** for 10 preflights, for **$0.19109672 total** under the $1.00 ceiling. Each lane’s cost per plate excludes its preflight and includes all 15 scored plates.

## Method

The benchmark used the first 15 plates in [the frozen Tag fixture](../fixtures/tag-eval.json), in the same order as the paid Gemma baseline, from `AK.standard_gold` through `AK.pro_family_pro_choice`. Each lane used the same Tag prompt (`588565b1bfe4`), 320 × 160 images, temperature 0.1, 16 slots, and one attempt per plate. Each lane opened with one single-plate preflight outside the scored sample. Model fallback was disabled.

The harness ran directly against Gateway. Its p50 measures elapsed time from the start of the lane to a plate’s result. The original paid Gemma latency also includes Dashboard queue and settlement overhead.

```sh
npm run eval:run -- --backend hosted --concurrency 16 --plate-limit 15 \
  --max-requests 16 --max-attempts 1 --max-output-tokens 1024
```

Qwen reported up to 4,468 billed completion tokens with a requested 1,024-token limit. The run paused after that lane, reconciled the charges, and reserved more headroom before starting Nova and Mistral. Mistral ran with `reasoning_effort: none`. [Mistral reasoning parameters](https://docs.mistral.ai/inference/conversations/reasoning)

## Research measured tier

The Research picker’s measured tier will come from [the #218 hosted enrichment benchmark](research.md#measured-hosted-enrichment-test) on the combined release, using the frozen 40-plate v17 set and the agreed citation, cost, and runtime criteria.
