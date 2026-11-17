import { readFile, readdir, mkdir, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { ResearchInput, ResearchResult, ResearchDraft, EvidenceSource } from '../lib/research/types'
import type { LegacyOutcome } from './research-legacy'
type Saved = { input: ResearchInput & { split?: string }; durationMs?: number; raw?: LegacyOutcome; result?: ResearchResult; draft?: ResearchDraft; sources?: EvidenceSource[]; cost?: { usd: number | null; missing: number }; settled?: { costUsd?: number }; error?: string; skipped?: string }

type Row = { durationMs: number; description: boolean; facts: number; links: number; status: string; usd: number | null; missingCost: boolean }
export function summarizeResearch(rows: Row[]) {
  const times = rows.map(row => row.durationMs).sort((a, b) => a - b)
  const percentile = (p: number) => times[Math.max(0, Math.ceil(times.length * p) - 1)] ?? null
  return { plates: rows.length, descriptions: rows.filter(row => row.description).length, facts: rows.reduce((sum, row) => sum + row.facts, 0), fetchedLinks: rows.reduce((sum, row) => sum + row.links, 0), failures: rows.filter(row => ['failed', 'error', 'timeout'].includes(row.status)).length, statuses: Object.fromEntries([...new Set(rows.map(row => row.status))].map(status => [status, rows.filter(row => row.status === status).length])), p50Ms: percentile(0.5), p95Ms: percentile(0.95), knownUsd: rows.reduce((sum, row) => sum + (row.usd ?? 0), 0), missingCostPlates: rows.filter(row => row.missingCost).length, acceptedPlates: null, costPerAcceptedPlate: null }
}
const escape = (text: unknown) => String(text ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;')

async function main() {
  const baseline = JSON.parse(await readFile('eval-results/research-baseline/desktop-raw.json', 'utf8')) as Saved[]
  const manifest = JSON.parse(await readFile('eval-results/research-baseline/manifest.json', 'utf8')) as { inputs: Saved['input'][] }
  const load = async (directory: string) => {
    try {
      const names = (await readdir(directory)).filter(name => /^[A-Z]{2}\..+(?<!receipt)\.json$/.test(name))
      return await Promise.all(names.map(async name => JSON.parse(await readFile(resolve(directory, name), 'utf8')) as Saved))
    } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error }
  }
  const eve = await load('eval-results/research-eve-v1')
  const control = await load('eval-results/research-control')
  const parallel = await load('eval-results/research-eve-parallel-v1')
  const hostedRow = (row: Saved): Row => ({ durationMs: row.result?.durationMs ?? row.durationMs ?? 0, description: !!row.result?.draft.description, facts: row.result?.draft.funFacts.length ?? 0, links: row.result?.draft.readMore.length ?? 0, status: row.result?.status ?? 'failed', usd: row.result?.cost.usd ?? row.cost?.usd ?? row.settled?.costUsd ?? null, missingCost: row.result ? row.result.cost.missing > 0 : !row.cost || row.cost.missing > 0 })
  const summary = {
    frozenVersion: 16, corpus: manifest.inputs.length, generatedAt: new Date().toISOString(),
    desktop: summarizeResearch(baseline.map((row: Saved) => ({ durationMs: row.durationMs ?? 0, description: !!row.raw?.draft.description, facts: row.raw?.draft.funFacts.length ?? 0, links: row.raw?.readMore.length ?? 0, status: row.raw?.status ?? 'failed', usd: null, missingCost: true }))),
    eve: summarizeResearch(eve.map(hostedRow)),
    control: summarizeResearch(control.map((row: Saved) => ({ durationMs: row.durationMs ?? 0, description: !!row.draft?.description, facts: row.draft?.funFacts.length ?? 0, links: row.draft?.readMore.length ?? 0, status: row.skipped ? 'no_sources' : row.error ? 'failed' : 'completed', usd: row.cost?.usd ?? null, missingCost: !!row.error || !!row.cost?.missing }))),
    gatewayParallel: summarizeResearch(parallel.map(hostedRow)),
    limitations: ['Serper and Brave credentials absent on both executing hosts; this does not measure fully configured existing search.', 'Persistent retrieval caches were used; per-request cache attribution is unknown. Desktop first-run model warmup affects latency.', 'Operational coverage and pipeline status are not factual-quality scores. Blind curator acceptance, correction effort and cost per accepted plate are unmeasured.', 'The identical-evidence control uses the exact captured desktop passages and a separate synthesis-only prompt.', 'Gateway Parallel uses an extra Sol call to invoke provider search; its calls, cost and model-budget consumption are included separately.', 'Capped or failed runs remain in the denominator. Raw source text and model outputs remain ignored local artifacts. Local hardware and electricity costs are unmeasured.'],
  }
  const directory = 'eval-results/research-report'
  await mkdir(directory, { recursive: true })
  await writeFile(`${directory}/summary.json`, JSON.stringify(summary, null, 2))
  const header = 'executor,plates,descriptions,facts,fetched_links,failures,p50_ms,p95_ms,known_usd,missing_cost_plates'
  await writeFile(`${directory}/summary.csv`, [header, ...(['desktop', 'eve', 'control', 'gatewayParallel'] as const).map(name => { const row = summary[name]; return [name, row.plates, row.descriptions, row.facts, row.fetchedLinks, row.failures, row.p50Ms, row.p95Ms, row.knownUsd.toFixed(6), row.missingCostPlates].join(',') })].join('\n') + '\n')
  await writeFile(`${directory}/summary.md`, `# Research comparison — Snapshot v16\n\n${header.split(',').join(' | ')}\n${header.split(',').map(() => '---').join(' | ')}\n${(['desktop', 'eve', 'control', 'gatewayParallel'] as const).map(name => { const r = summary[name]; return [name, r.plates, r.descriptions, r.facts, r.fetchedLinks, r.failures, r.p50Ms, r.p95Ms, r.knownUsd.toFixed(6), r.missingCostPlates].join(' | ') }).join('\n')}\n\n${summary.limitations.map(text => `- ${text}`).join('\n')}\n`)
  const blindKey: Record<string, unknown> = {}
  const html = manifest.inputs.map((input: Saved['input']) => {
    const raw = baseline.find((row: Saved) => row.input.plateId === input.plateId)?.raw
    const otherArms: [string, Saved[]][] = [['eve', eve], ['control', control], ['parallel', parallel]]
    const arms = [
      { arm: 'desktop', draft: { description: raw?.draft.description, funFacts: raw?.draft.funFacts ?? [] }, sources: raw?.sources ?? [] },
      ...otherArms.map(([arm, rows]) => { const row = rows.find(row => row.input.plateId === input.plateId); return { arm, draft: row?.result?.draft ?? row?.draft, sources: row?.result?.sources ?? row?.sources ?? [] } }),
    ].sort((a, b) => createHash('sha256').update(input.plateId + a.arm).digest('hex').localeCompare(createHash('sha256').update(input.plateId + b.arm).digest('hex')))
    return `<section><h2>${escape(input.state)} · ${escape(input.displayName)} <small>${escape(input.split)}</small></h2><div class="arms">${arms.map((entry, index) => {
      const id = `${input.plateId}/${index + 1}`; blindKey[id] = entry.arm
      return `<article><h3>Option ${index + 1}</h3><p>${escape(entry.draft?.description ?? 'No description')}</p><ul>${(entry.draft?.funFacts ?? []).map((fact) => `<li>${escape(fact.text)} <small>${escape('sourceId' in fact ? fact.sourceId : fact.sourceUrl)}</small></li>`).join('')}</ul><details><summary>Captured sources</summary>${entry.sources.map((source) => `<details><summary>${escape(source.id)} · ${escape(source.title)}</summary><a href="${escape(source.url)}" target="_blank" rel="noreferrer">Open source</a><pre>${escape(source.text)}</pre></details>`).join('')}</details><label>Review <select data-id="${escape(id)}"><option value="">Unscored</option><option>Accept as is</option><option>Needs correction</option><option>Reject</option></select></label><label>Corrections or unsupported claims<textarea data-note="${escape(id)}"></textarea></label></article>`
    }).join('')}</div></section>`
  }).join('')
  await writeFile(`${directory}/blind-key.json`, JSON.stringify(blindKey, null, 2))
  await writeFile(`${directory}/blind-review.html`, `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Blind plate research comparison</title><style>body{font:16px system-ui;margin:auto;max-width:1400px;padding:20px;background:#f4f2ec;color:#222}section{margin-block:30px}.arms{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,280px),1fr));gap:16px}article{background:white;border:1px solid #bbb;border-radius:12px;padding:16px;min-width:0}pre{white-space:pre-wrap;overflow-wrap:anywhere;max-height:300px;overflow:auto}label{display:grid;gap:8px;margin-block:16px}select,textarea,button{font:inherit;padding:10px}a{overflow-wrap:anywhere}textarea{min-height:90px}</style><h1>Blind research review</h1><p>Compare source support, relevance, useful coverage and needed corrections. Labels hide the executor. No scores are sent anywhere. Export your review when finished. Time from opening this page includes reading and idle time; it is not correction effort.</p><button id="export">Export review JSON</button>${html}<script>const started=Date.now();document.getElementById('export').onclick=()=>{const values=[...document.querySelectorAll('select[data-id]')].map(e=>({id:e.dataset.id,verdict:e.value,note:document.querySelector('textarea[data-note="'+e.dataset.id+'"]').value}));const a=document.createElement('a');a.href=URL.createObjectURL(new Blob([JSON.stringify({openedAt:new Date(started).toISOString(),elapsedSeconds:(Date.now()-started)/1000,values},null,2)],{type:'application/json'}));a.download='research-blind-review.json';a.click();URL.revokeObjectURL(a.href)};</script></html>`)
  console.log(JSON.stringify(summary))
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch(error => { console.error(error.message); process.exitCode = 1 })
