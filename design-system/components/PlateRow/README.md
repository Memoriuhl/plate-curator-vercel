# PlateRow

One plate in a list or table: thumbnail, name, id, then whatever the context needs (checks, a change chip, a flag, actions), with the avatar of whoever changed it. Rows have no border. Hover shows the plate's hover card; the selected row takes `fill` and focus takes a 2px `primary` inset. In the Inbox, Accept, Decline and Skip are icon buttons right after the content (A, D, S). Code: `components/plate/plate-row.tsx`; in the Inbox, UI SDK `createGridFocus` and `createSelection` drive focus and range selection.
