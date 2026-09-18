const MAX_TITLE_LENGTH = 80;

export function baseVideoDeckName(title: string): string {
  const safeTitle = collapseWhitespace(title.replaceAll("::", " - "));
  return truncateAtWord(safeTitle, MAX_TITLE_LENGTH) || "Untitled video";
}

export function packageFilename(title: string, videoId: string): string {
  const safe = collapseWhitespace(safeFilenameText(title)).replace(
    /[. ]+$/g,
    "",
  );
  const stem = truncateAtWord(safe, 70) || videoId;
  return `${stem} - ${videoId}.apkg`;
}

function safeFilenameText(value: string): string {
  const reserved = '<>:"/\\|?*';
  return Array.from(value)
    .filter((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint >= 32 && !reserved.includes(character);
    })
    .join("");
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
  return (
    boundary >= Math.floor(limit * 0.6)
      ? candidate.slice(0, boundary)
      : characters.slice(0, limit)
  )
    .join("")
    .trimEnd();
}
