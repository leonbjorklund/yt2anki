import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";
import { inflateSync } from "node:zlib";

const root = resolve(import.meta.dirname, "..");
const iconDirectory = join(root, "src", "icons");
const brand = [250, 92, 115];
const iconSpecs = new Map([
  ["action-16.png", 16],
  ["action-20.png", 20],
  ["action-24.png", 24],
  ["action-32.png", 32],
  ["icon-16.png", 16],
  ["icon-32.png", 32],
  ["icon-48.png", 48],
  ["icon-128.png", 128],
]);

test("release icon assets have the approved files, dimensions, color, and alpha", async () => {
  assert.deepEqual(
    (await readdir(iconDirectory)).sort(),
    [...iconSpecs.keys(), "yt2anki-logo.svg"].sort(),
  );

  for (const [file, expectedSize] of iconSpecs) {
    const image = decodeRgbaPng(await readFile(join(iconDirectory, file)));
    assert.equal(image.width, expectedSize, `${file} width`);
    assert.equal(image.height, expectedSize, `${file} height`);

    const cornerIndexes = [
      0,
      image.width - 1,
      (image.height - 1) * image.width,
      image.width * image.height - 1,
    ];
    for (const index of cornerIndexes) {
      assert.equal(image.pixels[index * 4 + 3], 0, `${file} corner alpha`);
    }

    let hasBrandPixel = false;
    for (let offset = 0; offset < image.pixels.length; offset += 4) {
      const alpha = image.pixels[offset + 3];
      if (
        alpha === 255 &&
        image.pixels[offset] === brand[0] &&
        image.pixels[offset + 1] === brand[1] &&
        image.pixels[offset + 2] === brand[2]
      ) {
        hasBrandPixel = true;
      }
    }
    assert.equal(hasBrandPixel, true, `${file} fixed pink fill`);
  }
});

test("manifest and popup use the release icon set", async () => {
  const [manifestText, svg, popup] = await Promise.all([
    readFile(join(root, "src", "manifest.json"), "utf8"),
    readFile(join(iconDirectory, "yt2anki-logo.svg"), "utf8"),
    readFile(join(root, "src", "popup", "popup.html"), "utf8"),
  ]);
  const manifest = JSON.parse(manifestText);

  assert.deepEqual(manifest.action.default_icon, {
    16: "icons/action-16.png",
    20: "icons/action-20.png",
    24: "icons/action-24.png",
    32: "icons/action-32.png",
  });
  assert.deepEqual(manifest.icons, {
    16: "icons/icon-16.png",
    32: "icons/icon-32.png",
    48: "icons/icon-48.png",
    128: "icons/icon-128.png",
  });
  assert.match(svg, /fill="#fa5c73"/u);
  assert.doesNotMatch(svg, /light-dark\(/u);
  assert.match(
    popup,
    /<img src="\.\.\/icons\/yt2anki-logo\.svg" width="24" height="24" alt="">/u,
  );
});

function decodeRgbaPng(buffer) {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  assert.deepEqual(buffer.subarray(0, signature.length), signature);

  let offset = signature.length;
  let header;
  const imageData = [];
  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString("ascii", offset + 4, offset + 8);
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    if (type === "IHDR") {
      header = data;
    } else if (type === "IDAT") {
      imageData.push(data);
    } else if (type === "IEND") {
      break;
    }
    offset += 12 + length;
  }

  assert.ok(header, "PNG has an IHDR chunk");
  const width = header.readUInt32BE(0);
  const height = header.readUInt32BE(4);
  assert.equal(header[8], 8, "PNG uses 8-bit channels");
  assert.equal(header[9], 6, "PNG uses RGBA color");
  assert.equal(header[10], 0, "PNG compression method");
  assert.equal(header[11], 0, "PNG filter method");
  assert.equal(header[12], 0, "PNG is not interlaced");

  const bytesPerPixel = 4;
  const stride = width * bytesPerPixel;
  const encoded = inflateSync(Buffer.concat(imageData));
  const pixels = Buffer.alloc(width * height * bytesPerPixel);
  let encodedOffset = 0;
  for (let row = 0; row < height; row += 1) {
    const filter = encoded[encodedOffset];
    encodedOffset += 1;
    const rowOffset = row * stride;
    for (let column = 0; column < stride; column += 1) {
      const raw = encoded[encodedOffset];
      encodedOffset += 1;
      const left =
        column >= bytesPerPixel
          ? pixels[rowOffset + column - bytesPerPixel]
          : 0;
      const above = row > 0 ? pixels[rowOffset + column - stride] : 0;
      const upperLeft =
        row > 0 && column >= bytesPerPixel
          ? pixels[rowOffset + column - stride - bytesPerPixel]
          : 0;
      pixels[rowOffset + column] = applyPngFilter(
        filter,
        raw,
        left,
        above,
        upperLeft,
      );
    }
  }
  assert.equal(encodedOffset, encoded.length, "PNG scanline length");
  return { height, pixels, width };
}

function applyPngFilter(filter, raw, left, above, upperLeft) {
  if (filter === 0) {
    return raw;
  }
  if (filter === 1) {
    return (raw + left) & 0xff;
  }
  if (filter === 2) {
    return (raw + above) & 0xff;
  }
  if (filter === 3) {
    return (raw + Math.floor((left + above) / 2)) & 0xff;
  }
  if (filter === 4) {
    return (raw + paethPredictor(left, above, upperLeft)) & 0xff;
  }
  throw new Error(`Unsupported PNG filter ${filter}`);
}

function paethPredictor(left, above, upperLeft) {
  const estimate = left + above - upperLeft;
  const leftDistance = Math.abs(estimate - left);
  const aboveDistance = Math.abs(estimate - above);
  const upperLeftDistance = Math.abs(estimate - upperLeft);
  if (leftDistance <= aboveDistance && leftDistance <= upperLeftDistance) {
    return left;
  }
  if (aboveDistance <= upperLeftDistance) {
    return above;
  }
  return upperLeft;
}
