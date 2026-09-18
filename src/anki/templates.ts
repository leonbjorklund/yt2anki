export const NOTE_FIELDS = [
  "SegmentIdentity",
  "VideoId",
  "StartMs",
  "EndMs",
  "Target",
  "Translation",
  "TranslationFirst",
] as const;

export const PINYIN_NOTE_FIELDS = [
  ...NOTE_FIELDS,
  "Pinyin",
  "PinyinUnderTranslation",
] as const;

export const CARD_TEMPLATE_NAME = "Listening";

const PLAYER_SCRIPT = `
<script>
(() => {
  const script = document.currentScript;
  const root = script && script.previousElementSibling;
  if (!root) return;
  const mount = root.querySelector(".yt2anki-player");
  const status = root.querySelector(".yt2anki-status");
  const videoId = root.dataset.videoId;
  const start = Number(root.dataset.startMs) / 1000;
  const end = Number(root.dataset.endMs) / 1000;
  if (typeof window.yt2ankiCleanupPlayer === "function") window.yt2ankiCleanupPlayer();
  let player;
  let disposed = false;
  let segmentFinished = false;
  const blockedMessage = "Autoplay blocked. Press Play in the video.";
  const previousReady = window.onYouTubeIframeAPIReady;
  const active = () => !disposed && root.isConnected;
  const observer = new MutationObserver(() => {
    if (!root.isConnected) cleanup();
  });
  const cleanup = () => {
    if (disposed) return;
    disposed = true;
    observer.disconnect();
    window.removeEventListener("pagehide", cleanup);
    if (window.onYouTubeIframeAPIReady === apiReady) window.onYouTubeIframeAPIReady = previousReady;
    if (window.yt2ankiCleanupPlayer === cleanup) delete window.yt2ankiCleanupPlayer;
    if (player) player.destroy();
  };

  // YouTube exposes no documented captions-off option. Guard the track option
  // so a player API change cannot prevent playback.
  const hideCaptions = () => {
    if (!active() || !player) return;
    try {
      if (!player.getOptions().includes("captions")) return;
      const track = player.getOption("captions", "track");
      if (track && Object.keys(track).length) player.setOption("captions", "track", {});
    } catch (_) {}
  };
  const loadSegment = () => {
    player.loadVideoById({ videoId, startSeconds: start, endSeconds: end });
  };
  const createPlayer = () => {
    if (!active() || player) return;
    player = new YT.Player(mount, {
      height: "100%",
      width: "100%",
      videoId,
      playerVars: {
        autoplay: 1,
        controls: 0,
        disablekb: 0,
        enablejsapi: 1,
        end: Math.ceil(end),
        fs: 0,
        iv_load_policy: 3,
        origin: location.origin,
        playsinline: 1,
        rel: 0,
        start: Math.floor(start)
      },
      events: {
        onReady: (event) => {
          if (!active()) return;
          player = event.target;
          hideCaptions();
          loadSegment();
        },
        onApiChange: hideCaptions,
        onAutoplayBlocked: () => {
          if (active()) status.textContent = blockedMessage;
        },
        onStateChange: (event) => {
          if (!active()) return;
          hideCaptions();
          if (event.data === YT.PlayerState.ENDED) segmentFinished = true;
          if (event.data !== YT.PlayerState.PLAYING) return;
          if (status.textContent === blockedMessage) status.textContent = "";
          if (segmentFinished) {
            segmentFinished = false;
            // Native replay loses the Segment bounds. Do not intercept a
            // recommendation that deliberately changes to another video.
            if (new URL(player.getVideoUrl()).searchParams.get("v") === videoId) loadSegment();
          }
        },
        onError: (event) => {
          if (active()) status.textContent = "Video unavailable (YouTube error " + event.data + ").";
        }
      }
    });
  };
  const apiReady = () => {
    if (typeof previousReady === "function") previousReady();
    createPlayer();
  };
  window.yt2ankiCleanupPlayer = cleanup;
  window.addEventListener("pagehide", cleanup);
  observer.observe(document.body, { childList: true, subtree: true });

  if (window.YT && typeof YT.Player === "function") {
    createPlayer();
  } else {
    window.onYouTubeIframeAPIReady = apiReady;
    if (!document.querySelector('script[src="https://www.youtube.com/iframe_api"]')) {
      const api = document.createElement("script");
      api.src = "https://www.youtube.com/iframe_api";
      document.head.appendChild(api);
    }
  }
})();
</script>`;

