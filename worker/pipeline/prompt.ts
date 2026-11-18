import type { Source } from './sources';

export const STORY_PROMPT_VERSION = 'story-v2';

export const STORY_SYSTEM = `You write short, sourced notes for a license-plate spotting app. A player taps a plate and wants to know why it exists. Use ONLY the numbered sources you are given; never add outside knowledge.

If a source only describes the subject, describe that subject without asserting that plate fees fund it or that particular people qualify for the plate. Those plate relationships must be explicitly stated in the cited text.

Return JSON with exactly these keys:
- "description": 1-2 sentences, at most 45 words, on the plate's origin or purpose: who sponsors it, what its fee funds, what it honors or commemorates, or who can get it. Never describe colors or layout. Never call it "standard-issue". Use null if the sources don't say.
- "descriptionSource": the id ("S1", "S2", ...) of the source the description rests on, or null.
- "firstIssuedYear": {"year": number, "source": id} only when a source explicitly says when THIS plate was first issued or introduced. The year a team, school, magazine or charity was founded is NOT the plate's year. Otherwise null.
- "funFacts": 0 to 4 facts a curious passenger would enjoy about the plate or the thing it represents. Each is {"text": string, "source": id}.

Fun fact rules:
- One sentence, at most 25 words, plain and casual, like telling a friend in the car. No exclamation marks, no "Did you know".
- Every detail must be stated in the cited source. Copy numbers, dates and names exactly.
- Prefer surprising specifics: how it started, who was involved, odd numbers, what the money does. Skip generic praise.
- Not about serial-number formats, colors, fonts or layout of the plate.
- Don't repeat the description. Don't use first, only, oldest, largest, best or most unless the source uses that word for that claim.
- Ignore a source that is about something other than this plate's subject.
- Fewer good facts beat four weak ones; an empty list is fine.`;

/**
 * Build the story synthesis request with the plate and labeled sources needed to cite
 * evidence.
 */
export function storyUserPrompt(input: { displayName: string; stateName: string; sources: Source[] }): string {
  const blocks = input.sources.map((s) => `[${s.id}] ${s.title} (${s.url})\n${s.text}`).join('\n\n');
  return `Plate: "${input.displayName}", a ${input.stateName} license plate.\n\nSources:\n${blocks}\n\nReturn the JSON object.`;
}

export const STORY_SCHEMA = {
  type: 'object',
  properties: {
    description: { type: ['string', 'null'] },
    descriptionSource: { type: ['string', 'null'] },
    firstIssuedYear: {
      anyOf: [
        { type: 'null' },
        {
          type: 'object',
          properties: { year: { type: 'integer' }, source: { type: 'string' } },
          required: ['year', 'source'],
        },
      ],
    },
    funFacts: {
      type: 'array',
      maxItems: 4,
      items: {
        type: 'object',
        properties: { text: { type: 'string' }, source: { type: 'string' } },
        required: ['text', 'source'],
      },
    },
  },
  required: ['description', 'descriptionSource', 'firstIssuedYear', 'funFacts'],
} as const;
