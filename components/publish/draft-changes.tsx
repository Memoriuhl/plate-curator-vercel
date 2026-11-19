'use client'

import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import Image from 'next/image'
import Link from 'next/link'
import { IoArrowForward, IoPersonOutline } from 'react-icons/io5'
import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover'
import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import { cn } from '@/components/utils'
import { CHANGE_ICONS } from '@/components/review/plate-change-icons'
import { DiffTable } from '@/components/review/diff'
import {
  PipelineFieldValue,
  pipelineFieldLabel,
} from '@/components/dashboard/pipeline-field-value'
import { usePlateDetail, type BatchDetail } from '@/lib/client/hooks'
import {
  changedFields,
  familyTemplateId,
  matchesPublishFilter,
  tagDelta,
  type PlateChange,
  type PublishFilter,
  type PublishPlate,
  type publishChanges,
} from '@/lib/review/plate-changes'
import type { Plate } from '@/lib/catalog/types'

type Entry = BatchDetail['plates'][number]
type Entries = ReadonlyMap<string, Entry>
type PublishState = ReturnType<typeof publishChanges>['states'][number]

/**
 * Open floating detail while the pointer or keyboard focus is on its trigger or on the
 * detail itself. A short close delay lets the pointer cross the gap between them.
 */
function HoverDetail({
  label,
  trigger,
  children,
  className,
  contentClassName,
  closeOnPress = false,
}: {
  label: string
  trigger: ReactNode
  children: ReactNode
  className?: string
  contentClassName?: string
  /** Put the detail away when the trigger is pressed, for a trigger that opens more. */
  closeOnPress?: boolean
}) {
  const [open, setOpen] = useState(false)
  const closeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined
  )
  useEffect(() => () => clearTimeout(closeTimer.current), [])

  /** Show the detail now and cancel a pending close. */
  function show() {
    clearTimeout(closeTimer.current)
    setOpen(true)
  }

  /** Close the detail unless the pointer reaches it first. */
  function hide() {
    clearTimeout(closeTimer.current)
    closeTimer.current = setTimeout(() => setOpen(false), 150)
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverAnchor asChild>
        <span
          className={cn('inline-flex', className)}
          onPointerEnter={show}
          onPointerLeave={hide}
          onFocus={show}
          onBlur={hide}
          onKeyDown={(event) => {
            if (event.key === 'Escape') setOpen(false)
          }}
          onClick={() => {
            if (!closeOnPress) return
            clearTimeout(closeTimer.current)
            setOpen(false)
          }}
        >
          {trigger}
        </span>
      </PopoverAnchor>
      <PopoverContent
        aria-label={label}
        side="bottom"
        align="start"
        collisionPadding={8}
        className={cn(
          'max-h-[min(70vh,560px)] w-80 gap-3 overflow-y-auto rounded-[var(--radius-lg)] bg-[var(--elevated)] p-3.5 text-foreground shadow-[var(--shadow-pop)]',
          contentClassName
        )}
        onPointerEnter={show}
        onPointerLeave={hide}
        onOpenAutoFocus={(event) => event.preventDefault()}
        onCloseAutoFocus={(event) => event.preventDefault()}
      >
        {children}
      </PopoverContent>
    </Popover>
  )
}

/** Show a value the change removes and the value it puts in its place. */
function BeforeAfter({
  before,
  after,
}: {
  before: ReactNode
  after: ReactNode
}) {
  return (
    <span className="flex flex-wrap items-center gap-1.5 text-[13px] leading-5 font-bold">
      <span className="rounded-md bg-[var(--danger-tint)] px-1.5 line-through decoration-[var(--danger)]">
        {before}
      </span>
      <IoArrowForward aria-label="to" className="size-3 shrink-0" />
      <span className="rounded-md bg-[var(--success-tint)] px-1.5">
        {after}
      </span>
    </span>
  )
}

/** Before and after values for each changed field of a group. */
function FieldValues({
  entry,
  fields,
}: {
  entry: Entry
  fields: readonly string[]
}) {
  return (
    <dl className="grid gap-2">
      {fields.map((field) => (
        <div key={field} className="grid gap-1">
          <dt className="caption text-[var(--ink-2)]">
            {pipelineFieldLabel(field)}
          </dt>
          <dd className="m-0">
            <BeforeAfter
              before={
                <PipelineFieldValue
                  field={field}
                  value={entry.baseline[field]}
                />
              }
              after={
                <PipelineFieldValue
                  field={field}
                  value={entry.proposed[field]}
                />
              }
            />
          </dd>
        </div>
      ))}
    </dl>
  )
}

