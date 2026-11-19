'use client'

import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import {
  NEEDS_WORK_CHECKS,
  parseShow,
  serializeShow,
  type FilterCounts,
} from './family-data'
import {
  useBatch,
  useSharedDraftId,
  useWorkspaceBatch,
} from '@/lib/client/hooks'
import { Toggle } from '@/components/ui/toggle'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { CHECK_META, StatusIcon } from '@/components/plate/status-icon'

/**
 * Resolve the active batch before rendering the jurisdiction filters and group
 * selection.
 */
export function FilterBar({
  counts,
  code,
  resolveGroup,
  onSelectGroup,
}: {
  counts: FilterCounts
  code: string
  resolveGroup?(key: string): string[]
  onSelectGroup?(key: string, ids: string[]): void
}) {
  const workspace = useWorkspaceBatch()
  const draftId = useSharedDraftId()
  const draft = useBatch(workspace.mode === 'personal' ? draftId : null, {
    reuse: true,
  })
  const batch =
    workspace.mode === 'selected'
      ? workspace.detail?.batch
      : draft.data?.batch
  const changedCount = new Set(
    batch?.plateIds.filter((id) => id.startsWith(code + '.')) ?? []
  ).size
  return (
    <FilterBarControls
      counts={counts}
      changedCount={changedCount}
      resolveGroup={resolveGroup}
      onSelectGroup={onSelectGroup}
    />
  )
}

/**
 * Show status and needs-work filters and reflect the chosen values in the current URL.
 */
export function FilterBarControls({
  counts,
  changedCount,
  resolveGroup,
  onSelectGroup,
}: {
  counts: FilterCounts
  changedCount: number
  resolveGroup?(key: string): string[]
  onSelectGroup?(key: string, ids: string[]): void
}) {
  const params = useSearchParams()
  const router = useRouter()
  const pathname = usePathname()
  const filters = [
    { key: 'all', label: 'All plates', count: counts.all },
    { key: 'changed', label: 'Unpublished changes', count: changedCount },
    ...NEEDS_WORK_CHECKS.map(({ key, label, checkKey }) => ({
      key,
      label,
      icon: CHECK_META[checkKey].icon,
      count: counts.groups[key].total,
      detail:
        key === 'standardPlate'
          ? 'States with missing or multiple Standards, or a Standard that is not the first plate'
          : `${counts.groups[key].missing} missing, ${counts.groups[key].weak} weak`,
    })),
  ]
  const active = parseShow(params.get('show'))
  /** Switch one filter on or off; filters combine, and All plates clears them. */
  function toggle(key: string) {
    const keys =
      key === 'all'
        ? []
        : active.includes(key)
          ? active.filter((item) => item !== key)
          : [...active, key]
    const next = new URLSearchParams(params)
    next.set('show', serializeShow(keys))
    router.replace(`${pathname}?${next}`, { scroll: false })
  }
  return (
    <div className="filter-bar">
      <div
        className="filter-chips"
        role="group"
        aria-label="Filter plates"
        title="Plates must match every filter that is on"
      >
        {filters.map((filter, index) => (
          <span className="filter-item" key={filter.key}>
            {index === 2 ? (
              <span className="needs-work">Needs work</span>
            ) : null}
            <Tooltip>
              <TooltipTrigger asChild>
                <Toggle
                  className="aria-pressed:bg-primary aria-pressed:text-primary-foreground"
                  count={filter.count}
                  onClick={(event) => {
                    if (
                      event.shiftKey &&
                      'detail' in filter &&
                      (!filter.count || (onSelectGroup && resolveGroup))
                    ) {
                      event.preventDefault()
                      if (!filter.count || !onSelectGroup || !resolveGroup)
                        return
                      const ids = resolveGroup(filter.key)
                      if (ids.length) onSelectGroup(filter.key, ids)
                    }
                  }}
                  pressed={
                    filter.key === 'all'
                      ? !active.length
                      : active.includes(filter.key)
                  }
                  onPressedChange={() => toggle(filter.key)}
                >
                  {'icon' in filter ? <filter.icon aria-hidden="true" /> : null}
                  {filter.label}
                </Toggle>
              </TooltipTrigger>
              <TooltipContent>
                {'detail' in filter ? filter.detail : filter.label}
                {onSelectGroup &&
                resolveGroup &&
                filter.count > 0 &&
                'detail' in filter
                  ? '; Shift-click to select group'
                  : ''}
              </TooltipContent>
            </Tooltip>
          </span>
        ))}
      </div>
      <div
        className="status-legend"
        role="group"
        aria-label="Check status legend"
      >
        {(['good', 'weak', 'missing'] as const).map((status) => (
          <span key={status} className="inline-flex items-center">
            <StatusIcon
              checkKey="description"
              check={{ status, value: status }}
            />
            {status}
          </span>
        ))}
      </div>
    </div>
  )
}
