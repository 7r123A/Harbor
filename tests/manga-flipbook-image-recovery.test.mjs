import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { Script, createContext } from "node:vm";
import { fileURLToPath } from "node:url";
import path from "node:path";
import ts from "typescript";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = readFileSync(path.join(root, "src/views/manga/manga-reader/flipbook.ts"), "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;

function makeHarness({ responseStatuses = [200] } = {}) {
  const calls = [];
  const bitmapCalls = [];
  let fetchIndex = 0;
  let originals = 0;
  class VendorMain {
    async fetchAndCacheImage() {
      originals++;
      return { from: "original" };
    }
  }
  const module = { exports: {} };
  const window = { FLIPBOOK: { Main: VendorMain } };
  const context = createContext({
    window,
    module,
    exports: module.exports,
    console,
    setTimeout,
    URL,
    Blob,
    createImageBitmap: async (blob, options) => {
      bitmapCalls.push({ blob, options });
      return { from: "native-image", size: blob.size };
    },
    require(name) {
      if (name === "@/lib/safe-fetch") {
        return {
          safeFetchBytes: async (...args) => {
            calls.push(args);
            const status = responseStatuses[Math.min(fetchIndex++, responseStatuses.length - 1)];
            return {
              ok: status === 200,
              status,
              blob: async () => new Blob(["bitmap-data"], { type: "image/png" }),
            };
          },
        };
      }
      if (name === "./image-request-headers") {
        return {
          isBatcaveImageUrl: (value) => {
            try {
              const address = new URL(value);
              return address.protocol === "https:" && address.hostname === "img.batcave.biz";
            } catch {
              return false;
            }
          },
          resolveReaderImageHeaders: () => ({ Referer: "https://batcave.biz/" }),
        };
      }
      throw new Error(`Unexpected import: ${name}`);
    },
  });
  new Script(compiled, { filename: "flipbook.transpiled.js" }).runInContext(context);
  return { guard: module.exports.guardPageLoaded, VendorMain, calls, bitmapCalls,
    get originals() { return originals; } };
}

test("vendor flipbook fetchAndCacheImage uses native recovery for a Batcave page, not global fetch", async () => {
  const h = makeHarness();
  h.guard();
  h.guard(); // patch is idempotent across reader remounts
  const vendor = new h.VendorMain();
  vendor.options = { bitmapResizeHeight: 2048, bitmapResizeQuality: "high" };
  const url = "https://img.batcave.biz/img/38567/273703/1234.jpg?s=signed";
  const [a, b] = await Promise.all([vendor.fetchAndCacheImage(url), vendor.fetchAndCacheImage(url)]);
  assert.equal(a.from, "native-image");
  assert.equal(a, b);
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0][0], url);
  assert.equal(h.calls[0][1].headers.Referer, "https://batcave.biz/");
  assert.equal(h.calls[0][5], true);
  assert.equal(h.bitmapCalls[0].options.resizeHeight, 2048);
  assert.equal(h.bitmapCalls[0].options.resizeQuality, "high");
  assert.equal(h.originals, 0);
  const other = await vendor.fetchAndCacheImage("https://other-source.example/1.jpg");
  assert.equal(other.from, "original");
  assert.equal(h.originals, 1);
});

test("vendor image cache removes rejected 403 so the same page can retry", async () => {
  const h = makeHarness({ responseStatuses: [403, 200] });
  h.guard();
  const vendor = new h.VendorMain();
  const url = "https://img.batcave.biz/img/38567/273703/5678.jpg?s=signed";
  await assert.rejects(vendor.fetchAndCacheImage(url), /Harbor flipbook image recovery failed: HTTP 403/);
  const bitmap = await vendor.fetchAndCacheImage(url);
  assert.equal(bitmap.from, "native-image");
  assert.equal(h.calls.length, 2);
});