/** A plate image in a fixed well, or a placeholder when it has none. */
function PlateImage({
  src,
  name,
  width,
  height,
  className,
}: {
  src?: string | null
  name: string
  width: number
  height: number
  className?: string
}) {
  return (
    <span
      className={cn(
        'flex shrink-0 items-center justify-center rounded-[var(--radius-md)] bg-[var(--fill)] p-1.5',
        className
      )}
    >
      {src ? (
        <Image
          src={src}
          alt={`${name} plate`}
          width={width}
          height={height}
          loading="lazy"
          unoptimized
          style={{ width, height }}
          className="object-contain"
        />
      ) : (
        <span className="caption text-[var(--ink-2)]">No image</span>
      )}
    </span>
  )
}

/**
 * One side of a family change: the family's template plate with its name above it.
 * Families are named after their template, which comes from the draft when the draft
 * touches it and from the catalog otherwise.
 */
function TemplatePlate({
  plate,
  side,
  entries,
}: {
  plate: Plate
  side: 'before' | 'after'
  entries: Entries
}) {
  const captionId = useId()
  const id = familyTemplateId(plate)
  const known = id ? entries.get(id) : undefined
  const lookup = usePlateDetail(id && !known ? id : null)
  const name = known
    ? (side === 'before' ? known.baseline : known.proposed).displayName
    : (lookup.data?.plate.displayName ??
      (id ? id : (plate.templateFamily ?? 'No family')))
  const src = known
    ? side === 'before'
      ? (known.beforeImageUrl ?? known.afterImageUrl)
      : (known.afterImageUrl ?? known.beforeImageUrl)
    : lookup.data?.plate.imageUrl
  return (
    <figure aria-labelledby={captionId} className="m-0 grid min-w-0 gap-1.5">
      <figcaption
        id={captionId}
        className={cn(
          'w-fit max-w-full rounded-md px-1.5 text-[13px] leading-5 font-bold',
          side === 'before'
            ? 'bg-[var(--danger-tint)] line-through decoration-[var(--danger)]'
            : 'bg-[var(--success-tint)]'
        )}
      >
        {name}
      </figcaption>
      {id ? (
        <PlateImage
          src={src}
          name={name}
          width={120}
          height={60}
          className="h-[72px] w-[132px]"
        />
      ) : (
        <span className="caption text-[var(--ink-2)]">No template</span>
      )}
    </figure>
  )
}

/** A family change: both template plates, then any role or Standard change. */
function FamilyChange({ entry, entries }: { entry: Entry; entries: Entries }) {
  const { baseline, proposed } = entry
  const moved =
    familyTemplateId(baseline) !== familyTemplateId(proposed) ||
    baseline.templateFamily !== proposed.templateFamily
  const rest = changedFields(entry, {
    key: 'family',
    label: 'Family',
    fields: ['templateRole', 'isStandard'],
  })
  return (
    <div className="grid gap-3">
      {moved && (
        <div className="flex items-start gap-2">
          <TemplatePlate plate={baseline} side="before" entries={entries} />
          <IoArrowForward
            aria-label="to"
            className="mt-9 size-4 shrink-0 text-[var(--ink-2)]"
          />
          <TemplatePlate plate={proposed} side="after" entries={entries} />
        </div>
      )}
      {rest.length > 0 && <FieldValues entry={entry} fields={rest} />}
    </div>
  )
}

