import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import {
  ANSWER_TEMPLATE,
  PINYIN_ANSWER_TEMPLATE,
  QUESTION_TEMPLATE,
} from "../src/anki/templates.ts";

function playerHarness({ ready = true, synchronousReady = false } = {}) {
  const players = [];
  const observers = [];
  const scripts = [];
  const listeners = new Map();
  const document = {
    body: {},
    head: { appendChild: (script) => scripts.push(script) },
    createElement: () => ({}),
    querySelector: () => scripts[0] ?? null,
  };
  const YT = {
    PlayerState: { ENDED: 0, PLAYING: 1, PAUSED: 2, BUFFERING: 3 },
    Player: function Player(_mount, options) {
      this.options = options;
      this.loads = [];
      this.track = { languageCode: "en" };
      this.modules = ["captions"];
      this.captionChanges = 0;
      this.destroyed = false;
      this.videoUrl = `https://www.youtube.com/watch?v=${options.videoId}`;
      this.getOptions = () => this.modules;
      this.getOption = () => this.track;
      this.setOption = (module, option, value) => {
        assert.equal(module, "captions");
        assert.equal(option, "track");
        this.track = value;
        this.captionChanges++;
      };
      this.getVideoUrl = () => this.videoUrl;
      this.loadVideoById = (bounds) => this.loads.push({ ...bounds });
      this.destroy = () => {
        this.destroyed = true;
      };
      this.fire = (name, data) => options.events[name]({ target: this, data });
      players.push(this);
      if (synchronousReady) this.fire("onReady");
    },
  };
  const window = {
    addEventListener: (event, handler) => listeners.set(event, handler),
    removeEventListener: (event, handler) => {
      if (listeners.get(event) === handler) listeners.delete(event);
    },
  };
  const context = vm.createContext({
    window,
    document,
    URL,
    location: { origin: "http://127.0.0.1:8765" },
    MutationObserver: class {
      constructor(callback) {
        this.callback = callback;
        this.disconnected = false;
        observers.push(this);
      }
      observe() {}
      disconnect() {
        this.disconnected = true;
      }
    },
  });
  const loadApi = () => {
    window.YT = YT;
    context.YT = YT;
  };
  if (ready) loadApi();
  return {
    window,
    players,
    observers,
    scripts,
    listeners,
    loadApi,
    render(template = QUESTION_TEMPLATE, startMs = "844250", endMs = "848250") {
      const status = { textContent: "" };
      const root = {
        isConnected: true,
        dataset: { videoId: "hyDEIdq42cw", startMs, endMs },
        querySelector: (selector) =>
          selector === ".yt2anki-status" ? status : {},
      };
      document.currentScript = { previousElementSibling: root };
      vm.runInContext(
        template.match(/<script>([\s\S]*?)<\/script>/u)[1],
        context,
      );
      return { root, status };
    },
  };
}

for (const [side, template] of [
  ["front", QUESTION_TEMPLATE],
  ["back", ANSWER_TEMPLATE],
  ["Pinyin back", PINYIN_ANSWER_TEMPLATE],
]) {
  test(`${side} autoplays fractional bounds and restores them on repeated native replay`, () => {
    const harness = playerHarness();
    harness.render(template);
    const player = harness.players[0];
    player.fire("onReady");
    const expected = {
      videoId: "hyDEIdq42cw",
      startSeconds: 844.25,
      endSeconds: 848.25,
    };
    assert.deepEqual(player.loads[0], expected);
    assert.equal(player.options.playerVars.autoplay, 1);
    assert.equal(player.options.playerVars.controls, 0);
    assert.equal(player.options.playerVars.fs, 0);
    assert.equal(player.options.playerVars.iv_load_policy, 3);
    assert.equal(player.options.playerVars.origin, "http://127.0.0.1:8765");
    for (let replay = 0; replay < 2; replay++) {
      player.fire("onStateChange", 0);
      assert.equal(player.loads.length, replay + 1, "ending must not loop");
      player.fire("onStateChange", 3);
      player.fire("onStateChange", 1);
      assert.deepEqual(player.loads[replay + 1], expected);
      player.fire("onStateChange", 1);
      assert.equal(player.loads.length, replay + 2);
    }
    player.fire("onStateChange", 2);
    player.fire("onStateChange", 1);
    assert.equal(player.loads.length, 3, "pause/resume must not restart");
  });
}

