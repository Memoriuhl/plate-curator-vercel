import type { ComponentProps } from 'react'

export function ModelSelect(props: Pick<ComponentProps<'select'>, 'aria-label' | 'value' | 'onChange' | 'children'>) {
  return <select {...props} className="h-[34px] w-fit min-w-0 max-w-full rounded-[var(--radius-pill)] bg-muted px-3 text-sm font-extrabold text-foreground" />
}