/** Describe one kind of change on a plate. */
function ChangeDetail({
  entry,
  change,
  entries,
}: {
  entry: Entry
  change: PlateChange
  entries: Entries
}) {
  const { baseline, proposed, order } = entry
  if (change.key === 'tags') {
    const delta = tagDelta(baseline.tags, proposed.tags)
    return (
      <div className="grid gap-2">
        <p className="count text-[var(--ink-2)]">{`${delta.from} → ${delta.to} tags`}</p>
        <span className="flex flex-wrap gap-1.5">
          {delta.added.map((tag) => (
            <span
              key={`+${tag}`}
              className="rounded-[var(--radius-pill)] bg-[var(--success-tint)] px-2.5 py-0.5 text-xs font-extrabold"
            >
              {`+ ${tag}`}
            </span>
          ))}
          {delta.removed.map((tag) => (
            <span
              key={`-${tag}`}
              className="rounded-[var(--radius-pill)] bg-[var(--danger-tint)] px-2.5 py-0.5 text-xs font-extrabold line-through decoration-[var(--danger)]"
            >
              {`− ${tag}`}
            </span>
          ))}
        </span>
      </div>
    )
  }
  if (change.key === 'family')
    return <FamilyChange entry={entry} entries={entries} />
  if (change.key === 'order')
    return (
      <p className="count">
        {order
          ? `#${order.before + 1} → #${order.after + 1} of ${order.total}`
          : `#${(baseline.sortOrder ?? 0) + 1} → #${(proposed.sortOrder ?? 0) + 1}`}
      </p>
    )
  if (change.key === 'deleted')
    return <p className="body">Deleted at next Publish</p>
  if (change.key === 'restored')
    return <p className="body">Restored at next Publish</p>
  if (change.key === 'image')
    return (
      <div className="flex items-start gap-2">
        <figure className="m-0 grid gap-1">
          <figcaption className="caption text-[var(--ink-2)]">
            Before
          </figcaption>
          <PlateImage
            src={entry.beforeImageUrl}
            name={baseline.displayName}
            width={120}
            height={60}
          />
        </figure>
        <IoArrowForward aria-label="to" className="mt-8 size-4 shrink-0" />
        <figure className="m-0 grid gap-1">
          <figcaption className="caption text-[var(--ink-2)]">After</figcaption>
          <PlateImage
            src={entry.afterImageUrl}
            name={proposed.displayName}
            width={120}
            height={60}
          />
        </figure>
      </div>
    )
  return <FieldValues entry={entry} fields={changedFields(entry, change)} />
}

/** Who last saved a plate's change, in their player colour. */
function ChangeAuthor({
  edit,
  viewer,
}: {
  edit: NonNullable<Entry['edit']>
  viewer?: string
}) {
  const name = edit.authorName || 'a curator'
  const initial = edit.authorName?.trim().slice(0, 1).toUpperCase()
  return (
    <Avatar
      size="sm"
      player={edit.authorId === viewer ? 'you' : 'friend'}
      aria-label={`Changed by ${name}`}
      title={`Changed by ${name}`}
    >
      <AvatarFallback>
        {initial || <IoPersonOutline aria-hidden="true" />}
      </AvatarFallback>
    </Avatar>
  )
}

/** Every change on a plate in one card, shown while the plate is hovered. */
function PlateCard({
  plate,
  entries,
}: {
  plate: PublishPlate
  entries: Entries
}) {
  const { entry, changes } = plate
  const name = entry.proposed.displayName
  return (
    <>
      <PlateImage
        src={entry.afterImageUrl ?? entry.beforeImageUrl}
        name={name}
        width={240}
        height={120}
        className="p-2.5"
      />
      <p className="plate-name">{name}</p>
      {changes.map((change) => {
        const Icon = CHANGE_ICONS[change.key]
        return (
          <section
            key={change.key}
            className="grid gap-2 border-t border-[var(--hairline)] pt-2.5"
          >
            <p className="label flex items-center gap-1.5 text-[var(--ink-2)]">
              <Icon aria-hidden="true" className="size-4" />
              {change.label}
            </p>
            <ChangeDetail entry={entry} change={change} entries={entries} />
          </section>
        )
      })}
      <p className="caption text-[var(--ink-2)]">
        Click for the full before and after
      </p>
    </>
  )
}

/**
 * One changed plate: its image and name (hover for every change, click for the full
 * before and after), an icon per kind of change (hover for that change alone) and who
 * changed it.
 */
