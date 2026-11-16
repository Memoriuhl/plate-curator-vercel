# Screens

Components only make sense in context, so every screen exists as a complete view; full-page renders at 1440px are in `docs/design/screens/`. Each row of the canvas carries a note on how it is built: what is server-rendered, what updates live, what writes, and what waits durably.

| Screen | What it is for | Built from |
|---|---|---|
| Dashboard | Group, order and check one state's plates in place | WorkspaceTabs, RegionPill, FilterChip, FamilyCard, StatusIcon, RarityMark, Avatar |
| Dashboard, pipeline running | The queue and the one-at-a-time banner | Button, Avatar, the run banner |
| Run pipeline menu | Scope, stages and each stage's options | FilterChip, switches, Button |
| Plate page | Manual edits: image, rarity, tags, story, family | Button, StatusIcon, RarityMark, Avatar, PlateRow |
| Replace image | Pick, dismiss and crop suggested images | Button, Image Cropper |
| Inbox | Triage Discover's candidates per state | PlateRow, FilterChip, Avatar |
| Owner review | States, then plates, then every field before and after | PlateRow, Avatar, Button |
| Publish | The last look: every change, checks and `v41 → v42` | PlateRow, hover card, Button |
| Publish warning | Type the version to push to players | PublishWarning |
| Region picker | Switch the whole workspace to another region | RegionPill |

When a screen needs something the components don't cover, add it here first, then as a component card with its code mapping.
