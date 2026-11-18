import type { StageOption } from './pipeline-stages'

export function PipelineOptionSelect({ label, choices, value, onChange, disabled, unavailableReason }: {
  label: string
  choices: NonNullable<StageOption['choices']>
  value: string
  onChange(value: string): void
  disabled: boolean
  unavailableReason?: string
}) {
  if (choices.length < 2) {
    return <p className="caption pl-7">{label} · {choices[0]?.label ?? unavailableReason ?? 'Unavailable'}</p>
  }
  return <label className="caption flex items-center gap-2 pl-7">
    {label}
    <select value={value} disabled={disabled} onChange={event => onChange(event.target.value)} className="rounded-[var(--radius-sm)] bg-[var(--card)] p-2">
      {choices.map(choice => <option key={choice.value} value={choice.value} disabled={!!choice.disabledReason}>{choice.label}{choice.disabledReason ? ` · ${choice.disabledReason}` : ''}</option>)}
    </select>
  </label>
}
