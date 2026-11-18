import { isGenericDescription } from './generic-description';
import type { Source } from './sources';

export type FunFact = { text: string; sourceUrl: string; sourceTitle?: string };
export type ReadMoreLink = { title: string; site: string; url: string };

export type StoryDraft = {
  description: string | null;
  descriptionSource: Source | null;
  firstIssuedYear: number | null;
  funFacts: FunFact[];
};

export type Rejection = { field: 'description' | 'firstIssuedYear' | 'funFacts' | 'shape'; reason: string; value?: unknown };

export const MAX_FACT_WORDS = 25;
export const MAX_FACTS = 4;
export const MAX_DESCRIPTION_WORDS = 70;
export const MIN_DESCRIPTION_WORDS = 10;
const PLATE_MECHANICS = /\b(serials?|serial numbers?|embossed|debossed|surface[- ]printed|screened|fonts?|typefaces?|decals?|stickers?|background colou?r|colou?r scheme)\b/i;
const MONEY_OR_SPONSOR = /\b(fees?|funds?|funded|funding|proceeds|sponsor\w*|revenue|dollars?|\$\d[\d,]*)\b|\$\d[\d,]*/gi;
const SUPERLATIVE = /\b(first|only|oldest|largest|biggest|best|most|longest|highest|fastest|greatest|youngest|newest)\b/gi;

/** Split trimmed text into words for field length and grounding checks. */
const words = (s: string) => s.trim().split(/\s+/).filter(Boolean);
/** Normalize text before comparing candidate facts and evidence tokens. */
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/**
 * Extract numbers with consistent punctuation so source comparisons preserve their
 * values.
 */
function numbersIn(text: string): string[] {
  return (text.match(/\d[\d,.]*\d|\d/g) ?? []).map((n) => n.replace(/[,.]$/, '').replace(/,/g, ''));
}

/** Require all numbers in a claim to appear in its cited evidence. */
function numbersGrounded(text: string, source: string): boolean {
  const available = new Set(numbersIn(source));
  return numbersIn(text).every((n) => available.has(n));
}

/** Verify that terms matched by a claim pattern are present in the cited source. */
function wordsGrounded(pattern: RegExp, text: string, source: string): boolean {
  const src = source.toLowerCase();
  return (text.match(pattern) ?? []).every((w) => src.includes(w.toLowerCase().replace(/^\$/, '$')));
}

/** Require superlatives in generated text to be supported by the evidence. */
function superlativesGrounded(text: string, source: string): boolean {
  return wordsGrounded(SUPERLATIVE, text, source);
}

/**
 * Find the first description sentence that contains a claim unsupported by its source.
 */
function descriptionUngrounded(text: string, sources: Source[]): string | null {
  for (const sentence of sentences(text)) {
    const best = sources
      .map((s) => supportingWindow(sentence, s.text))
      .reduce((a, b) => (b.support > a.support ? b : a), { text: '', support: 0 });
    if (best.support < MIN_SUPPORT) return 'sentence not supported by any source';
    if (!wordsGrounded(MONEY_OR_SPONSOR, sentence, best.text)) return 'money or sponsor claim not in its source';
    if (!numbersGrounded(sentence, best.text)) return 'number not in its source';
  }
  return null;
}

const STOP = new Set(['this', 'that', 'with', 'from', 'were', 'was', 'have', 'has', 'been', 'their', 'they', 'them', 'into', 'about', 'which', 'when', 'where', 'what', 'also', 'than', 'then', 'there', 'these', 'those', 'over', 'more', 'some', 'such', 'plate', 'plates', 'license']);
export const MIN_SUPPORT = 0.5;

/**
 * Extract comparable content terms by dropping short and generic words and normalizing
 * plurals.
 */