test("starts at zero and supports a synchronous ready event", () => {
  const harness = playerHarness({ synchronousReady: true });
  harness.render(QUESTION_TEMPLATE, "0", "4250");
  assert.deepEqual(harness.players[0].loads, [
    { videoId: "hyDEIdq42cw", startSeconds: 0, endSeconds: 4.25 },
  ]);
});

test("suppresses captions when the module loads late or reappears during playback", () => {
  const harness = playerHarness();
  harness.render();
  const player = harness.players[0];
  player.modules = [];
  player.fire("onReady");
  assert.equal(player.captionChanges, 0);
  player.modules = ["captions"];
  player.fire("onApiChange");
  assert.equal(player.captionChanges, 1);
  player.fire("onApiChange");
  assert.equal(
    player.captionChanges,
    1,
    "do not repeatedly reset an empty track",
  );
  player.track = { languageCode: "zh" };
  player.fire("onStateChange", 1);
  assert.equal(player.captionChanges, 2);
});

test("caption API failures do not prevent bounded playback", () => {
  const harness = playerHarness();
  harness.render();
  const player = harness.players[0];
  player.getOptions = () => {
    throw new Error("unavailable caption module");
  };
  player.fire("onReady");
  assert.equal(player.loads.length, 1);
  player.fire("onStateChange", 0);
  player.fire("onStateChange", 1);
  assert.equal(player.loads.length, 2);
});

test("reports blocked autoplay and clears it after manual play without hiding video errors", () => {
  const harness = playerHarness();
  const { status } = harness.render();
  const player = harness.players[0];
  player.fire("onAutoplayBlocked");
  assert.equal(
    status.textContent,
    "Autoplay blocked. Press Play in the video.",
  );
  player.fire("onStateChange", 1);
  assert.equal(status.textContent, "");
  player.fire("onError", 150);
  player.fire("onStateChange", 1);
  assert.equal(status.textContent, "Video unavailable (YouTube error 150).");
});

test("does not override a related video selected after completion", () => {
  const harness = playerHarness();
  harness.render();
  const player = harness.players[0];
  player.fire("onReady");
  player.fire("onStateChange", 0);
  player.videoUrl = "https://www.youtube.com/watch?v=APv9hfjYRY0";
  player.fire("onStateChange", 1);
  assert.equal(player.loads.length, 1);
});

test("flipping cards destroys the old player and ignores its late callbacks", () => {
  const harness = playerHarness();
  const old = harness.render();
  const player = harness.players[0];
  harness.render(ANSWER_TEMPLATE);
  assert.equal(player.destroyed, true);
  assert.equal(harness.observers[0].disconnected, true);
  player.fire("onReady");
  player.fire("onAutoplayBlocked");
  player.fire("onError", 150);
  assert.equal(old.status.textContent, "");
  assert.equal(player.loads.length, 0);
  harness.players[1].fire("onReady");
  assert.equal(harness.players[1].loads.length, 1);
});

test("removing a card or leaving the reviewer cleans up the player", () => {
  for (const remove of [true, false]) {
    const harness = playerHarness();
    const { root } = harness.render();
    if (remove) {
      root.isConnected = false;
      harness.observers[0].callback();
    } else {
      harness.listeners.get("pagehide")();
    }
    assert.equal(harness.players[0].destroyed, true);
    assert.equal(harness.listeners.size, 0);
    assert.equal(harness.window.yt2ankiCleanupPlayer, undefined);
  }
});

test("a delayed YouTube API creates only the current card player", () => {
  const harness = playerHarness({ ready: false });
  let previousCalls = 0;
  harness.window.onYouTubeIframeAPIReady = () => previousCalls++;
  harness.render();
  const staleReady = harness.window.onYouTubeIframeAPIReady;
  harness.render(ANSWER_TEMPLATE);
  assert.equal(harness.scripts.length, 1);
  harness.loadApi();
  staleReady();
  assert.equal(harness.players.length, 0);
  harness.window.onYouTubeIframeAPIReady();
  harness.window.onYouTubeIframeAPIReady();
  assert.equal(harness.players.length, 1);
  assert.equal(previousCalls, 3);
});
