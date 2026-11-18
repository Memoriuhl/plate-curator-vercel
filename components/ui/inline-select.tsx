'use client'

import { DropdownMenu } from 'radix-ui'
import type { IconType } from 'react-icons'
import { IoChevronDown } from 'react-icons/io5'

export type InlineSelectChoice = { value: string; label: string; icon: IconType }

export function InlineSelect({ label, options, value, onChange }: {
  label: string
  options: readonly InlineSelectChoice[]
  value?: string
  onChange(value: string): void
}) {
  const selected = options.find(option => option.value === value)
  return (
    <DropdownMenu.Root modal={false}>
      <DropdownMenu.Trigger className="inline-select-trigger" type="button" aria-label={label}>
        <span className="inline-select-choice">
          {selected ? <selected.icon aria-hidden="true" /> : null}
          <span>{selected?.label ?? 'Choose an option'}</span>
        </span>
        <IoChevronDown aria-hidden="true" />
      </DropdownMenu.Trigger>
      <DropdownMenu.Content className="inline-select-menu" align="start" sideOffset={4} collisionPadding={12}>
        <DropdownMenu.RadioGroup value={value} onValueChange={onChange}>
          {options.map(option => (
            <DropdownMenu.RadioItem className="inline-select-option" key={option.value} value={option.value}>
              <span className="inline-select-choice">
                <option.icon aria-hidden="true" />
                <span>{option.label}</span>
              </span>
            </DropdownMenu.RadioItem>
          ))}
        </DropdownMenu.RadioGroup>
      </DropdownMenu.Content>
    </DropdownMenu.Root>
  )
}
