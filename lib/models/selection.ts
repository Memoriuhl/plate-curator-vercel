import { z } from 'zod'
import type { HostedStep, ModelPrice } from './catalog'

export const MODEL_CAP_PRESETS = [0.002, 0.005, 0.01, 0.02] as const
export const DEFAULT_MODEL_CAP = 0.01
export const REASONING_OUTPUT_TOKENS_BOUND = 8_000
export const STANDARD_OUTPUT_TOKENS_BOUND = 1_000
export const gatewayModelId = /^[a-zA-Z0-9._-]+\/[a-zA-Z0-9._-]+$/

export const modelOptionsSchema = z.strictObject({
  capUsd: z.literal(MODEL_CAP_PRESETS).optional(),
  strict: z.boolean().optional(),
})

export const runModelOptionsSchema = z.strictObject({
  research: modelOptionsSchema.optional(),
  tag: modelOptionsSchema.optional(),
})

export type ModelOptions = z.infer<typeof modelOptionsSchema>
export type RunModelOptions = z.infer<typeof runModelOptionsSchema>
export type ModelPriceSnapshot = {
  price: ModelPrice
  /** Older runs did not store an output bound. */
  outputTokensBound?: number
}
type HostedModelSnapshot = ModelPriceSnapshot & { model: string }
export type HostedModelBinding = HostedModelSnapshot & {
  capUsd: number
  strict: boolean
  fallback?: HostedModelSnapshot
}
export type RunModelBindings = Partial<Record<HostedStep, HostedModelBinding>>

export type ModelCap = (typeof MODEL_CAP_PRESETS)[number]
export type PickerModel = {
  id: string
  label: string
  provider: string
  estimatedUsd: number
  measured?: {
    f1?: number
    fillRate?: number
    p50Seconds: number
    costPerPlate: number | null
    plates: number
  }
}
export type HostedModelCatalog = {
  curated: PickerModel[]
  searchable: PickerModel[]
  caps: ModelCap[]
  unavailable?: true
}

export function fitsModelCap(estimate: number, cap: number) {
  // Equivalent decimal prices can differ by a floating-point rounding bit.
  return estimate <= cap + Number.EPSILON * cap
}