function playerMarkup(): string {
  return `<div class="yt2anki-root" data-video-id="{{VideoId}}" data-start-ms="{{StartMs}}" data-end-ms="{{EndMs}}" data-autoplay="true">
  <div class="yt2anki-frame"><div class="yt2anki-player"></div></div>
  <div class="yt2anki-status" role="status"></div>
</div>
${PLAYER_SCRIPT}`;
}

export const QUESTION_TEMPLATE = playerMarkup();

function orderedAnswer(target: string, translation: string): string {
  return `${playerMarkup()}
<div class="yt2anki-answer">
{{#TranslationFirst}}${translation}${target}{{/TranslationFirst}}
{{^TranslationFirst}}${target}${translation}{{/TranslationFirst}}
</div>`;
}

export const ANSWER_TEMPLATE = orderedAnswer(
  '<span class="yt2anki-target">{{Target}}</span>',
  '{{#Translation}}<span class="yt2anki-translation">{{Translation}}</span>{{/Translation}}',
);

export const PINYIN_ANSWER_TEMPLATE = orderedAnswer(
  '<div class="yt2anki-answer-group"><span class="yt2anki-target">{{Target}}</span>{{^PinyinUnderTranslation}}{{#Pinyin}}<span class="yt2anki-pinyin">{{Pinyin}}</span>{{/Pinyin}}{{/PinyinUnderTranslation}}</div>',
  '<div class="yt2anki-answer-group">{{#Translation}}<span class="yt2anki-translation">{{Translation}}</span>{{/Translation}}{{#PinyinUnderTranslation}}{{#Pinyin}}<span class="yt2anki-pinyin">{{Pinyin}}</span>{{/Pinyin}}{{/PinyinUnderTranslation}}</div>',
);

const BASE_CARD_CSS = `
.card, .card * {
  box-sizing: border-box;
  margin: 0;
  padding: 0;
}
.card {
  min-height: 100%;
  padding: 24px 16px;
  overflow-y: auto;
  color: #17191c;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  font-size: clamp(30px, 3.25vw, 34px);
  text-align: center;
}
.yt2anki-root {
  width: min(100%, 760px);
  margin: 0 auto;
}
.yt2anki-frame {
  position: relative;
  width: 100%;
  overflow: hidden;
  border-radius: 10px;
  background: #000;
  aspect-ratio: 16 / 9;
}
.yt2anki-player,
.yt2anki-player iframe {
  width: 100%;
  height: 100%;
}
.yt2anki-status {
  min-height: 24px;
  margin-top: 10px;
  color: #b42318;
  font-size: 14px;
}
.yt2anki-status:empty {
  display: none;
}
.yt2anki-answer {
  width: min(100%, 1020px);
  margin: 20px auto 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 24px;
  font-size: inherit;
  line-height: 1.35;
}`;

const DARK_CARD_CSS = `
.card.nightMode, .nightMode .card, .card.night_mode, .night_mode .card, .night-mode .card {
  color: #f4f5f7;
}
.nightMode .yt2anki-status, .night_mode .yt2anki-status, .night-mode .yt2anki-status {
  color: #fda29b;
}`;

const PINYIN_CARD_CSS_ADDITION = `
.yt2anki-answer-group {
  display: contents;
}
.yt2anki-pinyin {
  color: inherit;
  font-size: inherit;
  line-height: inherit;
  overflow-wrap: anywhere;
}`;

export const CARD_CSS = `${BASE_CARD_CSS}${DARK_CARD_CSS}`;

export const PINYIN_CARD_CSS = `${BASE_CARD_CSS}${PINYIN_CARD_CSS_ADDITION}${DARK_CARD_CSS}`;
