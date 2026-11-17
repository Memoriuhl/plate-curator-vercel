import type { WorkerDeps } from '../run'
import { createTextStageHandler } from './text'
import { createColorStageHandler } from './colors'
import { findWikipediaLink } from './wiki'

export function createStageHandler(options: { url: string; readImage: (image: string) => Promise<string>; fetch?: typeof fetch; onRejected?: (reasons: string[]) => void }): NonNullable<WorkerDeps['suggestFields']> {
  const text = createTextStageHandler(options)
  const colors = createColorStageHandler(options)
  return input => input.stage === 'wiki-link' ? findWikipediaLink(input.plate, options.fetch) : input.stage === 'colors' ? colors(input) : text(input)
}
