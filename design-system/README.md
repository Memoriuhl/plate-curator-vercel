# Plate Curator Interstate

The design system for the Plate Curator dashboard: the web tool where curators group, tag, order, review and publish the State Spotter plate catalog. It borrows the game's own "Interstate" language, which means the same fonts, colour tokens, pill buttons and Ionicons, so the tool and the game read as one product. The dashboard is dense and operational where the game is playful.

The system holds four things, in the order they were built:

1. **Tokens** (`tokens.json`): colour in light and dark, type, spacing, radius, elevation and icon sizes.
2. **Components**: one consolidated set. Each card names the exact code component it maps to, so design and code stay one-to-one.
3. **Principles** (the Principles section): short rules to decide the cases the components don't cover.
4. **Screens** (the Screens section): complete product views on the design canvas, because components mean little without examples in context.

## Where the values come from

Every colour, font and shape is taken from the game's theme tokens and its shared component kit. Nothing is invented except two dark-mode tints (`success-tint` and `danger-tint`, marked in their notes) and the decision to make `primary` the game's dark-mode elevated green rather than near-black ink.

## Foundations

### Colour

Colour does three separate jobs, and never trades between them.

- **Surfaces** (`ground`, `card`, `elevated`, `fill`): the page is `ground`, and everything you work with floats on it as `card`. Surfaces have no border and no shadow. Only things that sit above other surfaces (hover cards, menus) take `shadow-pop`.
- **Action** (`primary`, `on-primary`): every filled button, the active tab or chip, selection borders, checkboxes, the run banner and toasts. One fill means "you can act here" or "this is selected".
- **Meaning**: `success` is good, `warning` is weak, `danger` is missing or destructive, and `info` is headed to players. Each has a `-tint` for backgrounds. Meaning colours are never used for actions, apart from Publish (`info`) and the final Push (`danger`), where the meaning is the point.

Plates bring their own colour. Plate art is the most colourful thing on any screen, and the chrome stays quiet so the plates read.

Contrast: body text is at least 4.5:1 on its surface in both themes, and icons and large text are at least 3:1. Each token's note gives its measured ratio. Three dark-mode meaning colours (`success`, `danger`, `info`) fall under 4.5:1 on `card`, so in dark mode they are used only for icons and fills, never for small text.

### Type

Two families. **Overpass** (Google Fonts, 400–900 with italics) handles all interface text, as in the game. **Geist Mono** handles ids, family keys, revisions, versions and counts, so they line up and read as data.

- One `page-title` per page, black italic, as in the game's titles.
- Headings are sentence case, never tracked capitals.
- Plate names wrap to two lines. Never truncate a plate name, id or value someone needs to compare; the hover card shows the full record.

### Spacing, radius and density

- 4px base. Page gutters are 24px on desktop and at least 16px at phone width.
- **One stack gap.** Every component stacked on a page (review strip, search, state header with its batch actions, filter row, card grid) is separated by `--stack-gap` (16px), and cards in a grid sit the same 16px apart. Layout containers own that spacing with `gap`; components carry no outer margins, so the rhythm stays equal when one is added or removed.
- Inside a component, use the smaller steps: 8px between controls or chips in a row, 12px between a thumbnail and its text or between groups in a bar.
- Radius follows the game: pills for every control, `radius-lg` (20px) for floating surfaces, and `radius-xl` (28px) for dialogs.
- The dashboard is meant to fit a state on screen: 140×70px plate thumbnails on template cards, 84×42px on variant rows, and three family cards per row at 1440px.

## Iconography

- **Ionicons, outline set**, the same family as the game. No emoji in the interface, with one exception: the region pill's flag, which matches the game's country picker.
- **Two sizes.** `icon-chrome` is 16px with a 1.5 stroke, for buttons, tabs and menus. `icon-status` is 20px, the same glyphs scaled, for the seven plate checks. Hard caps and consistent angles.
- **State is shape plus colour, never colour alone.** A good check is the plain glyph in `success`. A weak check adds a dot, in `warning`. A missing check is slashed, in `danger`.
- **The seven checks**, always in this order: description (lines), fun facts (bulb), link (chain), tags (tag), family (branches), image (picture), rarity (diamond).
- **Rarity** is the diamond in its tier colour. Its outline means Estimated, filled means Observed, and dashed means Manual, so a hand-set tier never passes for real data.
- **People are avatars.** Whoever is editing or changed something appears as their initial in their player colour. An eye badge means editing now; a pencil badge means changed it in a batch.

## Components and their code

| Component | What it is | Code (Next.js) | Behaviour from |
|---|---|---|---|
| Button | Pill, three weights: primary, outline, ghost; plus Publish and Push | `components/ui/button.tsx` | shadcn Button |
| WorkspaceTabs | Centre-top switcher: Dashboard, Review, Strip Art | `components/app/workspace-tabs.tsx` | shadcn Tabs as links |
| RegionPill | Flag and code; opens the region list | `components/app/region-pill.tsx` | shadcn Select |
| FilterChip | Toggle chip with count; the health checks use it too | `components/ui/toggle.tsx` | shadcn Toggle |
| StatusIcon | One of the seven checks, in three states | `components/plate/status-icon.tsx` | none (static) |
| RarityMark | Tier diamond with Estimated, Observed or Manual | `components/plate/rarity-mark.tsx` | shadcn Popover for the override |
| Avatar | Person initial, editing and changed badges | `components/ui/avatar.tsx` | shadcn Avatar |
| FamilyCard | A Template with its variants, order handle, ★ and note | `components/plate/family-card.tsx` | UI SDK `createReorder`, `createTransfer`, `createAutoScroll`, `createUndoStack` |
| PlateRow | Thumbnail, name, id and checks in a list or table | `components/plate/plate-row.tsx` | UI SDK `createGridFocus`, `createSelection` in the Inbox |
| PublishWarning | The final, type-to-confirm alert | `components/publish/publish-warning.tsx` | shadcn AlertDialog |

One focus manager per widget: where a row says UI SDK, shadcn supplies only markup and style.

## Content

- Write from the curator's side: plates, families, batches, players. Avoid documents, rows and records.
- Buttons say exactly what happens: "Submit for review", "Approve revision 4", "Push v42 to players".
- Results say what happened, in the past tense: "Declined 'Introduced' as an info-box label".
- Every mention of a revision or change carries the person's avatar.
- Warnings name the consequence ("Every installed copy of State Spotter downloads it on its next launch") rather than saying "Are you sure?".

## Consuming this system in code

Map the tokens to shadcn's CSS variables in `app/globals.css`. Both themes come from `tokens.json`; do not paste values by hand.

| shadcn variable | Token |
|---|---|
| `--background` | `ground` |
| `--card`, `--popover` | `card`, `elevated` |
| `--foreground` | `ink` |
| `--muted`, `--muted-foreground` | `fill`, `ink-2` |
| `--border`, `--input` | `hairline`, `fill` |
| `--primary`, `--primary-foreground` | `primary`, `on-primary` |
| `--destructive` | `danger` |
| `--ring` | `primary` |
| `--radius` | `radius-md` |

Add `--success`, `--warning`, `--warning-ink`, `--info` and the `-tint`s as extra variables and Tailwind colours. Load Overpass and Geist Mono through `next/font/google`.
