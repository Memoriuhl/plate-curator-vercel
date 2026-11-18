# Local pipeline concepts

- A search result is a candidate, not a Batch edit. `worker/find-image.ts` validates remote rasters and preserves provenance; `components/dashboard/specialized-suggestion.tsx` asks for an explicit choice.
- `image` is an asset path; `imageUrl` is a temporary curator override. `lib/publish/validation.ts` prevents an override from reaching a game reader that only understands assets.
- `worker/group-runtime.py` uses the legacy image embedding, optional foreground masking and colour signature. Embeddings describe layout; clustering proposes families. A three-plate pilot verifies plumbing and offers limited visual evidence, not catalog-wide quality.
- A Group result is a complete proposal with per-member revisions. `lib/review/group.ts` checks the context; `ReviewStore.commit` writes all edits or none. Batch revisions prevent interleaving accepted changes.
- Preview mode belongs to the stored job, not the accept request. Server guards enforce inspection even if a caller submits `previewOnly: false`; normal Apply requires a new normal run.
- Authenticated route handlers need a request boundary before runtime configuration is read. `app/api/research/models/route.ts` now awaits `connection()` like the existing tagging-model route; otherwise Next attempts env-free prerendering and reads Firebase configuration during build.
- A stored requested model is not proof of actual provider execution. Queue fixtures establish orchestration and source-backed Apply; the paired live trace must establish actual model, usage and charge. The application reservation and Gateway spend ceiling are separate checks.
