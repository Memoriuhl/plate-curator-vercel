import { createHash } from 'node:crypto'
export const COLORS = [
  'white',
  'black',
  'red',
  'orange',
  'yellow',
  'green',
  'teal',
  'blue',
  'purple',
  'gold',
  'gray',
  'tan',
  'pink',
  'brown',
  'silver',
  'maroon',
  'navy',
] as const;

export const THEMES = [
  'patriotic',
  'wildlife',
  'agriculture',
  'veteran',
  'military',
  'education',
  'university',
  'sports',
  'automotive',
  'commercial',
  'memorial',
  'environmental',
  'charity',
  'religious',
  'historical',
  'occupational',
  'fraternal',
  'professional',
] as const;

export const MOTIFS = [
  'star',
  'stripe',
  'silhouette',
  'landscape',
  'sunset',
  'sunrise',
  'coastline',
  'seal',
  'ribbon',
  'banner',
  'scroll',
  'wreath',
  'crest',
  'gradient',
  'flag',
  'mountains',
  'tree',
  'leaf',
  'arrow',
  'circle',
] as const;

const STOPWORDS = new Set([
  'the',
  'a',
  'an',
  'and',
  'or',
  'of',
  'for',
  'to',
  'in',
  'on',
  'at',
  'by',
  'with',
  'plate',
  'plates',
  'license',
  'state',
  'official',
  'standard',
  'passenger',
  'special',
  'specialty',
  'optional',
]);

export function titleKeywords(displayName: string): string[] {
  return displayName
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length >= 3 && !STOPWORDS.has(t));
}

function pickFromVocab<T extends string>(input: unknown, vocab: readonly T[]): T[] {
  if (!Array.isArray(input)) return [];
  const allowed = new Set<string>(vocab);
  const seen = new Set<T>();
  const out: T[] = [];
  for (const item of input) {
    if (typeof item !== 'string') continue;
    const norm = item.trim().toLowerCase();
    if (!allowed.has(norm)) continue;
    if (seen.has(norm as T)) continue;
    seen.add(norm as T);
    out.push(norm as T);
  }
  return out;
}