function PlateRow({
  plate,
  entries,
  batch,
  viewer,
}: {
  plate: PublishPlate
  entries: Entries
  batch: BatchDetail['batch']
  viewer?: string
}) {
  const { entry, changes, removed } = plate
  const [open, setOpen] = useState(false)
  const diffId = useId()
  const name = entry.proposed.displayName
  return (
    <li className="rounded-[var(--radius-md)] [content-visibility:auto] [contain-intrinsic-size:auto_56px]">
      <div className="flex min-h-14 items-center gap-2.5 rounded-[var(--radius-md)] px-2 py-1 hover:bg-[var(--fill)]">
        <HoverDetail
          label={`${name}: every change`}
          closeOnPress
          className="min-w-0 flex-1"
          contentClassName="w-[min(400px,calc(100vw-16px))]"
          trigger={
            <button
              type="button"
              aria-expanded={open}
              aria-controls={open ? diffId : undefined}
              onClick={() => setOpen((value) => !value)}
              className="flex min-w-0 flex-1 items-center gap-3 rounded-[10px] text-left focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
            >
              <PlateImage
                src={entry.afterImageUrl ?? entry.beforeImageUrl}
                name={name}
                width={84}
                height={42}
                className={cn('p-0', removed && 'opacity-60')}
              />
              <span className="grid min-w-0">
                <strong
                  className={cn(
                    'text-[15px] leading-5 font-extrabold',
                    removed && 'line-through opacity-60'
                  )}
                >
                  {name}
                </strong>
                <span className="id truncate text-[var(--ink-3)]">
                  {entry.baseline.id}
                </span>
              </span>
            </button>
          }
        >
          <PlateCard plate={plate} entries={entries} />
        </HoverDetail>
        <span className="flex shrink-0 items-center gap-0.5">
          {changes.map((change) => {
            const Icon = CHANGE_ICONS[change.key]
            return (
              <HoverDetail
                key={change.key}
                label={`${name}: ${change.label}`}
                trigger={
                  <button
                    type="button"
                    aria-label={`${change.label} changed`}
                    className="inline-flex size-8 items-center justify-center rounded-lg text-[var(--ink-2)] hover:bg-card hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
                  >
                    <Icon aria-hidden="true" className="size-[18px]" />
                  </button>
                }
              >
                <p className="label">{`${change.label} changed`}</p>
                <ChangeDetail entry={entry} change={change} entries={entries} />
              </HoverDetail>
            )
          })}
        </span>
        <span className="flex w-6 shrink-0 justify-center">
          {entry.edit && <ChangeAuthor edit={entry.edit} viewer={viewer} />}
        </span>
      </div>
      {open && (
        <div id={diffId} className="px-2 pt-1 pb-3">
          <DiffTable
            compact
            before={entry.baseline}
            after={entry.proposed}
            beforeImageUrl={entry.beforeImageUrl}
            afterImageUrl={entry.afterImageUrl}
            version={batch.baselineVersion}
            revision={batch.revision}
            positions={entry.order}
            order={batch.stateOrders?.[entry.baseline.state] ?? []}
          />
        </div>
      )}
    </li>
  )
}

/** Name how many plates in a state make each kind of change. */
function stateSummary(state: PublishState) {
  return (
    [
      state.edited && `${state.edited} edited`,
      state.moved && `${state.moved} moved`,
      state.removed && `${state.removed} removed`,
    ]
      .filter(Boolean)
      .join(' · ') || 'No changes'
  )
}

/** The draft's changed plates by state, narrowed by the filter and search text. */
export function DraftChanges({
  states,
  entries,
  batch,
  filter,
  query,
  viewer,
}: {
  states: PublishState[]
  entries: Entries
  batch: BatchDetail['batch']
  filter: PublishFilter
  query: string
  viewer?: string
}) {
  const shown = states
    .map((state) => ({
      state,
      plates: state.plates.filter((plate) =>
        matchesPublishFilter(plate, filter, query)
      ),
    }))
    .filter(({ plates }) => plates.length > 0)
  if (!shown.length)
    return (
      <p role="status" className="body text-[var(--ink-2)]">
        No changed plates match.
      </p>
    )
  return (
    <div className="grid gap-[var(--stack-gap)]">
      {shown.map(({ state, plates }) => (
        <section
          key={state.code}
          aria-label={`${state.name} changes`}
          className="grid gap-0.5"
        >
          <h2 className="flex flex-wrap items-center gap-x-2.5 gap-y-1 px-1 pb-1">
            <span className="section">{state.name}</span>
            <span className="label text-[var(--ink-2)]">
              {stateSummary(state)}
            </span>
            <Link
              className="label ml-auto underline"
              href={`/review?state=${encodeURIComponent(state.code)}`}
            >
              {`Review ${state.code}`}
            </Link>
          </h2>
          <ul className="m-0 grid list-none gap-0.5 p-0">
            {plates.map((plate) => (
              <PlateRow
                key={plate.entry.baseline.id}
                plate={plate}
                entries={entries}
                batch={batch}
                viewer={viewer}
              />
            ))}
          </ul>
        </section>
      ))}
    </div>
  )
}
