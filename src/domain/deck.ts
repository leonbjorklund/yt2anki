const DECK_PREFIX = "yt2anki::";
const MAX_TITLE_LENGTH = 80;

export function baseVideoDeckName(title: string): string {
  const safeTitle = collapseWhitespace(title.replaceAll("::", " - "));
  return `${DECK_PREFIX}${truncateAtWord(safeTitle, MAX_TITLE_LENGTH) || "Untitled video"}`;
}

export function resolveVideoDeckName(
  title: string,
  videoId: string,
  owners: Readonly<Record<string, string>>,
): string {
  const base = baseVideoDeckName(title);
  const owner = owners[base];
  return owner && owner !== videoId ? `${base} [${videoId}]` : base;
}

export function packageFilename(title: string, videoId: string): string {
  const safe = collapseWhitespace(title)
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "")
    .replace(/[. ]+$/g, "");
  const stem = truncateAtWord(safe, 70) || videoId;
  return `${stem} - ${videoId}.apkg`;
}

function collapseWhitespace(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

function truncateAtWord(value: string, limit: number): string {
  const characters = Array.from(value);
  if (characters.length <= limit) {
    return value;
  }
  const candidate = characters.slice(0, limit + 1);
  const boundary = candidate.lastIndexOf(" ");
  return (boundary >= Math.floor(limit * 0.6)
    ? candidate.slice(0, boundary)
    : characters.slice(0, limit)
  )
    .join("")
    .trimEnd();
}