function pickSubjects(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of input) {
    if (typeof item !== 'string') continue;
    let s = item.trim().toLowerCase();
    if (!/^[a-z][a-z\s-]{1,30}$/.test(s)) continue;
    if (s.endsWith('es') && s.length > 4) s = s.slice(0, -2);
    else if (s.endsWith('s') && !s.endsWith('ss') && s.length > 3) s = s.slice(0, -1);
    if (STOPWORDS.has(s) || seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  return out;
}

export type StructuredTags = {
  primaryColor: string | null;
  colors: string[];
  textColors: string[];
  subjects: string[];
  themes: string[];
  motifs: string[];
  tier: 'design' | 'variant' | 'issue';
  isColorSplit: boolean;
  perceivedColor: string | null;
  contextTags: string[];
  taxonomyConfidence: number;
  emblemText: string[];
};

export function flattenStructuredTags(s: StructuredTags, displayName: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const push = (t: string): void => {
    const norm = t.trim().toLowerCase();
    if (!norm || seen.has(norm)) return;
    seen.add(norm);
    out.push(norm);
  };

  if (s.primaryColor) push(s.primaryColor);
  for (const c of s.colors) push(c);
  for (const c of s.textColors) push(`${c} text`);
  for (const t of s.themes) push(t);
  for (const m of s.motifs) push(m);
  for (const sub of s.subjects) push(sub);
  for (const e of s.emblemText) push(e);
  for (const k of titleKeywords(displayName)) push(k);
  return out;
}

export const SYSTEM_PROMPT = `You are a license-plate analyst. You look at one image of a vehicle license plate and return
both descriptive tags and a taxonomy judgment, using a strict controlled vocabulary. The same
rules apply to plates from any country or jurisdiction — never assume a specific country.

Output ONLY a single JSON object with these fields (no commentary, no markdown fence):
{
  "primaryColor": one color from: ${COLORS.join(', ')},
  "colors": background colors covering more than 25% of the plate (a subset of the same list, ordered most-area to least),
  "textColors": colors of legible LETTERING on the plate — the registration number/letters AND words such as the state name, motto, or slogan (subset of the same list). Non-text GRAPHICS (icons, symbols, emblems, seals, pictures, stickers) are NOT text — never put their colors here,
  "subjects": singular lowercase common nouns naming visible objects. Max 6. Empty if none.
  "emblemText": short letters or an acronym PRINTED on an emblem/seal/badge/logo on the plate (e.g. "CMU", "USN", "VFW"), copied exactly, 2-6 letters each, no spaces or punctuation. Max 3. Empty if none. NOT the jurisdiction name, NOT the slogan, NOT words from the title.
  "themes": tags from: ${THEMES.join(', ')}. Max 3. Empty if none.
  "motifs": tags from: ${MOTIFS.join(', ')}. Max 4. Empty if none.
  "tier": one of "design" | "variant" | "issue",
  "isColorSplit": true if this plate's PERCEIVED BACKGROUND COLOR is the thing that makes it
                  distinguishable from an otherwise-identical design; otherwise false,
  "perceivedColor": the SPECIFIC dominant background shade, named as precisely as the list allows
                    (e.g. "navy", "maroon", "teal", not just "blue" or "red"), from:
                    ${COLORS.join(', ')}. Null if no single color dominates. Name the exact shade
                    you see — downstream code rolls it up to a broad color; that is NOT your job.
  "contextTags": affiliation/context labels a CLOSE-UP viewer could read — org, cause, school,
                 military branch, region, profession (e.g. "veteran", "university", "firefighter").
                 Lowercase, single concept each. Max 5. Empty if none.
  "taxonomyConfidence": your confidence 0..1 in the tier / isColorSplit / perceivedColor judgment.
}

THE SPOTTER TEST (governs tier and isColorSplit):
- A DESIGN is what a passenger in a moving car could distinguish at a glance: a distinct perceived
  background color, or a clearly different scene/background. Designs are the only collectible.
- Treat PERCEIVED COLOR as a design splitter. If two plates share the same artwork/scene but the
  background color is the salient difference, set isColorSplit true and name the SPECIFIC shade in
  perceivedColor. Downstream code groups shades into broad collectible colors (navy and royal blue
  both become one "blue" Design) — you only flag THAT color is the axis and name the exact shade;
  do NOT decide how shades group.
- Affiliation distinctions a passenger CANNOT read at speed (a small org symbol, a school name, a
  branch seal, a center medal/emblem/badge, a slogan/legend, a font change, header/footer wording)
  are NOT design splits — they are FOREGROUND over the background. Emit them as contextTags and
  set tier "design", isColorSplit false. These are VARIANT-tier facts riding on one design; never
  make them a separate collectible (e.g. Colorado's "Bronze Star" vs "Medal Of Honor" vs "U.S. Navy"
  share one mountains background — the differing center medal is foreground, not a new design).
- "issue" (serial range / year / material) is archive only. Almost never your answer for a catalog
  image — use "design" unless the image is explicitly an inventory/serial record.

CONFIDENCE — set taxonomyConfidence at or below 0.5 (route to human) when ANY of:
- you cannot tell whether a difference is a real perceived-color split or just a shade/lighting drift;
- the dominant background color is ambiguous (two colors compete, gradient, washed-out/low-light image);
- you are unsure whether a distinction is a design (scene/color) vs a variant (org/affiliation);
- the image is angled, cropped, glared, or low-resolution enough to make the above uncertain.
Otherwise set it above 0.5, higher the clearer the call.

Rules:
- Use ONLY listed values for the controlled-vocabulary fields. Better empty than guessed.
- Letters and words ARE text (the registration, the state name, a motto, a slogan); their colors go in textColors even when the lettering is small or covers little area.
- A picture, icon, symbol, emblem, seal, or sticker is NOT text: never report its color as a textColor. If such a graphic contains readable letters, put those letters in emblemText.
- Do NOT invent contextTags or emblemText you cannot actually read in the image.`;

function buildUserPrompt(displayName: string, state: string): string {
  return `This plate is from ${state}, named "${displayName}". Identify its background colors, subjects, themes, motifs, and any acronym lettering on an emblem/seal/logo. For textColors, check EVERY piece of lettering separately — the registration number, the state name, and any motto or slogan (often a small word along the top or bottom) — and list each distinct lettering color, since they are frequently different colors. Respond with the JSON object only.`;
}

export function repairLooseJson(s: string): string {
  return s.replace(/:\s*([A-Za-z][A-Za-z ]*?)\s*([,}\]])/g, (_m, val: string, end: string) => {
    const low = val.trim().toLowerCase();
    if (low === 'true' || low === 'false' || low === 'null') return `: ${low}${end}`;
    return `: "${val.trim()}"${end}`;
  });
}

