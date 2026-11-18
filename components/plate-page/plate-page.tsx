'use client'

import { useStandardConfirmation } from '@/components/plate/standard-confirmation'
import { useMemo, useRef, useState, type ReactNode } from 'react'
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
import { groupFamilies } from '@/components/dashboard/family-data'
import { SelectedBatchBar } from '@/components/dashboard/selected-batch-bar'
import { ResearchActions } from '@/components/research/research-actions'
import { PlateTagActions } from '@/components/dashboard/plate-tag-actions'
import {
  AlertDialog,
  AlertDialogTrigger,
  AlertDialogHeader,
  AlertDialogContent,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogCancel,
  AlertDialogAction,
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { RarityMark } from '@/components/plate/rarity-mark'
import { cn } from '@/components/utils'
import { localPipelineReason } from '@/lib/local-pipeline'
import type { EditableFields, StandardChange } from '@/lib/review/types'
import { StoryEditor } from './story-editor'
import {
  useDraftOverlay,
  useEditPlate,
} from '@/lib/client/hooks'
import type { PlateCardData } from '@/lib/catalog/dashboard-types'
import { Conflict, type Issue } from '@/components/plate/edit-conflict'
import { cardData } from './types'
import type { FamilyPlate, PlatePageProps } from './types'

const input =
  'w-full min-w-0 rounded-[var(--radius-md)] border-0 bg-[var(--fill)] px-3 py-2 text-[var(--ink)]'
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

function Parked({ children, reason }: { children: ReactNode; reason: string }) {
  return (
    <span title={localPipelineReason(reason)} className="inline-flex">
      <Button disabled variant="outline" size="sm">
        {children}
      </Button>
      <span className="sr-only">{localPipelineReason(reason)}</span>
    </span>
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

function DraftText({
  value,
  label,
  multiline,
  pending,
  save,
  plate,
}: {
  plate: PlateCardData
  value: string
  label: string
  multiline?: boolean
  pending: boolean
  save(value: string, target: PlateCardData): Promise<boolean>
}) {
  const [local, setLocal] = useState<{ value: string; plate: PlateCardData; base: string } | null>(null)
  const draft = local?.value ?? value
  const valid = !multiline || draft.length <= 2000
  async function commit() {
    if (valid && local && draft !== local.base && !pending) {
      if (await save(draft, local.plate)) setLocal(null)
    }
  }
  const props = {
    'aria-label': label,
    'aria-invalid': !valid,
    disabled: pending,
    className: input,
    value: draft,
    onChange: (
      event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>,
    ) => setLocal(previous => ({ value: event.target.value, plate: previous?.plate ?? plate, base: previous?.base ?? value })),
    onBlur: () => void commit(),
    onKeyDown: (event: React.KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); setLocal(null); return }
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
        'flex min-w-0 flex-1 items-center gap-3 rounded-[var(--radius-md)] px-3 py-2 hover:bg-[var(--fill)] focus-visible:bg-[var(--fill)]',
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
        {plate.templateRole === 'template' ? 'Template' : 'Variant'}
      </span>
    </Link>
  )
}

export function PlatePage(props: PlatePageProps) {
  const params = useSearchParams()
  const router = useRouter()
  const { mutate } = useSWRConfig()
  const { edit, pending } = useEditPlate()
  const standardConfirmation = useStandardConfirmation()
  const localPipeline = process.env.NEXT_PUBLIC_LOCAL_PIPELINE === '1'
  const detailCard = useMemo(() => [{ ...cardData(props.plate), ...(localPipeline ? {
    funFacts: props.plate.funFacts ?? [], readMore: props.plate.readMore ?? [], firstIssuedYear: props.plate.firstIssuedYear ?? null,
    sourceUrl: props.plate.sourceUrl, wikiUrl: props.plate.wikiUrl,
  } : {}) }], [props.plate, localPipeline])
  const cards = useMemo(() => props.plates.map(cardData), [props.plates])
  const [plate] = useDraftOverlay(detailCard)
  const plates = useDraftOverlay(cards)
  const [tag, setTag] = useState('')
  const [tagPlate, setTagPlate] = useState<PlateCardData | null>(null)
  const addTrigger = useRef<HTMLButtonElement | null>(null)
  const [addingTemplate, setAddingTemplate] = useState<PlateCardData | null>(null)
  const [filter, setFilter] = useState('')
  const [issue, setIssue] = useState<Issue | null>(null)
  const [status, setStatus] = useState('')
  const [draftReset, setDraftReset] = useState<Record<string, number>>({})
  const [resolving, setResolving] = useState(false)
  const blocked = pending || standardConfirmation.pending || resolving || issue?.result.error === 'stale_plate'
  const current = { ...plate, description: plate.checks.description.value }
  const family = plates.filter((member) =>
    current.templateFamily
      ? member.templateFamily === current.templateFamily
      : member.id === current.id,
  )
  const linkedPlateCount = plates.filter(member => member.id !== current.id && !member.deleted
    && (member.variantOfPlateId === current.id || current.templateRole === 'template' && member.templateRole !== 'template'
      && !!current.templateFamily && member.templateFamily === current.templateFamily)).length
  const deleteReason = current.isStandard ? 'Set another Standard plate first.'
    : linkedPlateCount > 0 ? `Move or detach its ${linkedPlateCount} linked plates first.` : null
  const others = useMemo(() => {
    const outside = plates.filter(member => current.templateFamily
      ? member.templateFamily !== current.templateFamily
      : member.id !== current.id)
    return [...outside.filter(member => member.templateRole !== 'template'), ...outside.filter(member => member.templateRole === 'template')]
  }, [plates, current.templateFamily, current.id])
  const linkedVariantCounts = useMemo(() => new Map(
    groupFamilies(plates).map(family => [family.template.id, family.variants.length]),
  ), [plates])
  const linkedVariantCount = addingTemplate ? linkedVariantCounts.get(addingTemplate.id) ?? 0 : 0
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
  for (const key of ['show', 'q', 'batch'])
    if (params.has(key)) query.set(key, params.get(key)!)
  const suffix = query.size ? `?${query}` : ''
  const stateHref = `/states/${plate.state}${suffix}`
  const plateHref = (id: string) => `/plates/${encodeURIComponent(id)}${suffix}`

  async function save(target: PlateCardData, fields: EditableFields, reviewed?: { batchId: string; baseRevision: string }, standard?: StandardChange) {
    setStatus('Saving to your batch…')
    try {
      const result = reviewed ? await edit(target, fields, standard ? { ...reviewed, standard } : reviewed) : standard ? await edit(target, fields, undefined, standard) : await edit(target, fields)
      if (result.ok) {
        setStatus('Saved to your batch')
        setIssue(null)
        return true
      } else {
        setStatus('Could not save')
        setIssue({ plate: target, fields, result, standard })
      }
    } catch {
      setStatus('Could not save. Check your connection and try again.')
    }
    return false
  }

  async function addToFamily(member: PlateCardData) {
    if (blocked || !current.templateFamily || (member.templateRole === 'template' && (linkedVariantCounts.get(member.id) ?? 0) > 0)) return
    await save(member, {
      templateFamily: current.templateFamily,
      templateRole: 'variant',
      ...(template ? { variantOfPlateId: template.id } : {}),
    })
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
      const result = issue.result
      if (useMine) {
        if (!result.currentRevision) throw new Error('Missing conflict revision')
        if (!await save(issue.plate, result.draft, { batchId: result.batchId, baseRevision: result.currentRevision }, issue.standard)) return
      } else {
        await mutate(`/api/batches/${result.batchId}`)
        setIssue(null)
        setStatus('Kept the saved value')
      }
      setDraftReset(previous => ({ ...previous, ...Object.fromEntries(Object.keys(issue.fields).map(field => [field, (previous[field] ?? 0) + 1])) }))
      if (Object.hasOwn(issue.fields, 'tags')) { setTag(''); setTagPlate(null) }
    } catch {
      setStatus('Could not refresh. Check your connection and try again.')
    } finally {
      setResolving(false)
    }
  }

  return (
    <div className="grid min-w-0 gap-4">
      <SelectedBatchBar />
      <AlertDialog open={addingTemplate !== null} onOpenChange={open => { if (!open) setAddingTemplate(null) }}>
        <AlertDialogContent onCloseAutoFocus={event => { event.preventDefault(); addTrigger.current?.focus() }}>
          <AlertDialogTitle>Add {addingTemplate?.displayName} to this family?</AlertDialogTitle>
          <AlertDialogDescription>
            It stops being a Template.
          </AlertDialogDescription>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction disabled={blocked || !current.templateFamily || linkedVariantCount > 0} onClick={() => { if (addingTemplate) void addToFamily(addingTemplate) }}>Add to family</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <header className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex flex-wrap items-center gap-3">
          <Link
            href={stateHref}
            aria-label={`Back to ${props.stateName}`}
            onClick={(event) => {
              if (props.fromState) {
                event.preventDefault()
                router.back()
              }
            }}
            className="label flex items-center gap-2"
          >
            <IoChevronBack />
            {plate.state}
          </Link>
          <h1 className={cn("page-title", current.deleted && "line-through opacity-60")}>{current.displayName}</h1>
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
                  className={cn("max-w-full object-contain", current.deleted && "opacity-60")}
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
              <Parked reason="No image upload or crop draft endpoint">Replace or crop</Parked>
            </div>
            {fieldIssue('deleted')}
            {!current.deleted && deleteReason ? <p id="delete-plate-reason" className="caption text-[var(--ink-2)]">{deleteReason}</p> : null}
            {current.deleted ? <Button variant="outline" disabled={blocked} onClick={() => void save(current, { deleted: false })}>Undo delete</Button> : (
              <AlertDialog>
                <AlertDialogTrigger asChild><Button variant="outline" className="text-[var(--danger)]" disabled={blocked || !!deleteReason} aria-describedby={deleteReason ? 'delete-plate-reason' : undefined}>Delete plate</Button></AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>Delete {current.displayName}?</AlertDialogTitle>
                    <AlertDialogDescription>It is removed from the game at the next Publish. You can undo until then.</AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>Cancel</AlertDialogCancel>
                    <AlertDialogAction className="bg-[var(--danger)] text-white" disabled={blocked || !!deleteReason} onClick={() => void save(current, { deleted: true })}>Delete</AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            )}
          </Card>
          <Card title="Rarity">
            <RarityMark />
            <p className="caption text-[var(--ink-2)]">
              Rarity is not available for this plate.
            </p>
            <Parked reason="Manual rarity is not an editable Batch field">Set by hand</Parked>
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
                  className="label inline-flex items-center gap-2 rounded-full bg-[var(--fill)] px-3 py-1 text-[var(--tag-ink)]"
                >
                  {value}
                  <button
                    aria-label={`Remove tag ${value}`}
                    disabled={blocked}
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
                disabled={blocked}
                onChange={(event) => { setTagPlate(previous => previous ?? current); setTag(event.target.value) }}
                className="w-28 min-w-0 bg-transparent text-sm"
                onKeyDown={(event) => {
                  if (event.key === 'Escape') { setTag(''); setTagPlate(null) }
                  if (event.key === 'Enter') {
                    event.preventDefault()
                    const value = tag.trim().toLowerCase()
                    const target = tagPlate ?? current
                    if (value && !target.tags.includes(value))
                      void save(target, { tags: [...target.tags, value] }).then(ok => { if (ok) { setTag(''); setTagPlate(null) } })
                    else { setTag(''); setTagPlate(null) }
                  }
                }}
              />
            </div>
            <PlateTagActions key={current.id} plate={current} />
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
                disabled={blocked || current.isStandard || current.templateRole !== 'template' || current.deleted}
                onClick={async () => {
                  const standard = await standardConfirmation.confirm(plates, current.id)
                  if (standard !== false) await save(current, { isStandard: true }, undefined, standard)
                }}
              >
                <IoStarOutline />
                Set as Standard
              </Button>
            </div>
            {standardConfirmation.dialog}
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
                      disabled={blocked}
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
                  key={`family-${draftReset.templateFamily ?? 0}`}
                  plate={current}
                  label="Template family"
                  value={current.templateFamily ?? ''}
                  pending={blocked}
                  save={(value, target) =>
                    save(target, { templateFamily: value.trim() })
                  }
                />
              </div>
            </div>
          </Card>
          <Card title="Story" icon={<IoDocumentTextOutline />}>
            {fieldIssue('description')}
            <DraftText
              key={`description-${draftReset.description ?? 0}`}
              plate={current}
              label="Description"
              multiline
              value={current.description ?? ''}
              pending={blocked}
              save={(value, target) => save(target, { description: value || null })}
            />
            {localPipeline ? <>
              {(['firstIssuedYear', 'funFacts', 'readMore', 'wikiUrl'] as const).map(field => <div key={field}>{fieldIssue(field)}</div>)}
              <StoryEditor key={`${current.id}-${current.revision}`} plate={current} pending={blocked} save={save} />
            </> : <>
            <label className="grid gap-2">
              <span className="label">First issued</span>
              <span title={localPipelineReason('First issued year is not an editable Batch field')}>
                <input
                  aria-label="First issued year"
                  className={cn(input, 'max-w-40')}
                  placeholder="Year"
                  disabled
                />
              </span>
              <span className="sr-only">{localPipelineReason('First issued year is not an editable Batch field')}</span>
            </label>
            <div className="flex items-center justify-between">
              <h3 className="label">Fun facts {current.funFacts?.length ?? 0} / 4</h3>
              <Parked reason="Fun facts are not editable Batch fields">
                <IoAdd />
                Add fact
              </Parked>
            </div>
            {current.funFacts?.length ? <ul className="grid gap-2">{current.funFacts.map((fact, index) => <li key={index} className="rounded-xl bg-[var(--fill)] p-3 text-sm">{fact.text} <a href={fact.sourceUrl} target="_blank" rel="noreferrer" className="underline">{fact.sourceTitle ?? 'Source'}</a></li>)}</ul> : <p className="rounded-xl bg-[var(--danger-tint)] p-3 text-sm text-[var(--danger)]">
              No fun facts yet. Each one cites a source link below; uncited
              facts never ship.
            </p>}
            <div className="flex items-center justify-between">
              <h3 className="label">Sources and read-more</h3>
              <Parked reason="Source links are not editable Batch fields">
                <IoAdd />
                Add link
              </Parked>
            </div>
            <div className="grid gap-2">
              {[...new Set([props.plate.sourceUrl, current.wikiUrl ?? props.plate.wikiUrl, ...(current.readMore ?? []).map(link => link.url)])]
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
            </>}
            <ResearchActions key={current.id} plate={current} />
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
              {filtered.slice(0, 100).map((member) => {
                const count = member.templateRole === 'template' ? linkedVariantCounts.get(member.id) ?? 0 : 0
                const reasonId = 'family-move-' + member.id
                return (
                  <div key={member.id} className="grid gap-2">
                    {fieldIssue('templateFamily', member.id)}
                    <div className="flex items-center">
                      <Member plate={member} href={plateHref(member.id)} />
                      <Button
                        aria-label={`Add ${member.displayName} to family`}
                        variant="ghost"
                        size="icon"
                        disabled={blocked || !current.templateFamily || count > 0}
                        aria-describedby={count > 0 ? reasonId : undefined}
                        onClick={event => {
                          if (member.templateRole === 'template') {
                            addTrigger.current = event.currentTarget
                            setAddingTemplate(member)
                          } else void addToFamily(member)
                        }}
                      >
                        <IoAdd />
                      </Button>
                    </div>
                    {count > 0 ? <p id={reasonId} className="caption px-3 text-[var(--ink-2)]">Move or detach its {count} {count === 1 ? 'Variant' : 'Variants'} first.</p> : null}
                  </div>
                )
              })}
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
