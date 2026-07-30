import type { Segment } from "./domain/types.ts";

const MODEL = "gemini-3.5-flash-lite";
const ENDPOINT =
  `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;
const MAX_BATCH_SEGMENTS = 30;
const MAX_BATCH_CHARACTERS = 12_000;

export interface TranslationBatchResult {
  id: string;
  translation: string;
}

export async function translateMissingSegments(input: {
  apiKey: string;
  nativeLocale: string;
  onBatch(batch: TranslationBatchResult[]): Promise<void>;
  segments: Segment[];
  targetLocale: string;
}): Promise<void> {
  const pending = input.segments.filter(
    (segment) => !segment.translation.trim(),
  );
  for (const batch of createBatches(pending)) {
    const translations = await translateBatch({
      apiKey: input.apiKey,
      nativeLocale: input.nativeLocale,
      segments: batch,
      targetLocale: input.targetLocale,
    });
    await input.onBatch(translations);
  }
}

async function translateBatch(input: {
  apiKey: string;
  nativeLocale: string;
  segments: Segment[];
  targetLocale: string;
}): Promise<TranslationBatchResult[]> {
  const ids = input.segments.map((segment) => segment.identity);
  const response = await fetch(ENDPOINT, {
    body: JSON.stringify({
      contents: [
        {
          parts: [
            {
              text: [
                `Translate each ${input.targetLocale} caption into natural ${input.nativeLocale}.`,
                "Use the surrounding ordered captions as context.",
                "Return exactly one translation for every ID and preserve each ID unchanged.",
                JSON.stringify(
                  input.segments.map((segment) => ({
                    id: segment.identity,
                    text: segment.target,
                  })),
                ),
              ].join("\n"),
            },
          ],
          role: "user",
        },
      ],
      generationConfig: {
        responseJsonSchema: {
          additionalProperties: false,
          properties: {
            translations: {
              items: {
                additionalProperties: false,
                properties: {
                  id: { type: "string" },
                  translation: { type: "string" },
                },
                required: ["id", "translation"],
                type: "object",
              },
              type: "array",
            },
          },
          required: ["translations"],
          type: "object",
        },
        responseMimeType: "application/json",
        temperature: 0.2,
      },
    }),
    headers: {
      "Content-Type": "application/json",
      "x-goog-api-key": input.apiKey,
    },
    method: "POST",
    signal: AbortSignal.timeout(60_000),
  });

  if (!response.ok) {
    throw new Error(`Gemini request failed with HTTP ${response.status}`);
  }

  const body: unknown = await response.json();
  const text = candidateText(body);
  const parsed: unknown = JSON.parse(text);
  const translations = validateTranslations(parsed, ids);
  return translations;
}

function createBatches(segments: Segment[]): Segment[][] {
  const batches: Segment[][] = [];
  let current: Segment[] = [];
  let characters = 0;

  for (const segment of segments) {
    const size = segment.target.length + segment.identity.length;
    if (
      current.length > 0 &&
      (current.length >= MAX_BATCH_SEGMENTS ||
        characters + size > MAX_BATCH_CHARACTERS)
    ) {
      batches.push(current);
      current = [];
      characters = 0;
    }
    current.push(segment);
    characters += size;
  }
  if (current.length > 0) {
    batches.push(current);
  }
  return batches;
}

function candidateText(value: unknown): string {
  const root = record(value);
  const candidates = array(root.candidates);
  const first = record(candidates[0]);
  const content = record(first.content);
  const parts = array(content.parts);
  const part = record(parts[0]);
  if (typeof part.text !== "string" || !part.text.trim()) {
    throw new Error("Gemini returned no structured translation");
  }
  return part.text;
}

function validateTranslations(
  value: unknown,
  expectedIds: string[],
): TranslationBatchResult[] {
  const translations = array(record(value).translations).map(record);
  if (translations.length !== expectedIds.length) {
    throw new Error("Gemini returned the wrong translation count");
  }

  const expected = new Set(expectedIds);
  const seen = new Set<string>();
  const valid = translations.map((translation) => {
    const id = translation.id;
    const text = translation.translation;
    if (
      typeof id !== "string" ||
      typeof text !== "string" ||
      !text.trim() ||
      !expected.has(id) ||
      seen.has(id)
    ) {
      throw new Error("Gemini returned invalid Segment IDs or text");
    }
    seen.add(id);
    return { id, translation: text.trim() };
  });

  if (expectedIds.some((id) => !seen.has(id))) {
    throw new Error("Gemini omitted a Segment ID");
  }
  return valid;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};
}

function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}