function parseLoose(slice: string): Record<string, unknown> {
  try {
    return JSON.parse(slice) as Record<string, unknown>;
  } catch {
    return JSON.parse(repairLooseJson(slice)) as Record<string, unknown>;
  }
}

export function extractJson(raw: string): Record<string, unknown> {
  let t = raw.trim();
  if (t.startsWith('```')) t = t.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  const start = t.indexOf('{');
  if (start === -1) throw new Error(`no JSON in: ${raw.slice(0, 200)}`);
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < t.length; i++) {
    const ch = t[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return parseLoose(t.slice(start, i + 1));
    }
  }
  throw new Error(`no balanced JSON object in: ${raw.slice(0, 200)}`);
}


export interface ModelAdapter {
  backend: string
  model: string
  promptVersion: string
  suggest(input: { imageB64: string; plate: { displayName: string; state: string; tags: string[] } }): Promise<{ tags: string[]; usage?: Record<string, number> }>
}

export type Attempt = { latencyMs: number; model: string; usage?: Record<string, number>; cost: number | null; costSource: 'reported' | 'estimated' | 'unknown'; status?: number }
export type Pricing = { input: string; output: string; input_cache_read?: string }
export const HOSTED_MODEL = 'google/gemini-3.5-flash-lite'

export async function gatewayPricing(model: string, request: typeof fetch = fetch): Promise<Pricing> {
  const response = await request('https://ai-gateway.vercel.sh/v1/models')
  if (!response.ok) throw new Error(`Pricing request failed: ${response.status}`)
  const body = await response.json()
  const entry = body.data.find((entry: { id: string }) => entry.id === model)
  if (!entry?.tags?.includes('vision') || !entry.pricing || !['input', 'output'].every(key => Number.isFinite(Number(entry.pricing[key])) && Number(entry.pricing[key]) >= 0)) throw new Error('Image model or pricing unavailable')
  return entry.pricing
}

