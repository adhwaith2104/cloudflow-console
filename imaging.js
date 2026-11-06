/* CloudFlow browser-side image processing (the REAL part of the public demo).
 *
 * Mirrors app/tasks/resize.py (the Lambda worker) where the browser allows:
 * same limits (10 files, 5 MB, 24 megapixels, 16–4096 px), same options
 * (width, height, fit inside|cover, upscale, format jpeg|png|webp), same
 * output naming (`<index>-<stem>.<ext>`), contain-after-clamp and
 * cover-with-centre-crop geometry, and JPEG flattening of transparency onto white.
 *
 * Differences from Pillow (the worker), on purpose or unavoidable:
 *  - Encoders differ: browsers use their own JPEG/PNG/WebP encoders, so byte
 *    sizes differ for the same settings; canvas quality 0.85 is not libjpeg
 *    quality 85; chroma subsampling is the browser's choice; browser PNGs are
 *    always RGBA and larger than the worker's RGB output.
 *  - WebP encoding depends on the browser (Safari cannot); the module then
 *    reports the file as failed with "this browser cannot encode webp".
 *  - Colour: the browser converts wide-gamut inputs (P3, AdobeRGB) to sRGB on
 *    decode, which is the correct rendering; the worker drops ICC profiles
 *    without converting, so its output of such images looks washed out.
 *  - EXIF orientation is applied by the browser during decode
 *    (imageOrientation: "from-image"); no other metadata survives either side.
 *  - Decompression bombs: this module reads the dimensions from the file
 *    header (PNG IHDR, JPEG SOF, WebP VP8/VP8L/VP8X) and refuses anything over
 *    24 MP BEFORE decoding. The first 64 KB is read; a JPEG whose SOF sits
 *    behind larger APP/COM segments is re-read in full (at most 5 MB) and a
 *    file with no readable header is refused as corrupt, so no unknown geometry
 *    ever reaches the decoder. The worker refuses the same images via Pillow's
 *    pixel cap but reports them per file as "unsupported or corrupt image"
 *    (resize.py catches the bomb error with the other decode errors); this
 *    module says "image too large (over 24 megapixels)" because the browser
 *    knows the reason. Whether a browser allocates memory for a header it then
 *    rejects cannot be verified from JavaScript; the pre-check is the guard.
 *  - 16-bit PNG: the browser flattens to 8-bit; Pillow opens 16-bit RGB(A) as
 *    8-bit too but rejects 16-bit greyscale (I;16).
 *  - Geometry that rounds to 0 px (extreme aspect ratios into a tiny box) is a
 *    file failure on both sides ("unsupported or corrupt image").
 *
 * Guarantees for callers: `name` is `[A-Za-z0-9._-]` only; `inputName` and
 * validation names are raw user strings and must be rendered with textContent.
 * processFile calls are serialised, so at most one decoded bitmap exists at a
 * time; canvases are released after encoding; release() revokes object URLs.
 *
 * UMD: plain script in browsers (window.CloudFlowImaging), CommonJS in Node.
 * The pure helpers touch no browser API; nothing touches the DOM at load time.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.CloudFlowImaging = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const LIMITS = Object.freeze({
    maxFiles: 10,
    maxBytes: 5242880,
    maxPixels: 24000000,
    minDim: 16,
    maxDim: 4096,
    headerBytes: 65536,
    types: Object.freeze(["image/jpeg", "image/png", "image/webp"]),
  });

  const FORMATS = Object.freeze({
    jpeg: { ext: "jpg", mime: "image/jpeg" },
    png: { ext: "png", mime: "image/png" },
    webp: { ext: "webp", mime: "image/webp" },
  });

  const QUALITY = 0.85;
  const CORRUPT = "unsupported or corrupt image";
  const TOO_BIG = "image too large (over 24 megapixels)";

  // ---------- pure helpers ----------

  function validateFiles(files) {
    const problems = [];
    const list = Array.from(files || []);
    if (list.length === 0) problems.push({ name: "", error: "no files selected" });
    if (list.length > LIMITS.maxFiles) problems.push({ name: "", error: "too many files (max " + LIMITS.maxFiles + ")" });
    for (const f of list) {
      const p = fileProblem(f);
      if (p) problems.push({ name: f.name, error: p });
    }
    return problems;
  }

  function fileProblem(f) {
    if (!LIMITS.types.includes(f.type)) return "unsupported type (JPEG, PNG or WebP only)";
    if (f.size === 0) return "empty file";
    if (f.size > LIMITS.maxBytes) return "file too large (over 5 MB)";
    return null;
  }

  function validateOptions(o) {
    const dimOk = (v) => Number.isInteger(v) && v >= LIMITS.minDim && v <= LIMITS.maxDim;
    if (!o || !dimOk(o.width) || !dimOk(o.height)) return false;
    const format = o.format === undefined ? "jpeg" : o.format;
    const fit = o.fit === undefined ? "inside" : o.fit;
    const upscale = o.upscale === undefined ? false : o.upscale;
    return !!FORMATS[format] && (fit === "inside" || fit === "cover") && typeof upscale === "boolean";
  }

  // Python's round() is banker's rounding; Math.round differs only on exact .5 ties.
  function pyRound(x) {
    const r = Math.round(x);
    return Math.abs(x % 1) === 0.5 && r % 2 !== 0 ? r - 1 : r;
  }

  // Returns null when the geometry degenerates to 0 px (Pillow raises there too).
  function planResize(srcW, srcH, opts) {
    const o = opts || {};
    let bw = o.width, bh = o.height;
    if (!(srcW > 0 && srcH > 0)) return null;
    if (o.fit === "cover") {
      // ImageOps.fit: scale to fill the box, then crop the centre.
      const scale = Math.max(bw / srcW, bh / srcH);
      const sw = bw / scale, sh = bh / scale;
      return { w: bw, h: bh, sx: (srcW - sw) / 2, sy: (srcH - sh) / 2, sw, sh };
    }
    // ImageOps.contain, after clamping the box to the source unless upscale.
    if (!o.upscale) { bw = Math.min(bw, srcW); bh = Math.min(bh, srcH); }
    let w = bw, h = bh;
    const imRatio = srcW / srcH, destRatio = bw / bh;
    if (imRatio > destRatio) h = pyRound((srcH / srcW) * bw);
    else if (imRatio < destRatio) w = pyRound((srcW / srcH) * bh);
    if (w < 1 || h < 1) return null;
    return { w, h, sx: 0, sy: 0, sw: srcW, sh: srcH };
  }

  function sanitise(name) {
    const base = String(name).split("/").pop();
    const clean = base.replace(/[^A-Za-z0-9._-]/gu, "_").replace(/\.{2,}/g, ".").slice(0, 120);
    return clean || "file";
  }

  function stemOf(name) {
    const stem = name.slice(1).includes(".") ? name.slice(0, name.lastIndexOf(".")) : name;
    return stem || "file";
  }

  function outputName(name, index, format) {
    return index + "-" + stemOf(sanitise(name)) + "." + FORMATS[format].ext;
  }

  function mimeFor(format) {
    return FORMATS[format].mime;
  }

  function summarize(results) {
    const completed = results.filter((r) => r.status === "completed").length;
    return { total: results.length, completed, failed: results.length - completed };
  }

  // Dimensions from the container header, without decoding. Returns {width, height} or null (unknown).
  function headerDimensions(bytes) {
    const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    const n = b.length;
    const u32 = (i) => ((b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]) >>> 0;
    const u16 = (i) => (b[i] << 8) | b[i + 1];
    const u24le = (i) => b[i] | (b[i + 1] << 8) | (b[i + 2] << 16);
    // PNG: signature then IHDR (width, height big-endian)
    if (n >= 24 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 && b[12] === 0x49 && b[13] === 0x48 && b[14] === 0x44 && b[15] === 0x52) {
      return { width: u32(16), height: u32(20) };
    }
    // JPEG: walk the markers to the first SOF (C0..CF except C4, C8, CC)
    if (n >= 4 && b[0] === 0xff && b[1] === 0xd8) {
      let i = 2;
      while (i + 9 < n) {
        if (b[i] !== 0xff) { i++; continue; }
        const marker = b[i + 1];
        if (marker === 0xff) { i++; continue; }
        if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) { i += 2; continue; }
        const len = u16(i + 2);
        if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
          return { height: u16(i + 5), width: u16(i + 7) };
        }
        if (len < 2) return null;
        i += 2 + len;
      }
      return null;
    }
    // WebP: RIFF....WEBP then VP8 / VP8L / VP8X chunk
    if (n >= 30 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) {
      const tag = String.fromCharCode(b[12], b[13], b[14], b[15]);
      if (tag === "VP8 ") return { width: (b[26] | (b[27] << 8)) & 0x3fff, height: (b[28] | (b[29] << 8)) & 0x3fff };
      if (tag === "VP8L") { const bits = b[21] | (b[22] << 8) | (b[23] << 16) | (b[24] << 24); return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 }; }
      if (tag === "VP8X") return { width: u24le(24) + 1, height: u24le(27) + 1 };
    }
    return null;
  }

  // ---------- browser pipeline ----------

  let supportsPromise = null;
  let queue = Promise.resolve(); // serialises processFile so one decoded bitmap exists at a time

  function makeCanvas(w, h) {
    if (typeof OffscreenCanvas !== "undefined") return new OffscreenCanvas(w, h);
    const c = document.createElement("canvas");
    c.width = w; c.height = h;
    return c;
  }

  function releaseCanvas(canvas) {
    try { canvas.width = 0; canvas.height = 0; } catch (e) { /* ignore */ }
  }

  function encodeCanvas(canvas, mime, quality) {
    if (typeof canvas.convertToBlob === "function") return canvas.convertToBlob({ type: mime, quality });
    return new Promise((resolve) => canvas.toBlob(resolve, mime, quality));
  }

  // Lazily detected once, then cached. Async because probing needs a decode and an encode.
  function supports() {
    if (!supportsPromise) {
      supportsPromise = (async () => {
        const out = { decode: typeof createImageBitmap === "function", webpEncode: false, offscreen: typeof OffscreenCanvas !== "undefined", orientation: false };
        try {
          const probeCanvas = makeCanvas(1, 1);
          probeCanvas.getContext("2d"); // a canvas without a context cannot be encoded
          const probe = await encodeCanvas(probeCanvas, "image/webp", QUALITY);
          out.webpEncode = !!probe && probe.type === "image/webp";
          releaseCanvas(probeCanvas);
        } catch (e) { /* stays false */ }
        if (out.decode) {
          try {
            const bmp = await createImageBitmap(new ImageData(1, 1), { imageOrientation: "from-image" });
            bmp.close();
            out.orientation = true; // the option is accepted; whether EXIF is honoured is only provable with a real file
          } catch (e) { /* option rejected: stays false */ }
        }
        return out;
      })();
    }
    return supportsPromise;
  }

  function blankResult(file, index, format) {
    return {
      name: outputName(file.name, index, FORMATS[format] ? format : "jpeg"), inputName: file.name, status: "failed",
      width: 0, height: 0, bytes: 0, blob: null, url: null, inputUrl: null,
      inputWidth: 0, inputHeight: 0, error: null, elapsedMs: 0, orientationApplied: null,
    };
  }

  function processFile(file, options, hooks) {
    const run = queue.then(() => processOne(file, options, hooks));
    queue = run.catch(() => {});
    return run;
  }

  async function processOne(file, options, hooks) {
    const t0 = Date.now();
    const h = hooks || {};
    const o = options || {};
    const format = o.format === undefined ? "jpeg" : o.format;
    const result = blankResult(file, o.index || 0, format);
    const fail = (msg) => { result.error = msg; return result; };
    let bitmap = null, canvas = null;
    try {
      if (!validateOptions(o)) return fail("invalid options");
      const problem = fileProblem(file);           // the module enforces type and size itself
      if (problem) return fail(problem);
      const sup = await supports();
      if (!sup.decode) return fail("this browser cannot decode images");

      // Refuse decompression bombs from the header, before any decode.
      let dims = null;
      try {
        dims = headerDimensions(new Uint8Array(await file.slice(0, LIMITS.headerBytes).arrayBuffer()));
        if (!dims && file.size > LIMITS.headerBytes) {
          // A JPEG can carry large APP/COM segments before its SOF marker; read the whole
          // (at most 5 MB) file rather than hand an unknown geometry to the decoder.
          dims = headerDimensions(new Uint8Array(await file.arrayBuffer()));
        }
      } catch (e) {
        return fail(CORRUPT);
      }
      if (!dims) return fail(CORRUPT);
      if (dims.width * dims.height > LIMITS.maxPixels) return fail(TOO_BIG);

      try {
        bitmap = await createImageBitmap(file, { imageOrientation: sup.orientation ? "from-image" : "none" });
        result.orientationApplied = sup.orientation ? true : null;
      } catch (e) {
        return fail(CORRUPT);
      }
      if (h.onDecoded) h.onDecoded(bitmap);
      result.inputWidth = bitmap.width; result.inputHeight = bitmap.height;
      if (bitmap.width * bitmap.height > LIMITS.maxPixels) return fail(TOO_BIG);

      const plan = planResize(bitmap.width, bitmap.height, { width: o.width, height: o.height, fit: o.fit, upscale: o.upscale });
      if (!plan) return fail(CORRUPT);
      canvas = makeCanvas(plan.w, plan.h);
      const ctx = canvas.getContext("2d");
      if (!ctx) return fail("image too large for this device");
      if (format === "jpeg") { ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, plan.w, plan.h); }
      ctx.imageSmoothingQuality = "high";
      ctx.drawImage(bitmap, plan.sx, plan.sy, plan.sw, plan.sh, 0, 0, plan.w, plan.h);
      bitmap.close(); bitmap = null;                 // nothing else needs the decoded pixels

      const mime = mimeFor(format);
      const blob = await encodeCanvas(canvas, mime, format === "png" ? undefined : QUALITY);
      if (!blob || blob.type !== mime) return fail("this browser cannot encode " + format);

      result.status = "completed";
      result.width = plan.w; result.height = plan.h;
      result.bytes = blob.size; result.blob = blob;
      result.url = URL.createObjectURL(blob);
      result.inputUrl = URL.createObjectURL(file);
      return result;
    } catch (e) {
      return fail(CORRUPT);
    } finally {
      if (bitmap) bitmap.close();
      if (canvas) releaseCanvas(canvas);
      result.elapsedMs = Date.now() - t0;
    }
  }

  async function processFiles(files, options, onProgress) {
    const results = [];
    const list = Array.from(files);
    for (let i = 0; i < list.length; i++) {
      const r = await processFile(list[i], { ...options, index: i });
      results.push(r);
      if (onProgress) onProgress(i + 1, list.length, r);
    }
    return { results, summary: summarize(results) };
  }

  function release(results) {
    for (const r of results) {
      if (r.url) URL.revokeObjectURL(r.url);
      if (r.inputUrl) URL.revokeObjectURL(r.inputUrl);
      r.url = null; r.inputUrl = null; r.blob = null;
    }
  }

  return { LIMITS, validateFiles, validateOptions, planResize, pyRound, headerDimensions, outputName, mimeFor, summarize, processFile, processFiles, release, supports };
});
