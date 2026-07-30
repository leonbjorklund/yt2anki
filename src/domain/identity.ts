export const NOTE_TYPE_ID = 1761782400001;
export const NOTE_TYPE_NAME = "yt2anki Listening v1";
export const PACKAGE_MTIME = 946684800;

export async function createSegmentIdentity(input: {
  endMs: number;
  originalText: string;
  startMs: number;
  trackId: string;
  videoId: string;
}): Promise<string> {
  const canonical = [
    "yt2anki-segment-v1",
    input.videoId,
    input.trackId,
    Math.round(input.startMs).toString(),
    Math.round(input.endMs).toString(),
    input.originalText.normalize("NFC"),
  ].join("\0");
  return `v1_${base64Url(await sha256(canonical))}`;
}

export function noteGuid(identity: string): string {
  const digest = identity.startsWith("v1_") ? identity.slice(3) : identity;
  return `y2a_${digest.slice(0, 22)}`;
}

export async function stableNumericId(input: string): Promise<number> {
  const digest = await sha256(`yt2anki-id-v1\0${input}`);
  let value = 0;
  for (let index = 0; index < 6; index += 1) {
    value = value * 256 + (digest[index] ?? 0);
  }
  return 1_700_000_000_000 + (value % 900_000_000_000);
}

async function sha256(value: string): Promise<Uint8Array> {
  const bytes = new TextEncoder().encode(value);
  return new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
}

function base64Url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}
