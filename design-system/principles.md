# Principles

Short rules for the cases the components don't cover. When two pull apart, the earlier one wins.

1. **What ships is what was reviewed.** Anything that reaches players goes through a Review batch, an approved revision and Publish. Every change has a before and after someone can read.
2. **Plates are the colour.** Chrome is quiet so the plate art reads. Meaning colours mark state; they are not decoration.
3. **Float, don't box.** Surfaces sit on the ground with no border. A border means selected, and nothing else.
4. **One fill, one job.** `primary` means act or selected. `success` means good. Never swap them, or a passed check starts to look like a button.
5. **State is shape and colour.** Weak adds a dot, missing is slashed, and a manual rarity is dashed. Never rely on colour alone.
6. **People, not labels.** Whoever is editing or changed something shows as their avatar, everywhere a change is mentioned.
7. **One screen, no truncation.** A state's work fits the viewport. Names wrap instead of cutting off; the full record is a hover away.
8. **Mark it, don't block it.** An incomplete plate is labelled incomplete and never gated. Only Publish has hard checks.
9. **Big actions say their consequence.** Publish is a full page and a typed confirmation, not a two-click dialog.
10. **Fast is a feature.** The page frame is server-rendered, and live data comes from listeners scoped to one state. Images have fixed sizes, long lists are virtualized, and heavy dialogs load on demand. Targets: Lighthouse performance 90 or better, CLS under 0.1, INP under 200 ms, and no console errors.
11. **Keyboard first, mouse welcome.** Every drag has a keyboard path (Space, then arrow keys). Every row action has a key, and focus always lands somewhere sensible after a row disappears.
