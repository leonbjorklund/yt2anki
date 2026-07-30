import { escapeAnkiField } from "../domain/html.ts";
import { NOTE_TYPE_NAME } from "../domain/identity.ts";
import type { Draft, Segment } from "../domain/types.ts";
import {
  ANSWER_TEMPLATE,
  CARD_CSS,
  CARD_TEMPLATE_NAME,
  NOTE_FIELDS,
  QUESTION_TEMPLATE,
} from "./templates.ts";

const ENDPOINT = "http://127.0.0.1:8765";
const API_VERSION = 6;

export class AnkiConnectKeyRequiredError extends Error {
  constructor() {
    super("AnkiConnect requires its local API key.");
  }
}

export class AnkiConnectKeyRejectedError extends Error {}

export class AnkiConnectUnavailableError extends Error {}

export class AnkiConnectPartialError extends Error {
  readonly added: number;

  constructor(added: number) {
    super("AnkiConnect added only part of the selected Notes.");
    this.added = added;
  }
}

export interface AnkiExportResult {
  added: number;
  existing: number;
}

export async function sendDraftToAnki(input: {
  apiKey: string;
  deckName: string;
  draft: Draft;
  segments: Segment[];
}): Promise<AnkiExportResult> {
  const permission = await requestPermission();
  if (permission.permission !== "granted") {
    throw new AnkiConnectUnavailableError(
      "AnkiConnect permission was denied.",
    );
  }
  if (permission.requiresKey && !input.apiKey) {
    throw new AnkiConnectKeyRequiredError();
  }

  const key = input.apiKey || undefined;
  const version = await invoke<unknown>("version", {}, key);
  if (
    typeof version !== "number" ||
    !Number.isInteger(version) ||
    version < API_VERSION
  ) {
    throw new AnkiConnectUnavailableError(
      `AnkiConnect API ${API_VERSION} is required.`,
    );
  }

  await ensureNoteType(key);
  await invoke<number>("createDeck", { deck: input.deckName }, key);

  const existing = await existingSegmentIdentities(
    input.draft.video.videoId,
    key,
  );
  const pending = input.segments.filter(
    (segment) => !existing.has(segment.identity),
  );
  let added = 0;

  for (let index = 0; index < pending.length; index += 50) {
    const batch = pending.slice(index, index + 50);
    try {
      const result = await invoke<unknown>(
        "addNotes",
        {
          notes: batch.map((segment) => ({
            deckName: input.deckName,
            fields: noteFields(input.draft, segment),
            modelName: NOTE_TYPE_NAME,
            options: { allowDuplicate: false },
            tags: ["yt2anki"],
          })),
        },
        key,
      );
      if (
        !Array.isArray(result) ||
        result.length !== batch.length ||
        result.some(
          (id) =>
            id !== null && (typeof id !== "number" || !Number.isInteger(id)),
        )
      ) {
        throw new Error("AnkiConnect returned an invalid addNotes result.");
      }
      const ids = result as Array<number | null>;
      added += ids.filter((id) => typeof id === "number").length;
      if (ids.some((id) => id === null)) {
        throw new AnkiConnectPartialError(added);
      }
    } catch (error) {
      if (error instanceof AnkiConnectPartialError || added === 0) {
        throw error;
      }
      throw new AnkiConnectPartialError(added);
    }
  }

  return {
    added,
    existing: input.segments.length - pending.length,
  };
}

async function requestPermission(): Promise<{
  permission: string;
  requiresKey: boolean;
}> {
  const result = await invoke<Record<string, unknown>>(
    "requestPermission",
    {},
  );
  return {
    permission:
      typeof result.permission === "string" ? result.permission : "denied",
    requiresKey:
      result.requireApikey === true || result.requireApiKey === true,
  };
}

