# Browser GCode Generator

A standalone, **in-browser** depth-map PNG &rarr; GRBL GCode raster generator.
It runs directly from `web/index.html` on the `file://` protocol — no server,
no build step, no external dependencies, and no network access. Everything
(PNG decoding, safe-surface math, toolpath generation, and `.nc` file
creation) happens client-side in plain JavaScript.

## Quick start

1. Open `web/index.html` directly in **Chrome** (double-click it, or drag it
   into a Chrome window — the URL bar will show `file:///.../web/index.html`).
2. **Load an image**: use the file picker to choose a grayscale (or
   grayscale+alpha) PNG depth map. Black = one extreme of the surface, white =
   the other; alpha (if present) marks pixels to skip (transparent = no
   material / not cut).
3. **Set the scale**: choose pixels/mm, physical width, or physical height,
   and enter the value. The derived `pixelSizeMm` and physical size are shown.
4. **Set the depth**: pick a zero mode (see below), then enter the black/white
   Z values, stock top (bed mode only), and safe Z (rapid height).
5. **Choose zero mode and origin**:
   - Zero mode `bed`: Z=0 is the machine bed, positive up. You enter *heights
     above bed* for black/white.
   - Zero mode `stockTop`: Z=0 is the top of stock, cuts go negative. You
     enter *depths below the top* (positive numbers) for black/white.
   - Origin `center`: X0/Y0 is the center of the image.
   - Origin `lowerLeft`: X0/Y0 is the lower-left corner of the image.
6. **Edit tools and passes**: the app starts with a default flat roughing tool
   + ball finishing tool and a matching two-pass job (rough then finish). Add,
   remove, reorder, or edit any row — every field is editable, including
   which tool a pass uses, its direction (left-to-right / right-to-left /
   zigzag), stepover, max stepdown, and allowance (stock left after that
   pass; `0` = finishing depth).
7. Fix any validation errors shown under **Generate** (the button is disabled
   until the config is valid); warnings are informational and don't block
   generation.
8. Click **Generate**. With direct file streaming enabled in Chrome, pick an
   output folder/file before generation starts; GCode is then written in
   chunks as the worker generates it. If direct streaming is unavailable or
   disabled, download links are built from streamed chunks in memory.
9. Load the saved/downloaded `.nc` file(s) into your GRBL sender of choice.

## Saving settings

Everything except the loaded image — scale, depth, zero/origin, and the full
tools & passes tables — is remembered for you:

- **Auto-save**: any change is saved to the browser's `localStorage` and
  automatically restored the next time you open the page. Under `file://` this
  works in Chrome but is best-effort (it's per-file-origin and can be cleared
  by the browser); if storage is unavailable the Settings panel says so and
  auto-save is simply skipped.
- **Export to file**: downloads a `gcode-settings.json` you can back up or share.
- **Import from file**: loads a previously exported `.json` and applies it.
- **Reset to defaults**: restores the built-in flat-rough + ball-finish setup.

For durable, portable settings (across machines, browsers, or `file://`
quirks), use **Export** — `localStorage` is a convenience, not a guarantee.

## How it works (brief)

- **Image decoding**: the PNG signature and IHDR are parsed by hand. If the
  file is 16-bit grayscale or grayscale+alpha (`bitDepth=16`,
  `colorType` 0 or 4), it's decoded at full 16-bit precision using a small
  pure-JS zlib/DEFLATE inflate and PNG scanline unfilter implemented in
  `app.js` — no Canvas involved, so no precision is lost to an 8-bit
  round-trip. Everything else (8-bit, RGB, palette, RGBA) falls back to
  drawing the image onto an offscreen `<canvas>` and reading `getImageData`,
  converting to grayscale via Rec. 709 luminance. The decoded-image badge
  shows which path was used ("16-bit precision" or "8-bit (Canvas)").
- **Depth mapping**: each pixel's normalized gray value (0=black, 1=white) is
  mapped linearly to a machine Z between the entered black/white values.
  Transparent pixels (alpha=0, if the image has an alpha channel) are treated
  as "no material" and are never cut.
- **Tool-safe surface**: for each tool, the depth-mapped surface is dilated by
  the tool's inverted bottom profile (a flat disk, or a ball's spherical dome)
  so the *tool center* never plunges the tool body below the surface anywhere
  under its footprint. This is the most expensive computation and runs in a Web
  Worker, off the main thread, with progress messages.
