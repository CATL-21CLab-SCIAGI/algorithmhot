// Source icons: which icon a home page's declarations yield first, and favicon.ico files read into
// something the image proxy can resize (PNG entries as they are, 32-bit bitmaps as RGBA).
import "./setup.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import sharp from "sharp";
import { iconCandidates } from "@aihot/backend/sources/icons";
import { decodeIco } from "@aihot/backend/media/images";

test("touch icons and large icons come before small ones and favicon.ico", () => {
  const html = `<head>
    <link rel="shortcut icon" href="/favicon.ico">
    <link rel="icon" type="image/png" sizes="32x32" href="/icons/32.png">
    <link rel="icon" type="image/png" sizes="192x192" href="https://cdn.example.org/192.png">
    <link rel="apple-touch-icon" href="/apple-touch-icon.png">
    <link rel="stylesheet" href="/site.css">
  </head>`;
  assert.deepEqual(iconCandidates(html, "https://example.org/blog/"), [
    "https://example.org/apple-touch-icon.png",
    "https://cdn.example.org/192.png",
    "https://example.org/icons/32.png",
    "https://example.org/favicon.ico",
  ]);
  assert.deepEqual(iconCandidates("<html></html>", "https://example.org/"), ["https://example.org/favicon.ico"]);
});

function icoWith(entries: Array<{ size: number; data: Buffer }>): Buffer {
  const head = Buffer.alloc(6 + entries.length * 16);
  head.writeUInt16LE(1, 2);
  head.writeUInt16LE(entries.length, 4);
  let offset = head.length;
  entries.forEach((e, i) => {
    const at = 6 + i * 16;
    head[at] = e.size;
    head[at + 1] = e.size;
    head.writeUInt32LE(e.data.length, at + 8);
    head.writeUInt32LE(offset, at + 12);
    offset += e.data.length;
  });
  return Buffer.concat([head, ...entries.map((e) => e.data)]);
}

test("favicon.ico: the largest entry, PNG or 32-bit bitmap", async () => {
  const png = await sharp({ create: { width: 48, height: 48, channels: 4, background: "#176b75" } }).png().toBuffer();
  // A 2×2 32-bit bitmap, bottom row first: red, green / blue, white.
  const dib = Buffer.alloc(40 + 16);
  dib.writeUInt32LE(40, 0);
  dib.writeInt32LE(2, 4);
  dib.writeInt32LE(4, 8);
  dib.writeUInt16LE(1, 12);
  dib.writeUInt16LE(32, 14);
  Buffer.from([0, 0, 255, 255, 0, 255, 0, 255, 255, 0, 0, 255, 255, 255, 255, 255]).copy(dib, 40);

  const fromPng = decodeIco(icoWith([{ size: 2, data: dib }, { size: 48, data: png }]));
  assert.ok(Buffer.isBuffer(fromPng));
  assert.equal((await sharp(fromPng).metadata()).width, 48);

  const fromBmp = decodeIco(icoWith([{ size: 2, data: dib }]));
  assert.ok(fromBmp && !Buffer.isBuffer(fromBmp));
  assert.equal(fromBmp.width, 2);
  assert.equal(fromBmp.height, 2);
  // Top row is the last one stored: blue then white, as RGBA.
  assert.deepEqual([...fromBmp.raw.subarray(0, 8)], [0, 0, 255, 255, 255, 255, 255, 255]);

  assert.equal(decodeIco(png), null);
});
