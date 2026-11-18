import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { loadResearchArtifacts, type ResearchArtifact as Saved } from './research-artifact'

type Row = { durationMs: number | null; description: boolean; facts: number; links: number; status: string; usd: number | null; missingCost: boolean }
/**
 * Summarize benchmark outcomes, latency percentiles and known cost from the saved
 * research artifacts.
 */
export function summarizeResearch(rows: Row[]) {
  const times = rows.flatMap(row => row.durationMs === null ? [] : [row.durationMs]).sort((a, b) => a - b)
  /** Select a latency percentile from the sorted successful research timings. */
  const percentile = (p: number) => times[Math.max(0, Math.ceil(times.length * p) - 1)] ?? null
  return { plates: rows.length, descriptions: rows.filter(row => row.description).length, facts: rows.reduce((sum, row) => sum + row.facts, 0), fetchedLinks: rows.reduce((sum, row) => sum + row.links, 0), failures: rows.filter(row => ['failed', 'error', 'timeout', 'unrun'].includes(row.status)).length, statuses: Object.fromEntries([...new Set(rows.map(row => row.status))].map(status => [status, rows.filter(row => row.status === status).length])), p50Ms: percentile(0.5), p95Ms: percentile(0.95), knownUsd: rows.reduce((sum, row) => sum + (row.usd ?? 0), 0), missingCostPlates: rows.filter(row => row.missingCost).length, acceptedPlates: null, costPerAcceptedPlate: null }
}
/** Escape research output and evidence text for the generated HTML report. */
const escape = (text: unknown) => String(text ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;')

/**
 * Project a research artifact into comparable report fields for results, evidence and
 * cost.
 */
export function researchArtifactRow(row: Saved): Row {
  const draft = row.result?.draft ?? row.draft ?? row.raw?.draft
  return { durationMs: row.result?.durationMs ?? row.durationMs ?? null, description: !!draft?.description, facts: draft?.funFacts.length ?? 0, links: row.result?.draft.readMore.length ?? row.draft?.readMore.length ?? row.raw?.readMore.length ?? 0,
    status: row.error === 'unrun_or_interrupted' ? 'unrun' : row.skipped ? 'no_sources' : row.result?.status ?? row.raw?.status ?? (row.error ? 'failed' : row.draft ? 'completed' : 'failed'),
    usd: row.result?.cost.usd ?? row.cost?.usd ?? row.settled?.costUsd ?? null,
    missingCost: row.result ? row.result.cost.missing > 0 : row.raw ? true : row.skipped ? false : !row.cost || row.cost.missing > 0 }
}

/** Load the frozen run manifest and generate its research benchmark summaries. */
async function main() {
  const manifest = JSON.parse(await readFile('eval-results/research-baseline/manifest.json', 'utf8')) as { inputs: Saved['input'][] }
  const baseline = await loadResearchArtifacts('eval-results/research-baseline', manifest.inputs)
  const eve = await loadResearchArtifacts('eval-results/research-eve-v1', manifest.inputs)
  const control = await loadResearchArtifacts('eval-results/research-control', manifest.inputs)
  const parallel = await loadResearchArtifacts('eval-results/research-eve-parallel-v1', manifest.inputs)
  const summary = {
    frozenVersion: manifest.inputs[0]?.baselineVersion ?? null, corpus: manifest.inputs.length, generatedAt: new Date().toISOString(),
    desktop: summarizeResearch(baseline.map(researchArtifactRow)),
    eve: summarizeResearch(eve.map(researchArtifactRow)),
    control: summarizeResearch(control.map(researchArtifactRow)),
    gatewayParallel: summarizeResearch(parallel.map(researchArtifactRow)),
    limitations: ['Serper and Brave credentials absent on both executing hosts; this does not measure fully configured existing search.', 'Persistent retrieval caches were used; per-request cache attribution is unknown. Desktop first-run model warmup affects latency.', 'Operational coverage and pipeline status are not factual-quality scores. Blind curator acceptance, correction effort and cost per accepted plate are unmeasured.', 'The identical-evidence control uses the exact captured desktop passages and a separate synthesis-only prompt.', 'Gateway Parallel uses an extra Sol call to invoke provider search; its calls, cost and model-budget consumption are included separately.', 'Capped or failed runs remain in the denominator. Raw source text and model outputs remain ignored local artifacts. Local hardware and electricity costs are unmeasured.'],
  }
  const directory = 'eval-results/research-report'
  await mkdir(directory, { recursive: true })
  await writeFile(`${directory}/summary.json`, JSON.stringify(summary, null, 2))
  const header = 'executor,plates,descriptions,facts,fetched_links,failures,p50_ms,p95_ms,known_usd,missing_cost_plates'
  await writeFile(`${directory}/summary.csv`, [header, ...(['desktop', 'eve', 'control', 'gatewayParallel'] as const).map(name => { const row = summary[name]; return [name, row.plates, row.descriptions, row.facts, row.fetchedLinks, row.failures, row.p50Ms, row.p95Ms, row.knownUsd.toFixed(6), row.missingCostPlates].join(',') })].join('\n') + '\n')
  await writeFile(`${directory}/summary.md`, `# Research comparison — Snapshot v${summary.frozenVersion}\n\n${header.split(',').join(' | ')}\n${header.split(',').map(() => '---').join(' | ')}\n${(['desktop', 'eve', 'control', 'gatewayParallel'] as const).map(name => { const r = summary[name]; return [name, r.plates, r.descriptions, r.facts, r.fetchedLinks, r.failures, r.p50Ms, r.p95Ms, r.knownUsd.toFixed(6), r.missingCostPlates].join(' | ') }).join('\n')}\n\n${summary.limitations.map(text => `- ${text}`).join('\n')}\n`)
  const blindKey: Record<string, unknown> = {}
  const html = manifest.inputs.map((input: Saved['input']) => {
    const desktop = baseline.find((row: Saved) => row.input.plateId === input.plateId)!
    const raw = desktop.raw
    const otherArms: [string, Saved[]][] = [['eve', eve], ['control', control], ['parallel', parallel]]
    const arms = [
      { arm: 'desktop', draft: { description: desktop.result?.draft.description ?? raw?.draft.description, funFacts: desktop.result?.draft.funFacts ?? raw?.draft.funFacts ?? [] }, sources: desktop.result?.sources ?? raw?.sources ?? [] },
      ...otherArms.map(([arm, rows]) => { const row = rows.find(row => row.input.plateId === input.plateId); return { arm, draft: row?.result?.draft ?? row?.draft, sources: row?.result?.sources ?? row?.sources ?? [] } }),
    ].sort((a, b) => createHash('sha256').update(input.plateId + a.arm).digest('hex').localeCompare(createHash('sha256').update(input.plateId + b.arm).digest('hex')))
    return `<section><h2>${escape(input.state)} · ${escape(input.displayName)} <small>${escape(input.split)}</small></h2><div class="arms">${arms.map((entry, index) => {
      const id = `${input.plateId}/${index + 1}`; blindKey[id] = entry.arm
      return `<article><h3>Option ${index + 1}</h3><p>${escape(entry.draft?.description ?? 'No description')}</p><ul>${(entry.draft?.funFacts ?? []).map((fact) => `<li>${escape(fact.text)} <small>${escape('sourceId' in fact ? fact.sourceId : fact.sourceUrl)}</small></li>`).join('')}</ul><details><summary>Captured sources</summary>${entry.sources.map((source) => `<details><summary>${escape(source.id)} · ${escape(source.title)}</summary><a href="${escape(source.url)}" target="_blank" rel="noreferrer">Open source</a><pre>${escape(source.text)}</pre></details>`).join('')}</details><div class="verdict"><span class="field-label">Review</span><button type="button" class="verdict-trigger" data-id="${escape(id)}" data-value="" aria-haspopup="listbox" aria-expanded="false"><span>Unscored</span><span aria-hidden="true">⌄</span></button><div class="verdict-menu" role="listbox" aria-label="Review verdict" hidden>${['Unscored', 'Accept as is', 'Needs correction', 'Reject'].map((label, at) => `<button type="button" role="option" tabindex="-1" aria-selected="${at === 0}" data-value="${at === 0 ? '' : label}">${label}</button>`).join('')}</div></div><label>Corrections or unsupported claims<textarea data-note="${escape(id)}" placeholder="Note a correction or an unsupported claim…"></textarea></label></article>`
    }).join('')}</div></section>`
  }).join('')
  await writeFile(`${directory}/blind-key.json`, JSON.stringify(blindKey, null, 2))
  await writeFile(`${directory}/blind-review.html`, `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Blind plate research comparison</title><link rel="icon" href="data:,"><style>body{font:16px system-ui;margin:auto;max-width:1400px;padding:20px;background:#f4f2ec;color:#222}section{margin-block:30px}.arms{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,280px),1fr));gap:16px}article{overflow-wrap:anywhere;background:white;border:1px solid #bbb;border-radius:12px;padding:16px;min-width:0}pre{white-space:pre-wrap;overflow-wrap:anywhere;max-height:300px;overflow:auto}label{display:grid;gap:8px;margin-block:16px}button,textarea{font:inherit;box-sizing:border-box}button{cursor:pointer}button:focus-visible,textarea:focus-visible{outline:2px solid #6653c9;outline-offset:3px}.verdict{position:relative;display:grid;gap:8px;margin-block:16px}.field-label,label{font-size:13px;font-weight:600}.verdict-trigger{display:flex;align-items:center;justify-content:space-between;width:100%;height:38px;border:1px solid #c9c5bb;border-radius:8px;background:#faf9f5;padding:0 12px;font-size:14px;text-align:left}.verdict-menu{position:absolute;top:calc(100% + 6px);left:0;right:0;z-index:10;padding:4px;border:1px solid #d2cec4;border-radius:9px;background:white;box-shadow:0 8px 25px #0002;max-height:190px;overflow:auto}.verdict-menu[hidden]{display:none}.verdict-menu.above{top:auto;bottom:calc(100% - 20px)}.verdict-menu button{display:block;width:100%;padding:8px 10px;border:0;border-radius:5px;background:transparent;color:#27252b;font-size:13px;text-align:left}.verdict-menu button:hover,.verdict-menu button:focus{background:#eeebfa;outline:none}.verdict-menu [aria-selected=true]{background:#f3f0fb;color:#4c3c91}#export{padding:10px 16px;border:0;border-radius:8px;background:#423775;color:white;font-size:14px}a{overflow-wrap:anywhere}textarea{width:100%;max-width:100%;min-height:88px;padding:10px 12px;border:1px solid #c9c5bb;border-radius:8px;background:#faf9f5;color:#27252b;font-size:14px;line-height:1.5;font-weight:400;resize:vertical}</style><h1>Blind research review</h1><p>These ratings compare research quality and help choose improvements to prompts, sources, models, and limits. They are benchmark scores; catalog edits still go through the app’s Batch review. Labels hide the executor. No scores are sent anywhere. Export your review when finished. Time from opening this page includes reading and idle time; it is not correction effort.</p><button id="export">Export review JSON</button>${html}<script>const started=Date.now();
const controls=[...document.querySelectorAll('.verdict')];
function closeMenu(control,focus=false){control.querySelector('.verdict-menu').hidden=true;const trigger=control.querySelector('.verdict-trigger');trigger.setAttribute('aria-expanded','false');if(focus)trigger.focus()}
function openMenu(control,last=false){controls.forEach(other=>closeMenu(other));const menu=control.querySelector('.verdict-menu');menu.hidden=false;menu.classList.remove('above');control.querySelector('.verdict-trigger').setAttribute('aria-expanded','true');if(menu.getBoundingClientRect().bottom>innerHeight-8)menu.classList.add('above');const options=[...menu.querySelectorAll('[role=option]')];(last?options.at(-1):options.find(option=>option.getAttribute('aria-selected')==='true')??options[0]).focus()}
controls.forEach(control=>{const trigger=control.querySelector('.verdict-trigger');trigger.onclick=()=>{if(trigger.getAttribute('aria-expanded')==='true')closeMenu(control);else openMenu(control)};control.querySelectorAll('[role=option]').forEach(option=>option.onclick=()=>{trigger.dataset.value=option.dataset.value;trigger.firstElementChild.textContent=option.textContent;control.querySelectorAll('[role=option]').forEach(item=>item.setAttribute('aria-selected',String(item===option)));closeMenu(control,true)});control.onkeydown=event=>{const menu=control.querySelector('.verdict-menu'),options=[...menu.querySelectorAll('[role=option]')],index=options.indexOf(document.activeElement);if(event.key==='Escape'){event.preventDefault();closeMenu(control,true)}else if(event.key==='Tab')closeMenu(control);else if(['ArrowDown','ArrowUp','Home','End'].includes(event.key)){event.preventDefault();if(menu.hidden){openMenu(control,event.key==='ArrowUp'||event.key==='End');return}const next=event.key==='Home'?0:event.key==='End'?options.length-1:(index+(event.key==='ArrowDown'?1:-1)+options.length)%options.length;options[next].focus()}}});document.addEventListener('click',event=>{controls.forEach(control=>{if(!control.contains(event.target))closeMenu(control)})});
document.getElementById('export').onclick=()=>{const values=[...document.querySelectorAll('.verdict-trigger[data-id]')].map(e=>({id:e.dataset.id,verdict:e.dataset.value,note:document.querySelector('textarea[data-note="'+e.dataset.id+'"]').value}));const a=document.createElement('a');a.href=URL.createObjectURL(new Blob([JSON.stringify({openedAt:new Date(started).toISOString(),elapsedSeconds:(Date.now()-started)/1000,values},null,2)],{type:'application/json'}));a.download='research-blind-review.json';a.click();URL.revokeObjectURL(a.href)};</script></html>`)
  console.log(JSON.stringify(summary))
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch(error => { console.error(error.message); process.exitCode = 1 })
