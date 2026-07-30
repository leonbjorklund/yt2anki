import assert from "node:assert/strict";
import test from "node:test";
import { translateMissingSegments } from "../src/gemini.ts";

test("accepts exact structured Gemini batches and preserves IDs", async (t) => {
  const accepted = [];
  t.mock.method(globalThis, "fetch", async (_url, init) => {
    const request = JSON.parse(init.body);
    const items = JSON.parse(
      request.contents[0].parts[0].text.split("\n").at(-1),
    );
    return Response.json({
      candidates: [
        {
          content: {
            parts: [
              {
                text: JSON.stringify({
                  translations: items.map(({ id }, index) => ({
                    id,
                    translation: `Translation ${index + 1}`,
                  })),
                }),
              },
            ],
          },
          finishReason: "STOP",
        },
      ],
    });
  });

  await translateMissingSegments({
    apiKey: "test-only",
    nativeLocale: "en-GB",
    onBatch: async (batch) => accepted.push(...batch),
    segments: [segment("v1_a", "你好。"), segment("v1_b", "再见。")],
    targetLocale: "zh-Hans",
  });
  assert.deepEqual(accepted, [
    { id: "v1_a", translation: "Translation 1" },
    { id: "v1_b", translation: "Translation 2" },
  ]);
});

test("rejects missing or changed Segment IDs", async (t) => {
  t.mock.method(globalThis, "fetch", async () =>
    Response.json({
      candidates: [
        {
          content: {
            parts: [
              {
                text: JSON.stringify({
                  translations: [
                    { id: "wrong", translation: "Wrong" },
                  ],
                }),
              },
            ],
          },
        },
      ],
    }),
  );

  await assert.rejects(
    translateMissingSegments({
      apiKey: "test-only",
      nativeLocale: "en-GB",
      onBatch: async () => {},
      segments: [segment("v1_a", "你好。")],
      targetLocale: "zh-Hans",
    }),
    /invalid Segment IDs/u,
  );
});

test("preserves successful batches and retries only missing IDs", async (t) => {
  const segments = Array.from({ length: 31 }, (_value, index) =>
    segment(`v1_${index}`, `Caption ${index}`),
  );
  const requestedIds = [];
  let requestCount = 0;
  t.mock.method(globalThis, "fetch", async (_url, init) => {
    requestCount += 1;
    const request = JSON.parse(init.body);
    const items = JSON.parse(
      request.contents[0].parts[0].text.split("\n").at(-1),
    );
    requestedIds.push(items.map(({ id }) => id));
    if (requestCount === 2) {
      return Response.json({}, { status: 500 });
    }
    return Response.json({
      candidates: [
        {
          content: {
            parts: [
              {
                text: JSON.stringify({
                  translations: items.map(({ id }) => ({
                    id,
                    translation: `Translated ${id}`,
                  })),
                }),
              },
            ],
          },
        },
      ],
    });
  });

  const input = {
    apiKey: "test-only",
    nativeLocale: "en-GB",
    onBatch: async (batch) => {
      for (const item of batch) {
        segments.find(({ identity }) => identity === item.id).translation =
          item.translation;
      }
    },
    segments,
    targetLocale: "zh-Hans",
  };

  await assert.rejects(translateMissingSegments(input), /HTTP 500/u);
  assert.equal(
    segments.filter(({ translation }) => translation).length,
    30,
  );
  await translateMissingSegments(input);
  assert.deepEqual(requestedIds.map((ids) => ids.length), [30, 1, 1]);
  assert.deepEqual(requestedIds[2], ["v1_30"]);
});

function segment(identity, target) {
  return {
    alignmentQuality: "missing",
    endMs: 2_000,
    identity,
    selected: true,
    sourceEndMs: 2_000,
    sourceStartMs: 0,
    startMs: 0,
    target,
    translation: "",
  };
}
