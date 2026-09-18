# yt2anki v1

## Contract

- One or two Standard Caption Tracks become editable Anki listening cards; video stays on YouTube.
- Capture uses the pinned VISIONOS/JSON3 route in [capture/main.ts](../src/capture/main.ts). Validate identity and timing; no fallback, automatic retry, playback manipulation, or partial results.
- Preserve exact timing and bilingual continuation rules. Drafts autosave with stale-write protection; regeneration replaces, export retains. Never persist capture credentials or signed URLs.
- Preview starts without playback. Pinyin fills blank Simplified Chinese values. Export checks playback compatibility; failures preserve data.
- Default reimport refreshes presentation while preserving edits, Card identities, scheduling/history, and unrelated Note Types. Source/tests define details.

## Build and install

Follow [AGENTS.md](../AGENTS.md). Load the extracted build through Chrome's Load unpacked. Native checks used Windows 11 and Anki Desktop 25.09.5.
