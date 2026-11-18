export const REGIONS = [
  { region: 'US', name: 'United States', flag: '🇺🇸' },
  { region: 'CA', name: 'Canada', flag: '🇨🇦' },
  { region: 'MX', name: 'Mexico', flag: '🇲🇽' },
  { region: 'EU', name: 'Europe', flag: '🇪🇺' },
] as const

export type RegionSummary = { region: string; firstCode: string; count: number }
export type JurisdictionRegion = { code: string; region: string }

/** Group available jurisdictions by region for the navigation picker. */
export function summarizeRegions(jurisdictions: JurisdictionRegion[]): RegionSummary[] {
  const regions = new Map<string, RegionSummary>()
  for (const { code, region } of jurisdictions) {
    const summary = regions.get(region)
    if (summary) summary.count++
    else regions.set(region, { region, firstCode: code, count: 1 })
  }
  return [...regions.values()]
}

/** Resolve the current region from the active jurisdiction or plate route. */
export function routeRegion(
  params: { code?: string | string[]; id?: string | string[] },
  pathname: string,
  jurisdictions: JurisdictionRegion[],
) {
  const code = typeof params.code === 'string'
    ? params.code
    : pathname.startsWith('/plates/') && typeof params.id === 'string'
      ? params.id.split('.')[0]
      : undefined
  return jurisdictions.find((jurisdiction) => jurisdiction.code === code)?.region ?? 'US'
}
