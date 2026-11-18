import { InlineSelect } from '@/components/ui/inline-select'
import type { StageOption } from './pipeline-stages'

export function PipelineOptionSelect({ label, choices, value, onChange }: {
  label: string
  choices: NonNullable<StageOption['choices']>
  value: string
  onChange(value: string): void
}) {
  if (choices.length < 2) {
    const choice = choices[0]
    return <p className="caption flex items-center gap-2">
      {choice ? <choice.icon aria-hidden="true" className="size-4" /> : null}
      {label} · {choice?.label ?? 'Unavailable'}
    </p>
  }
  return <div className="grid justify-items-start gap-1">
    <p className="caption">{label}</p>
    <InlineSelect label={label} options={choices} value={value} onChange={onChange} />
  </div>
}
