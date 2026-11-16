'use client'

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../ui/select'

export function RegionPill() {
  return (
    <Select defaultValue="US">
      <SelectTrigger aria-label="Region">
        <SelectValue>
          <span aria-hidden="true">{'\u{1F1FA}\u{1F1F8}'}</span> US
        </SelectValue>
      </SelectTrigger>
      <SelectContent position="popper">
        <SelectItem value="US">United States</SelectItem>
      </SelectContent>
    </Select>
  )
}
