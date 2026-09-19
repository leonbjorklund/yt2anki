# Agent rules

Read README.md and CONTEXT.md. Product changes require an approved design and implementation plan. Keep documentation minimal; state each rule once.

## Product contract

- One or two Standard Caption Tracks become editable Anki listening cards; video stays on YouTube.
- Preserve exact timing and bilingual continuation rules. Drafts autosave with stale-write protection; regeneration replaces, export retains. Never persist capture credentials or signed URLs.
- Preview starts without playback. Pinyin fills blank Simplified Chinese values. Export checks playback compatibility; failures preserve data.

## Capture

- Preserve the pinned VISIONOS/JSON3 route in `src/capture/main.ts`. Validate identity and timing; no fallback, automatic retry, playback manipulation, or partial results. Fallbacks need approval and a product contract change. Check maintained upstream implementations when YouTube/client behavior changes.
- Live gate: `pnpm test:e2e:caption-gate`, through `playwright.caption-gate.config.mjs` only. Run once in disposable Chromium when capture dependencies change or live acceptance is required, never routinely or in CI. Stop at the first failure, including HTTP 429.

## Verification

- Node.js 24+; `pnpm install --frozen-lockfile`.
- Ordinary checks: `pnpm verify`. Workflow guards: `pnpm test:tooling`. Non-live browser checks: `pnpm test:e2e`. Dependencies: `pnpm audit --prod`.
- Automated profiles, builds, packages, screenshots, browser state, and Anki bases must be disposable; remove after recording results.
- Only approved `pnpm verify:handoff` or the guarded check below may write root `dist`.
- After Anki changes, verify default reimport refreshes presentation while preserving Note edits, Card identities, scheduling/history, and unrelated Note Types. Source/tests define details.
- Review dependency upgrades separately; out-of-range `ankipack` upgrades also require behavior and notice review.

## Owner check

Only the exact message `run` triggers `pnpm test:manual -- --label "<current check>"`. Reuse its dedicated profile and Chrome's last-used selection; never force Default. If new or missing, run `pnpm test:manual:setup` once for the owner's permission step. No substitute launches or reloads.

Preserve `.tmp/manual-chrome-profile`; never inspect, clean, copy, commit, or automate its stored data. Never test against the owner's normal Chrome profile or installed Anki collection. The command does not contact Anki; the owner removes leftover Video Decks. After launch, report only the popup heading and behavior to check.

## Approvals

Stable builds, visible window control, real Anki interaction, publication, commits, pushes, and releases each require approval. Before visible control, name the window and effect, then wait.
