import { InlineSelect } from '@/components/ui/inline-select'
import type { StageOption } from './pipeline-stages'

export function PipelineOptionSelect({ label, choices, value, onChange }: {
  label: string
  choices: NonNullable<StageOption['choices']>
  value: string
  onChange(value: string): void
}) {
  if (choices.length < 2) {
    return <p className="caption">{label} · {choices[0]?.label ?? 'Unavailable'}</p>
  }
  return <div className="grid justify-items-start gap-1">
    <p className="caption">{label}</p>
    <InlineSelect label={label} options={choices} value={value} onChange={onChange} />
  </div>
}
