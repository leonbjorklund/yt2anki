export const NOTE_FIELDS = [
  "SegmentIdentity",
  "VideoId",
  "StartMs",
  "EndMs",
  "Target",
  "Translation",
] as const;

export const CARD_TEMPLATE_NAME = "Listening";

const PLAYER_SCRIPT = String.raw`
<script>
(() => {
  const script = document.currentScript;
  const root = script && script.previousElementSibling;
  if (!root) return;
  const mount = root.querySelector(".yt2anki-player");
  const play = root.querySelector(".yt2anki-play");
  const status = root.querySelector(".yt2anki-status");
  const videoId = root.dataset.videoId;
  const start = Number(root.dataset.startMs) / 1000;
  const end = Number(root.dataset.endMs) / 1000;
  const autoplay = root.dataset.autoplay === "true";
  let player;
  let timer;

  const showPlay = () => play.classList.remove("yt2anki-hidden");
  const hidePlay = () => play.classList.add("yt2anki-hidden");
  const setStatus = (text) => { status.textContent = text; };
  const stopAtEnd = () => {
    if (!player || typeof player.getCurrentTime !== "function") return;
    if (player.getCurrentTime() >= end - 0.05) {
      player.pauseVideo();
      showPlay();
    }
  };
  const replay = () => {
    if (!player) return;
    setStatus("");
    player.seekTo(start, true);
    player.playVideo();
    hidePlay();
  };
  play.addEventListener("click", replay);

  const createPlayer = () => {
    player = new YT.Player(mount, {
      height: "100%",
      width: "100%",
      videoId,
      playerVars: {
        controls: 1,
        disablekb: 0,
        enablejsapi: 1,
        end: Math.ceil(end),
        playsinline: 1,
        rel: 0,
        start: Math.floor(start)
      },
      events: {
        onReady: () => {
          if (autoplay) {
            player.loadVideoById({ videoId, startSeconds: start, endSeconds: end });
            hidePlay();
            setTimeout(() => {
              if (player.getPlayerState() !== YT.PlayerState.PLAYING) showPlay();
            }, 1200);
          } else {
            player.cueVideoById({ videoId, startSeconds: start, endSeconds: end });
            player.seekTo(start, true);
            player.pauseVideo();
            showPlay();
          }
          timer = setInterval(stopAtEnd, 100);
        },
        onStateChange: (event) => {
          if (
            event.data === YT.PlayerState.ENDED ||
            event.data === YT.PlayerState.PAUSED
          ) showPlay();
        },
        onError: (event) => {
          clearInterval(timer);
          showPlay();
          setStatus("Video unavailable (YouTube error " + event.data + ").");
        }
      }
    });
  };

  if (window.YT && typeof YT.Player === "function") {
    createPlayer();
  } else {
    const previous = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => {
      if (typeof previous === "function") previous();
      createPlayer();
    };
    if (!document.querySelector('script[src="https://www.youtube.com/iframe_api"]')) {
      const api = document.createElement("script");
      api.src = "https://www.youtube.com/iframe_api";
      document.head.appendChild(api);
    }
  }
})();
</script>`;

function playerMarkup(autoplay: boolean): string {
  return String.raw`<div class="yt2anki-root" data-video-id="{{VideoId}}" data-start-ms="{{StartMs}}" data-end-ms="{{EndMs}}" data-autoplay="${autoplay}">
  <div class="yt2anki-frame"><div class="yt2anki-player"></div></div>
  <button class="yt2anki-play${autoplay ? " yt2anki-hidden" : ""}" type="button">Play</button>
  <div class="yt2anki-status" role="status"></div>
</div>
${PLAYER_SCRIPT}`;
}

export const QUESTION_TEMPLATE = playerMarkup(true);

export const ANSWER_TEMPLATE = `${playerMarkup(false)}
<div class="yt2anki-answer">
  <div class="yt2anki-target">{{Target}}</div>
  <div class="yt2anki-translation">{{Translation}}</div>
</div>`;

export const CARD_CSS = String.raw`
.card {
  box-sizing: border-box;
  margin: 0;
  padding: 20px;
  color: #17191c;
  background: #f6f7f8;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
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
.yt2anki-play {
  min-width: 150px;
  min-height: 52px;
  margin: 18px auto 0;
  padding: 0 24px;
  border: 0;
  border-radius: 10px;
  color: #fff;
  background: #2563eb;
  font: inherit;
  font-size: 20px;
  font-weight: 700;
  cursor: pointer;
}
.yt2anki-hidden {
  visibility: hidden;
}
.yt2anki-status {
  min-height: 24px;
  margin-top: 10px;
  color: #b42318;
  font-size: 14px;
}
.yt2anki-answer {
  width: min(100%, 760px);
  margin: 22px auto 0;
  text-align: left;
}
.yt2anki-target {
  font-size: 28px;
  line-height: 1.45;
}
.yt2anki-translation {
  margin-top: 12px;
  color: #555d68;
  font-size: 21px;
  line-height: 1.45;
}
@media (prefers-color-scheme: dark) {
  .card {
    color: #f4f5f7;
    background: #15171a;
  }
  .yt2anki-translation {
    color: #b7bec8;
  }
  .yt2anki-play {
    background: #3b82f6;
  }
  .yt2anki-status {
    color: #fda29b;
  }
}`;
