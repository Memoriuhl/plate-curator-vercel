# Local image and grouping decisions

Image search returns up to five Commons raster candidates. Each carries its media URL, provenance page, attribution when available, measured dimensions and SHA-256. A person chooses the image before dependent vision stages continue. A draft image override pairs `imageUrl` with `sourceUrl`; the asset path stays intact. Publish rejects changed plates with an override until a managed upload exists.

Grouping uses the configured legacy DINOv2 implementation, MSER mask, colour signature and connected-component clustering on only the supplied scope. The CPU bridge imports pure helpers; it never invokes the legacy CLI, catalog writer or state-wide run. A local vision tiebreak can confirm one ambiguous cluster pair. Group proposals include every scoped member and its original Batch revision. Complete selected families are required; partial families are rejected, and state order never changes.

Connected runs use the existing job model and a persisted run projection. Image choice affects that projection, while explicit aggregate Apply changes the Batch. The shared multi-edit store commit makes grouping atomic under one Batch revision. Group context checks protect Standard, parent links, unaffected families and every member revision.

Standalone image and Group acceptance load a completed, same-scope job by ID. Direct PATCH cannot introduce an arbitrary image/provenance pair; the shared parser needs the server-loaded candidate. Connected-run jobs reject standalone acceptance and use the aggregate Apply path. Group creation reconstructs every plate from current Batch data and supplies its ordered Standard ID to the worker. In local mode, hosted tagging ignores review overrides; outside local mode it preserves the catalog image resolver behavior.

Identical capability reports from the same worker skip storage writes until one poll interval has elapsed. Changed availability or a replacement worker is recorded immediately. Capability menus use plain availability reasons; runtime setup details stay in operator preflight notes.

Persisted preview jobs are inspect-only. Acceptance checks the stored `previewOnly` flag and rejects conversion through request payloads. The UI hides Apply/Accept. To apply a result, rerun normally; normal runs still require explicit Apply.
