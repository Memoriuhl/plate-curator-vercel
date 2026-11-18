import { readFile } from 'node:fs/promises'
import { buildDashboard } from '../lib/catalog/dashboard-build'
import { plateImageUrl } from '../lib/catalog/image-url'
import type { Snapshot } from '../lib/catalog/types'

/**
 * Measure serialized dashboard and jurisdiction payloads against the cache size budget.
 */
async function main() {
  const [path, imageBase] = process.argv.slice(2)
  if (!path) throw new Error('Usage: npx tsx scripts/catalog-cache-sizes.ts <snapshot.json> [image-base]')
  const snapshot = JSON.parse(await readFile(path, 'utf8')) as Snapshot
  /** Measure JSON payload bytes using the same encoding as the snapshot cache. */
  const size = (value: unknown) => Buffer.byteLength(JSON.stringify(value), 'utf8')
  const entries = [...new Set(snapshot.plates.map(plate => plate.state))].map(code => {
    const plates = snapshot.plates.filter(plate => plate.state === code)
    return { code, plateCount: plates.length, bytes: size({ version: snapshot.version, plates }) }
  }).sort((a, b) => b.bytes - a.bytes)
  const summary = buildDashboard(snapshot, { stateOrder: {}, stateProgress: {} }, plate => plateImageUrl(plate, imageBase ?? null))
  const summaryBytes = size(summary)
  console.log(JSON.stringify({
    catalogVersion: snapshot.version,
    plateCount: snapshot.plates.length,
    summaryBytes,
    largestJurisdiction: entries[0] ?? null,
    jurisdictionCount: entries.length,
  }, null, 2))
  if (summaryBytes >= 2_000_000 || entries.some(entry => entry.bytes >= 2_000_000)) process.exitCode = 1
}

void main()
