export const DEFAULT_MANUAL_VIDEO_ID = "APv9hfjYRY0";

export function parseManualVideoId(input) {
  const value = input.trim();
  if (/^[A-Za-z0-9_-]{11}$/u.test(value)) {
    return value;
  }
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error("--video must be a YouTube video ID or URL.");
  }
  const candidate =
    url.hostname === "youtu.be"
      ? url.pathname.split("/").filter(Boolean)[0]
      : url.searchParams.get("v");
  if (!candidate || !/^[A-Za-z0-9_-]{11}$/u.test(candidate)) {
    throw new Error(
      "The supplied URL does not contain a valid YouTube video ID.",
    );
  }
  return candidate;
}

export function manualChromeArguments({ profileDir, setup, videoId }) {
  const args = [
    `--user-data-dir=${profileDir}`,
    "--no-default-browser-check",
    "--no-first-run",
    "--new-window",
  ];
  if (setup) {
    args.push("chrome://extensions/");
  }
  args.push(`https://www.youtube.com/watch?v=${videoId}`);
  return args;
}
