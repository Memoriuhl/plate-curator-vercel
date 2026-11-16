# Button

Pill buttons in three weights, plus two consequence buttons.

- **Primary** (`primary` fill): the one main action in a region, such as Run pipeline or Start run.
- **Outline** (2px `primary` border): the secondary action beside it, such as Submit for review.
- **Ghost**: Cancel, Add link, and other low-weight actions.
- **Publish** (`info` fill): only for sending to players.
- **Push** (`danger` fill): only the final, type-to-confirm push.

Labels are sentence case at weight 800 and say exactly what happens. The pressed state is opacity only (0.8), as in the game. Icons are `icon-chrome` (16px) and go before the label. Heights are 40px, or 32px for small. Code: `components/ui/button.tsx` (shadcn Button, with variants `primary`, `outline`, `ghost`, `publish`, `push`).
