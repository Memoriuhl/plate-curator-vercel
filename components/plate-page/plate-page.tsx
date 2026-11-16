'use client'

import { useMemo, useState, type ReactNode } from 'react'
import { useSWRConfig } from 'swr'
import Image from 'next/image'
import Link from 'next/link'
import { useSearchParams, useRouter } from 'next/navigation'
import {
  IoAdd,
  IoChevronBack,
  IoChevronForward,
  IoClose,
  IoDocumentTextOutline,
  IoLinkOutline,
  IoPricetagOutline,
  IoStarOutline,
} from 'react-icons/io5'
import { Button } from '@/components/ui/button'
import { RarityMark } from '@/components/plate/rarity-mark'
import { cn } from '@/components/utils'
import type { EditableFields } from '@/lib/review/types'
import {
  useDraftOverlay,
  useEditPlate,
  type EditResult,
} from '@/lib/client/hooks'
import type { PlateCardData } from '@/lib/catalog/dashboard-types'
import { cardData } from './types'
import type { FamilyPlate, PlatePageProps } from './types'

const input =
  'w-full min-w-0 rounded-[var(--radius-md)] border-0 bg-[var(--fill)] px-3 py-2 text-[var(--ink)]'
const errors = {
  forbidden: "Only the batch's creator or an Owner can edit it.",
  superseded_revision: 'This batch has a newer revision. Reload and try again.',
  invalid_state: 'This batch is no longer open for editing.',
  not_found: 'This plate or batch could not be found.',
  stale_plate: 'Someone changed this while you were editing.',
}

function Card({
  title,
  children,
  icon,
}: {
  title?: string
  children: ReactNode
  icon?: ReactNode
}) {
  return (
    <section className="grid content-start gap-4 rounded-[var(--radius-lg)] bg-[var(--card)] p-[18px]">
      {title ? (
        <h2 className="section flex items-center gap-2">
          {icon}
          {title}
        </h2>
      ) : null}
      {children}
    </section>
  )
}

function Parked({ children }: { children: ReactNode }) {
  return (
    <span title="Coming soon" className="inline-flex">
      <Button disabled variant="outline" size="sm">
        {children}
      </Button>
      <span className="sr-only">Coming soon</span>
    </span>
  )
}

type Issue = {
  plate: PlateCardData
  fields: EditableFields
  result: Extract<EditResult, { ok: false }>
}

export function Conflict({
  issue,
  pending,
  onTheirs,
  onMine,
}: {
  issue: Issue
  pending: boolean
  onTheirs(): void
  onMine(): void
}) {
  if (issue.result.error !== 'stale_plate')
    return (
      <p role="alert" className="rounded-xl bg-[var(--danger-tint)] p-3">
        {errors[issue.result.error]}
      </p>
    )
  const result = issue.result
  return (
    <div
      role="alert"
      className="grid gap-3 rounded-xl border border-[var(--warning)] bg-[var(--warning-tint)] p-3 text-[var(--warning-ink)]"
    >
      <strong>Someone changed this while you were editing.</strong>
      {Object.keys(issue.fields).map((key) => {
        const field = key as keyof EditableFields
        return (
          <div key={key} className="grid gap-1 break-words">
            <span className="label">{key}</span>
            <p>Theirs: {format(result.current[field])}</p>
            <p>Yours: {format(result.draft[field])}</p>
          </div>
        )
      })}
      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          variant="outline"
          disabled={pending}
          onClick={onTheirs}
        >
          Keep theirs
        </Button>
        <Button size="sm" disabled={pending} onClick={onMine}>
          Use mine
        </Button>
      </div>
    </div>
  )
}

function fileName(url: string) {
  const name = url.split('/').at(-1)!.split('?')[0]
  try {
    return decodeURIComponent(name)
  } catch {
    return name
  }
}

function format(value: unknown) {
  if (value == null || value === '') return '(empty)'
  return Array.isArray(value) ? value.join(', ') : String(value)
}

function DraftText({
  value,
  label,
  multiline,
  pending,
  save,
}: {
  value: string
  label: string
  multiline?: boolean
  pending: boolean
  save(value: string): Promise<void>
}) {
  const [draft, setDraft] = useState(value)
  const [base, setBase] = useState(value)
  if (base !== value) {
    setBase(value)
    if (draft === base) setDraft(value)
  }
  const valid = !multiline || draft.length <= 2000
  async function commit() {
    if (valid && draft !== value && !pending) await save(draft)
  }
  const props = {
    'aria-label': label,
    'aria-invalid': !valid,
    className: input,
    value: draft,
    onChange: (
      event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>,
    ) => setDraft(event.target.value),
    onBlur: () => void commit(),
    onKeyDown: (event: React.KeyboardEvent) => {
      if (
        event.key === 'Enter' &&
        (!multiline || event.metaKey || event.ctrlKey)
      ) {
        event.preventDefault()
        void commit()
      }
    },
  }
  return (
    <label className="grid gap-2">
      <span className="label">{label}</span>
      {multiline ? <textarea {...props} rows={4} /> : <input {...props} />}
      {!valid ? (
        <span role="alert">Description must be 2000 characters or fewer.</span>
      ) : null}
    </label>
  )
}

