# Browser GCode Generator

A standalone, **in-browser** depth-map PNG &rarr; GRBL GCode raster/outline generator.
It runs directly from `index.html` on the `file://` protocol — no server,
no build step, no external dependencies, and no network access. Everything
(PNG decoding, safe-surface math, toolpath generation, and `.nc` file
creation) happens client-side in plain JavaScript.

## Quick start

1. Open `index.html` directly in **Chrome** (double-click it, or drag it into a
   Chrome window — the URL bar will show `file:///.../index.html`).
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
   which tool a pass uses, its direction (Sweep X/Y Conventional, Climb, or
   Both; or Outline), stepover, max stepdown, and allowance (stock left after
   that raster pass; `0` = finishing depth). Outline passes use outline width
   and outline depth instead of raster allowance.
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
  Raster passes only place tool centers on opaque/cut pixels. Outline passes
  treat the opaque/cut region as the keep-out part boundary and cut a groove
  outside it.
- **Tool-safe surface**: for each tool, the depth-mapped surface is dilated by
  the tool's inverted bottom profile (a flat disk, or a ball's spherical dome)
  so the *tool center* never plunges the tool body below the surface anywhere
  under its footprint. This is the most expensive computation and runs in a Web
  Worker, off the main thread, with progress messages.
- **Multi-sweep depth stepping + remaining-material tracking**: a single
  `remaining`-material array is shared across all enabled passes, in order.
  Raster passes repeat full-surface sweeps — removing at most the tool's max
  stepdown per sweep — until they reach their target (the safe surface plus
  allowance). Outline passes stamp their emitted groove footprint into the same
  `remaining` array, so later passes see that removed material too.
- **Raster toolpaths**: X sweeps cut row tracks bottom-to-top; Y sweeps cut
  column tracks left-to-right. Tracks are spaced by the pass stepover. Within
  each track, contiguous cut-pixel runs ("spans") are cut in Conventional,
  Climb, or Both order. X Conventional moves left-to-right, X Climb moves
  right-to-left, Y Conventional moves top-to-bottom, and Y Climb moves
  bottom-to-top. Both alternates track direction. Each cut pixel is sampled so
  Z follows the surface smoothly; flat same-Z runs are emitted as endpoint moves
  instead of one redundant axis line per pixel. Transparent gaps are skipped
  with a retract + rapid. Both-direction links between spans/tracks use
  feed-rate `G1` only when the straight transition stays inside cut pixels;
  otherwise the tool retracts to `safeZ`, rapids across the gap, and plunges at
  the next span.
- **Outline toolpaths**: outline passes generate concentric closed loops outside
  the opaque/cut region, step down to the requested outline depth, retract
  between loops, and stamp each emitted segment into remaining material.
- **GCode**: `G90`/`G21`/`G17` + `M3 S<rpm>` preamble, one `.nc` file per
  enabled pass with a descriptive comment header (image, scale, zero/origin,
  tool, pass settings), commanded Z range / sweep summaries, an explicit first
  motion of `G0 Z<safeZ>` before any XY move, and a `G0 Z<safeZ>` / `M5` /
  `M2` footer. Modal `X`, `Y`, `Z`, and `F` words are omitted when unchanged.
  GCode text and generated filenames are normalized to printable ASCII. No
  `M0` (pause) is ever emitted.

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
  either choose an output directory once and write one `.nc` file per enabled
  pass, or write one combined `.nc` file with `M6` tool changes. If the API is
  unavailable, the app falls back to normal download links.
- If you edit `app.js` and don't see changes reflected, do a hard reload
  (Chrome can cache `file://` scripts) rather than assuming something is
  broken.

## Limitations / non-goals

This is a general raster depth-map-to-GCode tool, not a port of any specific
project's fixed workflow. Explicitly out of scope for this version:

- **No arbitrary vector strategies** beyond the built-in raster passes and the
  mask-outline groove pass.
- **No arc smoothing** — all cutting moves are straight `G1` line segments
  (no `G2`/`G3` fitting or path simplification).
- **No time estimates** in the GCode headers.
- **No sampled track-to-track travel-height optimization** — one-way raster
  travel retracts to the full `safeZ`, even when a lower travel height would be
  safe. Clear Both-direction links use the higher adjacent cut Z instead of
  sampling a separate clearance surface; masked gaps still retract to `safeZ`.
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
O(N·r²) reference and a faster O(N·r) decomposition, mask-skip and
both-direction X/Y gap safety, remaining-material stamping and multi-sweep
convergence, outline groove
geometry/stamping, a rough→finish pass sequence, ASCII-only GCode output, and
GCode format conventions) and logs a pass/fail summary plus per-test detail to
the console. All tests use small, deterministic, in-code fixtures (including a
9×9 pyramid and a 5×5 single-spike) — no file load is required to run them.
