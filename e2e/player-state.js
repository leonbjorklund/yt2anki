import { expect } from "@playwright/test";

export async function readPlayerState(page) {
  return page.evaluate(() => {
    const player = document.getElementById("movie_player");
    let track = null;
    try {
      track = player?.getOption?.("captions", "track") ?? null;
    } catch {}
    const hasTrackIdentity = Boolean(
      track?.languageCode || track?.vss_id || track?.vssId,
    );
    return {
      captionTrack: hasTrackIdentity
        ? {
            languageCode: track.languageCode ?? null,
            vssId: track.vss_id ?? track.vssId ?? null,
          }
        : null,
      currentTime: Number(player?.getCurrentTime?.() ?? 0),
      playerState: Number(player?.getPlayerState?.() ?? -1),
    };
  });
}

export async function waitForPlayerReady(page) {
  await page.waitForFunction(
    () => {
      const player = document.getElementById("movie_player");
      const response = player?.getPlayerResponse?.();
      const state = Number(player?.getPlayerState?.() ?? -1);
      return (
        response?.captions?.playerCaptionsTracklistRenderer?.captionTracks
          ?.length > 0 &&
        (state === 2 || state === 5)
      );
    },
    undefined,
    { timeout: 30_000 },
  );

  const deadline = Date.now() + 30_000;
  let previous = await readPlayerState(page);
  let stableSince = Date.now();
  while (Date.now() < deadline) {
    await page.waitForTimeout(200);
    const current = await readPlayerState(page);
    const sameState = current.playerState === previous.playerState;
    const sameTrack =
      JSON.stringify(current.captionTrack) ===
      JSON.stringify(previous.captionTrack);
    if (sameState && sameTrack) {
      if (Date.now() - stableSince >= 800) return current;
    } else {
      previous = current;
      stableSince = Date.now();
    }
  }
  throw new Error("YouTube player state did not settle");
}

export function assertPlayerStatePreserved(before, after, elapsedMs) {
  const wasPlaying = before.playerState === 1;
  expect(after.playerState === 1).toBe(wasPlaying);
  expect(after.captionTrack).toEqual(before.captionTrack);

  const timeDelta = after.currentTime - before.currentTime;
  if (wasPlaying) {
    expect(timeDelta).toBeGreaterThanOrEqual(-0.25);
    expect(timeDelta).toBeLessThanOrEqual(elapsedMs / 1_000 + 0.75);
  } else {
    expect(Math.abs(timeDelta)).toBeLessThan(0.5);
  }
}