function contentTokens(text: string): string[] {
  return norm(text)
    .split(' ')
    .filter((t) => (t.length >= 4 || /^\d+$/.test(t)) && !STOP.has(t))
    .map((t) => (t.length > 4 && t.endsWith('s') ? t.slice(0, -1) : t));
}

/** Split evidence into sentences so grounding can be checked against nearby text. */
function sentences(text: string): string[] {
  return text.split(/(?<=[.!?])\s+(?=[A-Z0-9"“(])|\n+/).map((s) => s.trim()).filter(Boolean);
}

/** Find the smallest useful sentence window that covers a fact's distinguishing terms. */
export function supportingWindow(claim: string, source: string): { text: string; support: number } {
  const want = [...new Set(contentTokens(claim))];
  const sents = sentences(source);
  /**
   * Score windows of the requested width and return the evidence with the strongest term
   * coverage.
   */
  const bestOfWidth = (width: number) => {
    let best = { text: '', support: 0 };
    for (let i = 0; i + width <= sents.length; i++) {
      const window = sents.slice(i, i + width).join(' ');
      const have = new Set(contentTokens(window));
      const support = want.length ? want.filter((t) => have.has(t)).length / want.length : 0;
      if (support > best.support) best = { text: window, support };
    }
    return best;
  };
  const single = bestOfWidth(1);
  return single.support >= MIN_SUPPORT ? single : bestOfWidth(2);
}

/** Resolve an optionally bracketed model citation to a source supplied to the prompt. */
export function sourceFor(id: unknown, sources: Source[]): Source | null {
  if (typeof id !== 'string') return null;
  return sources.find((s) => s.id === id.trim().replace(/^\[|\]$/g, '')) ?? null;
}

/**
 * Validate the generated description against length, specificity and cited evidence
 * requirements.
 */
function validateDescription(raw: Record<string, unknown>, sources: Source[], rejected: Rejection[]) {
  const text = typeof raw.description === 'string' ? raw.description.replace(/\s+/g, ' ').trim() : '';
  if (!text) return { description: null, descriptionSource: null };
  const source = sourceFor(raw.descriptionSource, sources);
  /** Record the description rejection and clear both the value and its source. */
  const fail = (reason: string) => {
    rejected.push({ field: 'description', reason, value: text });
    return { description: null, descriptionSource: null };
  };
  if (!source) return fail('cites no fetched source');
  if (/\b(?:this|the) (?:license )?plate (?:supports?|funds?|benefits?|honou?rs?|commemorates?)\b/i.test(text) && !/\b(?:plates?|registration)\b/i.test(source.text)) return fail('plate purpose not stated in cited source');
  if (isGenericDescription(text)) return fail('generic or boilerplate');
  if (words(text).length > MAX_DESCRIPTION_WORDS) return fail(`over ${MAX_DESCRIPTION_WORDS} words`);
  if (words(text).length < MIN_DESCRIPTION_WORDS) return fail(`under ${MIN_DESCRIPTION_WORDS} words`);
  const ungrounded = descriptionUngrounded(text, sources);
  if (ungrounded) return fail(ungrounded);
  return { description: text, descriptionSource: source };
}

/** Accept only a plausible issued year explicitly backed by its cited evidence. */
function validateYear(raw: Record<string, unknown>, sources: Source[], rejected: Rejection[]): number | null {
  const y = raw.firstIssuedYear as { year?: unknown; source?: unknown } | null | undefined;
  if (y == null || (typeof y === 'object' && y.year == null)) return null;
  const year = typeof y === 'object' ? Number(y.year) : Number(y);
  const source = typeof y === 'object' ? sourceFor(y.source, sources) : null;
  const max = new Date().getFullYear();
  if (!Number.isInteger(year) || year < 1900 || year > max) {
    rejected.push({ field: 'firstIssuedYear', reason: 'not a plausible year', value: y });
    return null;
  }
  if (!source || !new RegExp(`\\b${year}\\b`).test(source.text)) {
    rejected.push({ field: 'firstIssuedYear', reason: 'year not stated in its source', value: y });
    return null;
  }
  const issuance = sentences(source.text).some(sentence => new RegExp(`\\b${year}\\b`).test(sentence) && /\b(plate|registration)\b/i.test(sentence) && /\b(issued|introduced|released|debuted|offered)\b/i.test(sentence));
  if (!issuance) {
    rejected.push({ field: 'firstIssuedYear', reason: 'source does not state plate issuance', value: y });
    return null;
  }
  return year;
}

/**
 * Keep unique, sourced plate facts that meet the length, grounding and relevance checks.
 */
function validateFacts(raw: Record<string, unknown>, sources: Source[], description: string | null, rejected: Rejection[]): FunFact[] {
  const list = Array.isArray(raw.funFacts) ? raw.funFacts : [];
  const seen = new Set<string>(description ? [norm(description)] : []);
  const out: FunFact[] = [];
  for (const item of list) {
    const f = item as { text?: unknown; source?: unknown };
    const text = typeof f?.text === 'string' ? f.text.replace(/\s+/g, ' ').trim() : '';
    /** Save the rejected fact and reason for the stage's quality report. */
    const reject = (reason: string) => rejected.push({ field: 'funFacts', reason, value: item });
    if (!text) { reject('empty'); continue; }
    const source = sourceFor(f.source, sources);
    if (!source) { reject('cites no fetched source'); continue; }
    const n = words(text).length;
    if (n > MAX_FACT_WORDS) { reject(`over ${MAX_FACT_WORDS} words`); continue; }
    if (n < 5) { reject('too short'); continue; }
    if (PLATE_MECHANICS.test(text)) { reject('about plate layout or serials'); continue; }
    const window = supportingWindow(text, source.text);
    if (window.support < MIN_SUPPORT) { reject('not supported by any passage of its source'); continue; }
    if (!numbersGrounded(text, window.text)) { reject('number not in its supporting passage'); continue; }
    if (!superlativesGrounded(text, window.text)) { reject('superlative not in its supporting passage'); continue; }
    const key = norm(text);
    if (seen.has(key)) { reject('duplicate'); continue; }
    seen.add(key);
    out.push({ text, sourceUrl: source.url, sourceTitle: source.title });
    if (out.length === MAX_FACTS) break;
  }
  return out;
}

/**
 * Validate each story field and return the usable subset alongside specific rejection
 * reasons.
 */
export function validateStory(raw: unknown, sources: Source[]): { draft: StoryDraft; rejected: Rejection[] } {
  const rejected: Rejection[] = [];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    rejected.push({ field: 'shape', reason: 'not a JSON object', value: raw });
    return { draft: { description: null, descriptionSource: null, firstIssuedYear: null, funFacts: [] }, rejected };
  }
  const obj = raw as Record<string, unknown>;
  const { description, descriptionSource } = validateDescription(obj, sources, rejected);
  const firstIssuedYear = validateYear(obj, sources, rejected);
  const funFacts = validateFacts(obj, sources, description, rejected);
  return { draft: { description, descriptionSource, firstIssuedYear, funFacts }, rejected };
}

/** Build a bounded list of distinct evidence links for the plate's read-more section. */
export function readMoreFrom(sources: Source[], max = 4): ReadMoreLink[] {
  const seen = new Set<string>();
  const out: ReadMoreLink[] = [];
  for (const s of sources) {
    if (!/^https?:\/\//.test(s.url) || seen.has(s.url)) continue;
    seen.add(s.url);
    out.push({ title: s.title, site: siteName(s.url), url: s.url });
    if (out.length === max) break;
  }
  return out;
}

/** Derive a readable source name from the link's host. */
export function siteName(url: string): string {
  const host = new URL(url).hostname.replace(/^www\./, '');
  if (/(^|\.)wikipedia\.org$/.test(host)) return 'Wikipedia';
  return host;
}