- **Multi-sweep depth stepping + remaining-material tracking**: a single
  `remaining`-material array is shared across all enabled passes, in order.
  Each pass repeats full-surface sweeps — removing at most the tool's max
  stepdown per sweep — until it reaches its target (the safe surface plus its
  allowance), so a later finishing pass sees exactly what an earlier roughing
  pass left behind rather than the raw surface.
- **Raster toolpaths**: rows are cut bottom-to-top (in image space) at the
  pass's stepover spacing; within each row, contiguous cut-pixel runs
  ("spans") are cut left-to-right, right-to-left, or alternating (zigzag),
  evaluating one sample per pixel so Z follows the surface smoothly. Flat
  same-Z runs are emitted as endpoint moves instead of one redundant `X` line
  per pixel. In left-to-right and right-to-left rasters, transparent gaps are
  skipped with a retract + rapid; zigzag links rows/spans with feed-rate `G1`
  moves and uses `G0` only for upward Z-only raises.
- **GCode**: `G90`/`G21`/`G17` + `M3 S<rpm>` preamble, one `.nc` file per
  enabled pass with a descriptive comment header (image, scale, zero/origin,
  tool, pass settings), commanded Z range / sweep summaries, an explicit first
  motion of `G0 Z<safeZ>` before any XY move, and a `G0 Z<safeZ>` / `M5` /
  `M2` footer. Modal `X`, `Y`, `Z`, and `F` words are omitted when unchanged.
  No `M0` (pause) is ever emitted.

## `file://` caveats and browser support

- **Designed and tested for Chrome.** The `file://` restrictions this app
  works around (blocked ES module loading, blocked `new Worker('worker.js')`)
  are Chrome-specific quirks; other browsers may behave differently (better or
  worse) under `file://`, but only Chrome is a supported target.
- The Web Worker is built from an **inline Blob**
  (`new Worker(URL.createObjectURL(blob))`) rather than loaded from a
  `worker.js` file, specifically because Chrome blocks `new Worker(url)` for
  same-origin script files under `file://`. This keeps the whole app working
  with zero server.
- No `fetch`, `XMLHttpRequest`, ES module `import`, service workers, or CDN
  scripts are used anywhere — the app makes no network requests at all, ever.
- Direct-to-file output uses Chrome's File System Access API. Multi-pass jobs
  choose an output directory once, then write one `.nc` file per enabled pass.
  If the API is unavailable, the app falls back to normal download links.
- If you edit `app.js` and don't see changes reflected, do a hard reload
  (Chrome can cache `file://` scripts) rather than assuming something is
  broken.

## Limitations / non-goals

This is a general raster depth-map-to-GCode tool, not a port of any specific
project's fixed workflow. Explicitly out of scope for this version:

- **Raster toolpaths only** — no contour/outline-groove pass (no polygon
  offsetting), no vector/outline strategies.
- **No arc smoothing** — all cutting moves are straight `G1` line segments
  (no `G2`/`G3` fitting or path simplification).
- **No time estimates** in the GCode headers.
- **No sampled row-to-row travel-height optimization** — non-zigzag row/span
  travel retracts to the full `safeZ`, even when a lower travel height would
  be safe. Zigzag links at the higher adjacent cut Z instead of sampling a
  separate clearance surface.
- **No metadata sidecar file** reading/writing.
- A **flat tool larger than a feature simply rides over it** without cutting
  the interior detail — this is the physically correct behavior for that
  tool/feature combination, not a bug.
- **Large images and fine stepovers can produce very large `.nc` files and
  long generation times.** Safe-surface computation and multi-sweep GCode
  generation run in a Web Worker, and output is streamed in chunks instead of
  returned as one giant string. For very large jobs, keep direct-to-file
  streaming enabled; the fallback download-link path still has to keep Blob
  chunks in browser memory.

## Testing

Open `test.html` in Chrome. It loads `app.js` plus `tests.js`, runs
`runTests()` automatically, and renders a pass/fail summary with full JSON
detail on the page. You can also open DevTools and run `runTests()` again.

This runs every registered test in `window.__tests` (depth mapping, origin
transform, validation rules, safe-surface flat/ball dilation against both an
O(N·r²) reference and a faster O(N·r) decomposition, the mask-skip guarantee
that transparent pixels are never cut, remaining-material stamping and
multi-sweep convergence, a rough→finish pass sequence, and GCode format
conventions) and logs a pass/fail summary plus per-test detail to the
console. All tests use small, deterministic, in-code fixtures (including a
9×9 pyramid and a 5×5 single-spike) — no file load is required to run them.