export function gatewayAdapter(options: { apiKey: string; model?: string; fetch?: typeof fetch; pricing?: Pricing; beforeRequest?: () => void; onAttempt?: (attempt: Attempt) => void }): ModelAdapter {
  const model = options.model ?? HOSTED_MODEL
  const request = options.fetch ?? fetch
  let pricing: Promise<Pricing> | undefined
  return { backend: 'hosted', model, promptVersion: createHash('sha256').update(SYSTEM_PROMPT).digest('hex').slice(0, 12), async suggest(input) {
    if (!options.apiKey) throw new Error('AI_GATEWAY_API_KEY is required')
    const rates = options.pricing ?? await (pricing ??= gatewayPricing(model, request))
    options.beforeRequest?.()
    const start = performance.now()
    const attempt: Attempt = { model, latencyMs: 0, cost: null, costSource: 'unknown' }
    try {
      const bytes = Buffer.from(input.imageB64, 'base64')
      const mime = bytes[0] === 0x89 ? 'image/png' : bytes[0] === 0xff ? 'image/jpeg' : bytes.toString('ascii', 0, 3) === 'GIF' ? 'image/gif' : 'image/webp'
      const response = await request('https://ai-gateway.vercel.sh/v1/chat/completions', {
        method: 'POST', headers: { Authorization: `Bearer ${options.apiKey}`, 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(180000),
        body: JSON.stringify({ model, temperature: 0.1, messages: [{ role: 'system', content: SYSTEM_PROMPT }, { role: 'user', content: [{ type: 'text', text: buildUserPrompt(input.plate.displayName, input.plate.state) }, { type: 'image_url', image_url: { url: `data:${mime};base64,${input.imageB64}` } }] }] }),
      })
      attempt.status = response.status
      if (!response.ok) throw Object.assign(new Error(`Model request failed: ${response.status}`), { status: response.status })
      const body = await response.json()
      attempt.model = body.model ?? model
      attempt.usage = Object.fromEntries(Object.entries(body.usage ?? {}).filter(([, value]) => typeof value === 'number')) as Record<string, number>
      const reported = body.usage?.cost ?? body.cost
      if (reported != null && Number.isFinite(Number(reported)) && Number(reported) >= 0) {
        attempt.cost = Number(reported)
        attempt.costSource = 'reported'
      } else if (typeof body.usage?.prompt_tokens === 'number' && typeof body.usage?.completion_tokens === 'number') {
        const cached = body.usage.prompt_tokens_details?.cached_tokens ?? 0
        attempt.cost = (body.usage.prompt_tokens - cached) * Number(rates.input) + cached * Number(rates.input_cache_read ?? rates.input) + body.usage.completion_tokens * Number(rates.output)
        attempt.costSource = 'estimated'
      }
      return { tags: normalizeCompletion(body.choices?.[0]?.message?.content ?? '', input), usage: attempt.usage }
    } finally {
      attempt.latencyMs = performance.now() - start
      options.onAttempt?.(attempt)
    }
  } }
}

type Input = Parameters<ModelAdapter['suggest']>[0]
type Options = { url: string; model: string; fetch?: typeof fetch }

async function ollamaChatOnce(options: Options, input: Input) {
  const response = await (options.fetch ?? fetch)(`${options.url.replace(/\/+$/, '').replace(/\/v1$/, '')}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: options.model, stream: false, think: false, keep_alive: '30m', options: { temperature: 0.1, num_ctx: 4096 }, messages: [{ role: 'system', content: SYSTEM_PROMPT }, { role: 'user', content: buildUserPrompt(input.plate.displayName, input.plate.state), images: [input.imageB64] }] }),
  })
  if (!response.ok) throw Object.assign(new Error(`Model request failed: ${response.status}`), { status: response.status })
  const body = await response.json()
  if (body.error || !body.message?.content) throw new Error('Model returned no completion')
  const usage: Record<string, number> = {}
  for (const key of ['eval_count', 'prompt_eval_count']) {
    if (typeof body[key] === 'number' && Number.isFinite(body[key])) usage[key] = body[key]
  }
  return { text: String(body.message.content), usage }
}

export async function callVLM(options: Options, input: Input) {
  const { text, usage } = await ollamaChat(options, input)
  return { tags: normalizeCompletion(text, input), usage }
}

export function normalizeCompletion(text: string, input: Input) {
  const parsed = extractJson(text)
  const primaryColor = pickFromVocab([parsed.primaryColor], COLORS)[0] ?? null
  const structured: StructuredTags = {
    primaryColor,
    colors: pickFromVocab(parsed.colors, COLORS).slice(0, 4),
    textColors: pickFromVocab(parsed.textColors, COLORS).slice(0, 2),
    subjects: pickSubjects(parsed.subjects).slice(0, 6),
    themes: pickFromVocab(parsed.themes, THEMES).slice(0, 3),
    motifs: pickFromVocab(parsed.motifs, MOTIFS).slice(0, 4),
    emblemText: Array.isArray(parsed.emblemText) ? parsed.emblemText.filter((v): v is string => typeof v === 'string' && /^[a-z]{2,6}$/i.test(v)).slice(0, 3) : [],
    tier: parsed.tier === 'variant' || parsed.tier === 'issue' ? parsed.tier : 'design',
    isColorSplit: parsed.isColorSplit === true,
    perceivedColor: pickFromVocab([parsed.perceivedColor], COLORS)[0] ?? null,
    contextTags: [],
    taxonomyConfidence: typeof parsed.taxonomyConfidence === 'number' ? Math.max(0, Math.min(1, parsed.taxonomyConfidence)) : 0,
  }
  return flattenStructuredTags(structured, input.plate.displayName)
}

export function ollamaAdapter(options: Options): ModelAdapter {
  return { backend: 'ollama', model: options.model, promptVersion: createHash('sha256').update(SYSTEM_PROMPT).digest('hex').slice(0, 12), suggest: (input) => callVLM(options, input) }
}


export async function ollamaChat(options: Options, input: Input) {
  let lastError: unknown
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await ollamaChatOnce(options, input)
    } catch (error) {
      const status = (error as { status?: number }).status
      if (status && status < 500) throw error
      lastError = error
      if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 400 * (attempt + 1)))
    }
  }
  throw lastError
}