function Member({
  plate,
  selected,
  href,
}: {
  plate: FamilyPlate
  selected?: boolean
  href: string
}) {
  return (
    <Link
      href={href}
      className={cn(
        'flex min-w-0 flex-1 items-center gap-3 rounded-xl p-2',
        selected && 'bg-[var(--fill)]',
      )}
    >
      <span className="flex h-9 w-[72px] shrink-0 items-center justify-center rounded bg-[var(--fill)]">
        {plate.imageUrl ? (
          <Image
            src={plate.imageUrl}
            alt=""
            width={72}
            height={36}
            unoptimized
            className="h-9 w-[72px] object-contain"
          />
        ) : null}
      </span>
      <span className="min-w-0 flex-1 break-words text-sm font-extrabold">
        {plate.displayName}
      </span>
      <span className="caption text-[var(--ink-2)]">
        {plate.templateRole === 'template' ? 'TEMPLATE' : 'variant'}
      </span>
    </Link>
  )
}

export function PlatePage(props: PlatePageProps) {
  const params = useSearchParams()
  const router = useRouter()
  const { mutate } = useSWRConfig()
  const { edit, pending } = useEditPlate()
  const detailCard = useMemo(() => [cardData(props.plate)], [props.plate])
  const cards = useMemo(() => props.plates.map(cardData), [props.plates])
  const [plate] = useDraftOverlay(detailCard)
  const plates = useDraftOverlay(cards)
  const [tag, setTag] = useState('')
  const [filter, setFilter] = useState('')
  const [issue, setIssue] = useState<Issue | null>(null)
  const [status, setStatus] = useState('')
  const [draftReset, setDraftReset] = useState(0)
  const [resolving, setResolving] = useState(false)
  const current = { ...plate, description: plate.checks.description.value }
  const family = plates.filter((member) =>
    current.templateFamily
      ? member.templateFamily === current.templateFamily
      : member.id === current.id,
  )
  const familyIds = new Set(family.map((member) => member.id))
  const others = plates.filter((member) => !familyIds.has(member.id))
  const filtered = others.filter((member) =>
    `${member.displayName} ${member.id}`
      .toLowerCase()
      .includes(filter.toLowerCase()),
  )
  const template = family.find((member) => member.templateRole === 'template')
  const templates = plates.filter(
    (member) => member.templateRole === 'template',
  )
  const templateIndex =
    templates.findIndex((member) => member.id === current.id) + 1
  const query = new URLSearchParams(props.returnQuery)
  for (const key of ['show', 'q'])
    if (params.has(key)) query.set(key, params.get(key)!)
  const suffix = query.size ? `?${query}` : ''
  const stateHref = `/states/${plate.state}${suffix}`
  const plateHref = (id: string) => `/plates/${encodeURIComponent(id)}${suffix}`

  async function save(target: PlateCardData, fields: EditableFields) {
    setStatus('Saving to your batch…')
    try {
      const result = await edit(target, fields)
      if (result.ok) {
        setStatus('Saved to your batch')
        setIssue(null)
      } else {
        setStatus('Could not save')
        setIssue({ plate: target, fields, result })
      }
    } catch {
      setStatus('Could not save. Check your connection and try again.')
    }
  }

  function fieldIssue(field: keyof EditableFields, id = current.id) {
    if (!issue || issue.plate.id !== id || !Object.hasOwn(issue.fields, field))
      return null
    return (
      <Conflict
        issue={issue}
        pending={pending || resolving}
        onTheirs={async () => {
          await resolveConflict(false)
        }}
        onMine={async () => {
          await resolveConflict(true)
        }}
      />
    )
  }

  async function resolveConflict(useMine: boolean) {
    if (!issue || issue.result.error !== 'stale_plate' || pending || resolving)
      return
    setResolving(true)
    try {
      await mutate(
        (key) => typeof key === 'string' && key.startsWith('/api/batches/'),
      )
      if (useMine) await save(issue.plate, issue.result.draft)
      else {
        setDraftReset((value) => value + 1)
        setIssue(null)
        setStatus('Kept the current value')
      }
    } catch {
      setStatus('Could not refresh. Check your connection and try again.')
    } finally {
      setResolving(false)
    }
  }

  return (
    <div className="grid min-w-0 gap-4">
      <header className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex flex-wrap items-center gap-3">
          <Link
            href={stateHref}
            onClick={(event) => {
              if (props.fromState) {
                event.preventDefault()
                router.back()
              }
            }}
            className="label flex items-center gap-2"
          >
            <IoChevronBack />
            {props.stateName}
          </Link>
          <h1 className="page-title">{current.displayName}</h1>
          <span className="id text-[var(--ink-2)]">
            {current.id} ·{' '}
            {current.templateRole === null
              ? 'role not set'
              : current.templateRole === 'variant'
                ? `variant of ${current.variantOfPlateId ?? template?.displayName ?? 'unassigned'}`
                : `template ${templateIndex} of ${templates.length}`}
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <p
            role="status"
            className={cn(
              'caption',
              status.startsWith('Could not')
                ? 'text-[var(--danger)]'
                : 'text-[var(--success)]',
            )}
          >
            {pending
              ? 'Saving to your batch…'
              : status || (plate.changedInBatch ? 'Saved to your batch' : '')}
          </p>
          {props.prevId ? (
            <Button asChild variant="outline" size="sm">
              <Link href={plateHref(props.prevId)}>
                <IoChevronBack />
                Prev
              </Link>
            </Button>
          ) : (
            <Button disabled variant="outline" size="sm">
              Prev
            </Button>
          )}
          {props.nextId ? (
            <Button asChild size="sm">
              <Link href={plateHref(props.nextId)}>
                Next
                <IoChevronForward />
              </Link>
            </Button>
          ) : (
            <Button disabled size="sm">
              Next
            </Button>
          )}
        </div>
      </header>
      <div className="grid min-w-0 items-start gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.48fr)_minmax(0,.9fr)]">
        <div className="grid min-w-0 gap-4">
          <Card>
            <div className="flex min-h-[200px] items-center justify-center overflow-hidden">
              {props.plate.imageUrl ? (
                <Image
                  src={props.plate.imageUrl}
                  width={props.plate.imageSize.width}
                  height={props.plate.imageSize.height}
                  alt={`${plate.displayName} plate`}
                  unoptimized
                  priority
                  className="max-w-full object-contain"
                />
              ) : (
                <p>No image available</p>
              )}
            </div>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="id break-all text-[var(--ink-2)]">
                {plate.imageUrl
                  ? fileName(plate.imageUrl)
                  : 'No source file'}{' '}
                · {props.plate.imageSize.width} px
              </p>
              <Parked>Replace or crop</Parked>
            </div>
          </Card>
          <Card title="Rarity">
            <RarityMark />
            <p className="caption text-[var(--ink-2)]">
              Rarity is not available for this plate.
            </p>
            <Parked>Set by hand</Parked>
          </Card>
          <Card
            title={`Tags ${current.tags.length}`}
            icon={<IoPricetagOutline />}
          >
            {fieldIssue('tags')}
            <div className="flex flex-wrap gap-2">
              {current.tags.map((value) => (
                <span
                  key={value}
                  className="label inline-flex items-center gap-2 rounded-full bg-[var(--fill)] px-3 py-1"
                >
                  {value}
                  <button
                    aria-label={`Remove tag ${value}`}
                    disabled={pending}
                    onClick={() =>
                      void save(current, {
                        tags: current.tags.filter((item) => item !== value),
                      })
                    }
                  >
                    <IoClose />
                  </button>
                </span>
              ))}
              <input
                aria-label="Add tag"
                placeholder="Add tag…"
                value={tag}
                disabled={pending}
                onChange={(event) => setTag(event.target.value)}
                className="w-28 min-w-0 bg-transparent text-sm"
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault()
                    const value = tag.trim().toLowerCase()
                    if (value && !current.tags.includes(value))
                      void save(current, { tags: [...current.tags, value] })
                    setTag('')
                  }
                }}
              />
            </div>
            <p className="caption text-[var(--ink-2)]">
              Tag suggestions come from the Tag stage in Run pipeline.
            </p>
          </Card>
        </div>
        <div className="grid min-w-0 gap-4">
          <Card>
            <div className="flex flex-wrap items-end gap-3">
              <label className="grid flex-1 gap-2">
                <span className="label">Display name</span>
                <input className={input} value={current.displayName} readOnly />
              </label>
              <Button
                variant="outline"
                aria-pressed={current.isStandard}
                disabled={pending}
                onClick={() =>
                  void save(current, { isStandard: !current.isStandard })
                }
              >
                <IoStarOutline />
                Set as Standard
              </Button>
            </div>
            {fieldIssue('isStandard')}
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="grid content-start gap-2">
                <span className="label">Role</span>
                {fieldIssue('templateRole')}
                <div
                  className="flex w-fit rounded-full bg-[var(--fill)] p-1"
                  role="group"
                  aria-label="Role"
                >
                  {(['template', 'variant'] as const).map((role) => (
                    <Button
                      key={role}
                      size="sm"
                      variant={
                        current.templateRole === role ? 'primary' : 'ghost'
                      }
                      aria-pressed={current.templateRole === role}
                      disabled={pending}
                      onClick={() => void save(current, { templateRole: role })}
                    >
                      {role === 'template' ? 'Template' : 'Variant'}
                    </Button>
                  ))}
                </div>
              </div>
              <div className="grid gap-2">
                {fieldIssue('templateFamily')}
                <DraftText
                  key={`family-${draftReset}`}
                  label="Template family"
                  value={current.templateFamily ?? ''}
                  pending={
                    pending ||
                    resolving ||
                    issue?.result.error === 'stale_plate'
                  }
                  save={(value) =>
                    save(current, { templateFamily: value.trim() })
                  }
                />
              </div>
            </div>
          </Card>
          <Card title="Story" icon={<IoDocumentTextOutline />}>
            {fieldIssue('description')}
            <DraftText
              key={`description-${draftReset}`}
              label="Description"
              multiline
              value={current.description ?? ''}
              pending={
                pending || resolving || issue?.result.error === 'stale_plate'
              }
              save={(value) => save(current, { description: value || null })}
            />
            <label className="grid gap-2">
              <span className="label">First issued</span>
              <span title="Coming soon">
                <input
                  aria-label="First issued year"
                  className={cn(input, 'max-w-40')}
                  placeholder="Year"
                  disabled
                />
              </span>
              <span className="sr-only">Coming soon</span>
            </label>
            <div className="flex items-center justify-between">
              <h3 className="label">Fun facts 0 / 4</h3>
              <Parked>
                <IoAdd />
                Add fact
              </Parked>
            </div>
            <p className="rounded-xl bg-[var(--danger-tint)] p-3 text-sm text-[var(--danger)]">
              No fun facts yet. Each one cites a source link below; uncited
              facts never ship.
            </p>
            <div className="flex items-center justify-between">
              <h3 className="label">Sources and read-more</h3>
              <Parked>
                <IoAdd />
                Add link
              </Parked>
            </div>
            <div className="grid gap-2">
              {[props.plate.sourceUrl, props.plate.wikiUrl]
                .filter((url): url is string => !!url)
                .map((url, index) => {
                  let domain = url
                  try {
                    domain = new URL(url).hostname
                  } catch {
                    return null
                  }
                  return (
                    <a
                      key={`${index}-${url}`}
                      href={url}
                      target="_blank"
                      rel="noreferrer"
                      className="flex flex-wrap items-center justify-between gap-2 rounded-xl bg-[var(--fill)] p-3 text-sm"
                    >
                      <span className="flex items-center gap-2">
                        <IoLinkOutline />
                        {index === 0 ? 'Source' : 'Read more'}
                      </span>
                      <span className="id break-all">{domain}</span>
                    </a>
                  )
                })}
            </div>
          </Card>
        </div>
        <Card title={`Family ${current.templateFamily ?? 'unassigned'}`}>
          {!template ? (
            <p className="caption text-[var(--ink-2)]">No template yet</p>
          ) : null}
          <div className="grid">
            {family.map((member) => (
              <Member
                key={member.id}
                plate={member}
                selected={member.id === current.id}
                href={plateHref(member.id)}
              />
            ))}
          </div>
          <div className="grid gap-3 border-t border-[var(--hairline)] pt-3">
            <h3 className="label">
              Other {props.stateName} plates{' '}
              <span className="count">{others.length}</span>
            </h3>
            <input
              aria-label="Filter other plates"
              placeholder="Filter"
              value={filter}
              onChange={(event) => setFilter(event.target.value)}
              className={input}
            />
            <div className="max-h-[580px] overflow-y-auto">
              {filtered.slice(0, 100).map((member) => (
                <div key={member.id} className="grid gap-2">
                  {fieldIssue('templateFamily', member.id)}
                  <div className="flex items-center">
                    <Member plate={member} href={plateHref(member.id)} />
                    <Button
                      aria-label={`Add ${member.displayName} to family`}
                      variant="ghost"
                      size="icon"
                      disabled={pending || !current.templateFamily}
                      onClick={() =>
                        void save(member, {
                          templateFamily: current.templateFamily!,
                          templateRole: 'variant',
                          ...(template
                            ? { variantOfPlateId: template.id }
                            : {}),
                        })
                      }
                    >
                      <IoAdd />
                    </Button>
                  </div>
                </div>
              ))}
            </div>
            {filtered.length > 100 ? (
              <p className="caption">Filter to see more</p>
            ) : null}
            {filtered.length === 0 ? (
              <p className="caption">No matching plates.</p>
            ) : null}
          </div>
        </Card>
      </div>
    </div>
  )
}