async function ensureNoteType(key?: string): Promise<void> {
  const namesResult = await invoke<unknown>("modelNames", {}, key);
  if (
    !Array.isArray(namesResult) ||
    namesResult.some((name) => typeof name !== "string")
  ) {
    throw new Error("AnkiConnect returned invalid note-type names.");
  }
  const names = namesResult as string[];
  if (!names.includes(NOTE_TYPE_NAME)) {
    await invoke<number>(
      "createModel",
      {
        cardTemplates: [
          {
            Back: ANSWER_TEMPLATE,
            Front: QUESTION_TEMPLATE,
            Name: CARD_TEMPLATE_NAME,
          },
        ],
        css: CARD_CSS,
        inOrderFields: [...NOTE_FIELDS],
        isCloze: false,
        modelName: NOTE_TYPE_NAME,
      },
      key,
    );
    return;
  }

  const [fields, templates, styling] = await Promise.all([
    invoke<string[]>(
      "modelFieldNames",
      { modelName: NOTE_TYPE_NAME },
      key,
    ),
    invoke<Record<string, unknown>>(
      "modelTemplates",
      { modelName: NOTE_TYPE_NAME },
      key,
    ),
    invoke<{ css?: unknown }>(
      "modelStyling",
      { modelName: NOTE_TYPE_NAME },
      key,
    ),
  ]);
  const listeningTemplate = templates[CARD_TEMPLATE_NAME] as
    | { Back?: unknown; Front?: unknown }
    | undefined;
  if (
    JSON.stringify(fields) !== JSON.stringify(NOTE_FIELDS) ||
    Object.keys(templates).length !== 1 ||
    listeningTemplate?.Front !== QUESTION_TEMPLATE ||
    listeningTemplate.Back !== ANSWER_TEMPLATE ||
    styling.css !== CARD_CSS
  ) {
    throw new Error(
      `${NOTE_TYPE_NAME} exists with an incompatible schema. Rename or remove it before exporting.`,
    );
  }
}

async function existingSegmentIdentities(
  videoId: string,
  key?: string,
): Promise<Set<string>> {
  const noteIdsResult = await invoke<unknown>(
    "findNotes",
    {
      query: `note:"${NOTE_TYPE_NAME}" VideoId:${videoId}`,
    },
    key,
  );
  if (
    !Array.isArray(noteIdsResult) ||
    noteIdsResult.some(
      (id) => typeof id !== "number" || !Number.isInteger(id),
    )
  ) {
    throw new Error("AnkiConnect returned invalid Note IDs.");
  }
  const noteIds = noteIdsResult as number[];
  if (noteIds.length === 0) {
    return new Set();
  }

  const notesResult = await invoke<unknown>(
    "notesInfo",
    { notes: noteIds },
    key,
  );
  if (!Array.isArray(notesResult)) {
    throw new Error("AnkiConnect returned invalid Note details.");
  }
  const notes = notesResult as Array<{
    fields?: Record<string, { value?: unknown }>;
  }>;
  return new Set(
    notes
      .map((note) => note.fields?.SegmentIdentity?.value)
      .filter((value): value is string => typeof value === "string"),
  );
}

function noteFields(
  draft: Draft,
  segment: Segment,
): Record<(typeof NOTE_FIELDS)[number], string> {
  return {
    EndMs: Math.round(segment.endMs).toString(),
    SegmentIdentity: segment.identity,
    StartMs: Math.round(segment.startMs).toString(),
    Target: escapeAnkiField(segment.target),
    Translation: escapeAnkiField(segment.translation),
    VideoId: draft.video.videoId,
  };
}

async function invoke<T>(
  action: string,
  params: Record<string, unknown> = {},
  key?: string,
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(ENDPOINT, {
      body: JSON.stringify({
        action,
        ...(key ? { key } : {}),
        params,
        version: API_VERSION,
      }),
      headers: { "Content-Type": "application/json" },
      method: "POST",
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    throw new AnkiConnectUnavailableError(
      "AnkiConnect is unavailable. Open Anki Desktop and check the add-on.",
    );
  }
  if (!response.ok) {
    throw new AnkiConnectUnavailableError(
      `AnkiConnect returned HTTP ${response.status}.`,
    );
  }

  const body: unknown = await response.json();
  if (!body || typeof body !== "object") {
    throw new Error("AnkiConnect returned an invalid response.");
  }
  const result = body as { error?: unknown; result?: unknown };
  if (result.error) {
    const message = String(result.error);
    if (message === "valid api key must be provided") {
      throw new AnkiConnectKeyRejectedError(message);
    }
    throw new Error(message);
  }
  if (!("result" in result)) {
    throw new Error("AnkiConnect response omitted result.");
  }
  return result.result as T;
}
