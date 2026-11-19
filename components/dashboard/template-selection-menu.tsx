'use client'

import { ContextMenu } from 'radix-ui'
import type { ReactElement } from 'react'
import type { DragFamily } from './drop-targets'
import { useSelectedPlates } from './plate-selection'
import type { usePlateDrag } from './use-plate-drag'

/** Offer the current selection's move action on an eligible Template card. */
export function TemplateSelectionMenu({
  family,
  drag,
  children,
}: {
  family: DragFamily
  drag: ReturnType<typeof usePlateDrag>
  children: ReactElement
}) {
  const selection = useSelectedPlates()
  const canMove = drag.canMoveSelectionInto(family, selection)
  return (
    <ContextMenu.Root modal={false}>
      <ContextMenu.Trigger asChild disabled={!canMove}>
        {children}
      </ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Content
          aria-label="Template actions"
          collisionPadding={8}
          className="z-50 max-w-[calc(100vw-1rem)] rounded-[var(--radius-lg)] border border-[var(--hairline)] bg-popover p-1 text-popover-foreground shadow-lg"
        >
          <ContextMenu.Item
            disabled={!canMove}
            className="cursor-default rounded-[var(--radius-md)] px-3 py-2 text-sm outline-none select-none data-highlighted:bg-accent data-highlighted:text-accent-foreground"
            onSelect={() => drag.moveSelectionInto(family.template.id)}
          >
            Move selection ({selection.length}) to this Template
          </ContextMenu.Item>
        </ContextMenu.Content>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  )
}
