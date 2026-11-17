# Local pipeline concepts

- A search result is a candidate, not a Batch edit. `worker/find-image.ts` validates remote rasters and preserves provenance; `components/dashboard/specialized-suggestion.tsx` asks for an explicit choice.
- `image` is an asset path; `imageUrl` is a temporary curator override. `lib/publish/validation.ts` prevents an override from reaching a game reader that only understands assets.
- `worker/group-runtime.py` uses the legacy image embedding, optional foreground masking and colour signature. Embeddings describe layout; clustering proposes families. A three-plate pilot verifies plumbing and offers limited visual evidence, not catalog-wide quality.
- A Group result is a complete proposal with per-member revisions. `lib/review/group.ts` checks the context; `ReviewStore.commit` writes all edits or none. Batch revisions prevent interleaving accepted changes.
