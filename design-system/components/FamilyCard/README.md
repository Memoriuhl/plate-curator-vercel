# FamilyCard

A Template family on the Dashboard: a floating `card` with the order handle, the template's 140×70 thumbnail, its name with the id under it, ★ for the Standard plate, the seven checks and the people involved. Variant rows sit below, followed by the grouping note.

- No border unless selected (2px `primary`).
- Dropping between cards reorders; dropping onto a card merges, with Undo.
- Keyboard: Space picks a card up and the arrow keys move it.

Code: `components/plate/family-card.tsx`. Drag behaviour comes from UI SDK (`createReorder`, `createTransfer`, `createAutoScroll`, `createUndoStack`); shadcn supplies only markup.
