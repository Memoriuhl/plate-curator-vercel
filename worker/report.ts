import type { Run } from './benchmark'

/** Escape text values before interpolating them into benchmark HTML. */
const escape = (value: unknown) => String(value ?? 'unknown').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)
/** Format numeric metrics with fixed precision or a readable unknown value. */
const number = (value: number | null, digits = 3) => value === null ? 'unknown' : value.toFixed(digits)
/**
 * Name a result artifact by backend and concurrency so benchmark lanes can be compared.
 */
export const runFile = (run: Run) => `${run.backend}-c${run.concurrency}.json`
/** Project benchmark lane data into the columns used by the summary outputs. */
export function reportRows(runs: Run[]) {
  return runs.map(r => [r.backend, r.model, r.concurrency, number(r.overall.f1), number(r.overall.precision), number(r.overall.recall), r.failedPlates, number(r.latency.p50), number(r.latency.p95), r.latency.sampleCount, number(r.wallMs), number(r.throughput), number(r.costPerPlate, 8), number(r.totalCost, 8), r.costSource, r.retries, r.rateLimits, r.status, r.missingCostAttempts])
}
const columns = ['backend', 'model', 'concurrency', 'F1', 'precision', 'recall', 'failures', 'p50 ms', 'p95 ms', 'latency samples', 'wall ms', 'Plates/min', 'cost/Plate USD', 'total USD', 'cost source', 'retries', '429s', 'status', 'missing cost attempts']
/** Serialize the benchmark summary table as CSV. */
export function summaryCsv(runs: Run[]) {
  return [columns, ...reportRows(runs)].map(row => row.map(v => `"${String(v).replaceAll('"', '""')}"`).join(',')).join('\n') + '\n'
}
/** Draw a standalone throughput comparison for the measured concurrency lanes. */
function performanceChart(runs: Run[], key: 'wallMs' | 'throughput', title: string) {
  const max = Math.max(1, ...runs.map(r => r[key]))
  return `<svg viewBox="0 0 700 260" role="img" aria-label="${title}"><text x="40" y="20">${title}</text><path d="M50 35V220H660" fill="none" stroke="black"/>${['local', 'hosted'].map((backend, index) => {
    const subset = runs.filter(r => r.backend === backend)
    const color = index ? '#b45309' : '#2563eb'
    const points = subset.map(r => `${50 + r.concurrency * 35},${220 - r[key] / max * 175}`).join(' ')
    return `<polyline points="${points}" fill="none" stroke="${color}"/>${subset.map(r => `<circle cx="${50 + r.concurrency * 35}" cy="${220 - r[key] / max * 175}" r="4" fill="${color}"><title>${backend} c${r.concurrency}: ${number(r[key])}</title></circle>`).join('')}<text x="${400 + index * 100}" y="20" fill="${color}">${backend}</text>`
  }).join('')}${[1, 4, 8, 16].map(c => `<text x="${45 + c * 35}" y="240">${c}</text>`).join('')}<text x="280" y="258">Concurrency (N); maximum y ${number(max)}</text></svg>`
}
/**
 * Render a benchmark report with comparable local and hosted timing, cost and quality
 * outcomes.
 */
export function reportHtml(runs: Run[], smokeCost: number | null = null, observations = '') {
  const local = runs.find(r => r.backend === 'local' && r.concurrency === 1)
  const hosted = runs.find(r => r.backend === 'hosted' && r.concurrency === 1)
  const warning = `<p>${escape(observations)}</p><p>Wall times include failed requests. Low wall time with zero throughput measures rejection, not inference capacity. Check failures and completion sample counts before comparing speed.</p>`
  const paired = local?.plates.map((p, i) => `<g><title>${escape(p.displayName)}: local ${number(p.score.f1)}, hosted ${number(hosted?.plates.find(h => h.id === p.id)?.score.f1 ?? null)}</title><rect x="${40 + i * 20}" y="${220 - p.score.f1 * 180}" width="7" height="${p.score.f1 * 180}" fill="#2563eb"/><rect x="${48 + i * 20}" y="${220 - (hosted?.plates.find(h => h.id === p.id)?.score.f1 ?? 0) * 180}" width="7" height="${(hosted?.plates.find(h => h.id === p.id)?.score.f1 ?? 0) * 180}" fill="#b45309"/></g>`).join('') ?? ''
  return `<!doctype html><html lang="en"><meta charset="utf-8"><title>Tagging comparison</title><style>body{font:15px system-ui;margin:32px;color:#172033}table{border-collapse:collapse;font-size:12px}td,th{padding:8px;border:1px solid #cbd5e1}svg{max-width:850px;display:block}p{max-width:1000px}</style><h1>Hosted and local tagging</h1>${warning}<p>Hosted model: ${escape(hosted?.model)}. The planned default is google/gemini-3.5-flash-lite; an override measures the model named in each row.</p><table><thead><tr>${columns.map(c => `<th>${c}</th>`).join('')}</tr></thead><tbody>${reportRows(runs).map((row, i) => `<tr>${row.map((v, j) => `<td>${j === 0 ? `<a href="${runFile(runs[i])}">${escape(v)}</a>` : escape(v)}</td>`).join('')}</tr>`).join('')}</tbody></table>${performanceChart(runs, 'wallMs', 'Batch wall time (ms)')}${performanceChart(runs, 'throughput', 'Successful Plates per minute')}<h2>Per-Plate F1 at concurrency 1</h2><p>Fixture order; blue local, orange hosted. Hover bars for Plate labels and scores. F1 scale 0–1.</p><svg viewBox="0 0 700 240" role="img" aria-label="Per-Plate local and hosted F1"><path d="M35 35V220H660" fill="none" stroke="black"/>${paired}</svg><h2>What this shows / what it doesn't</h2><p>Observed: tag agreement, attempts, failures, request timing and throughput through this harness. Latency includes queue wait from batch enqueue; inference time sums actual requests. Small sample (30 Plates); tail percentiles are provisional. The reference tags are provisional. These runs used the harness, not the Workflow path. Local energy is not measured; unknown local cost is not zero. Reported costs are response charges, not independently reconciled billing. Estimated costs use the captured model pricing and usage. Missing charges are explicitly counted; known totals may be incomplete.</p><p>Hosted matrix known spend: $${number(runs.filter(r => r.backend === 'hosted').reduce((s, r) => s + (r.totalCost ?? 0), 0), 8)}; single-Plate preflight: $${number(smokeCost, 8)}.</p><p>${runs.filter(r => r.backend === 'local').map(r => `c${r.concurrency}: ${escape(r.contention)}`).join('<br>')}</p></html>`
}
