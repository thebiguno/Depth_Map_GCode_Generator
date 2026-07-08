# Browser GCode Generator — Design & Implementation Spec

> This document is the authoritative build spec. It is written so an implementer
> can build each phase independently without reading the Python source. Where a
> formula or format is given, implement it exactly. "Non-goals" at the bottom
> lists what is intentionally **out of scope**.

## Goal

A standalone, browser-based GCode generator that runs directly from
`file:///.../index.html` with **no server, no build step, and no external
dependencies**. It converts a depth-map PNG into GRBL-friendly `.nc` toolpath
files.

## Scope decisions (locked)

These were decided up front and constrain every phase:

1. **Generic & minimal engine.** The tool is a general depth-map → GCode raster
   generator with user-defined tools and passes. It is **not** a port of the
   project's `export_gcode.py` 4-step workflow. The Python code is used only as
   the reference for the safe-surface math (see "Safe-Surface Algorithm").
2. **Auto bit-depth decoding.** Grayscale+alpha PNGs at 16-bit are decoded at
   full precision in pure JS (65,536 levels). Everything else falls back to
   8-bit Canvas decoding. See "Image Decoding".
3. **Remaining-material tracking is IN scope** (needed for correct multi-pass
   roughing). Raster passes and outline-groove passes both mutate the shared
   remaining-material model. Arc smoothing and time estimates are **OUT of
   scope** (see Non-Goals).

## File-URL Architecture (constraints, apply everywhere)

- Files: `index.html`, `styles.css`, `app.js`, `tests.js`, `test.html`,
  `README.md`, and this design document. All local; no CDN, no `import`, no
  `fetch()`.
- `app.js` and worker code are **classic scripts** (no ES modules — `file://`
  blocks module loading in some browsers).
- Do **not** use `fetch`, `XMLHttpRequest`, ES module `import`, service workers,
  or any external library.
- The Web Worker must be created from an **inline Blob** (worker source held as a
  string/`<script type="text/js-worker">` in the page), because `new
  Worker('worker.js')` is blocked under `file://` in Chrome. Pattern:
  ```js
  const blob = new Blob([workerSource], { type: 'application/javascript' });
  const worker = new Worker(URL.createObjectURL(blob));
  ```
- Read the input file with the **File API** (`<input type="file">` →
  `FileReader.readAsArrayBuffer`).
- Deliver each `.nc` file with a Blob + temporary `<a download>` link.

## Module / File Layout

| File | Responsibility |
|------|----------------|
| `index.html` | UI shell: file input, controls, tool/pass tables, preview `<canvas>`, generate button, download area. Inlines the worker source as a non-executed `<script id="worker-src" type="text/js-worker">`. |
| `styles.css` | Basic responsive two-column layout (controls left, preview right). No frameworks. |
| `app.js` | UI state, PNG decode, depth mapping, preview render, validation, worker orchestration, GCode assembly, downloads. |
| `tests.js` | Browser test registry and synthetic fixtures; loaded by `test.html`, not by the production app page. |
| `test.html` | Test harness with the DOM fixture `app.js` expects; loads `app.js` + `tests.js` and runs `window.runTests()` automatically. |
| `worker.js` *(source string)* | Pure compute: safe-surface dilation + remaining-material simulation + raster path generation. Receives typed arrays, posts progress + result. No DOM. |
| `README.md` | Usage + `file://` limitations + which browsers work. |

> If splitting worker logic out is awkward, the worker source may live inside a
> template string in `app.js` instead of an inline `<script>` tag — either is
> acceptable as long as it runs from `file://`.

## Data Model (exact shapes)

```js
// A cutting tool.
ToolSpec = {
  id: string,            // stable unique id
  name: string,          // used in filenames; sanitize to [A-Za-z0-9_]
  shape: "flat" | "ball",
  diameterMm: number,    // > 0
  radiusMm: number,      // = diameterMm / 2 (derive, don't ask user twice)
  stepoverMm: number,    // > 0, default row spacing
  maxStepdownMm: number, // > 0, max Z removed per sweep
  feedMmMin: number,     // cutting feed
  plungeMmMin: number,   // plunge feed
  spindleRpm: number,    // integer
}

// One machining pass over the surface or outline.
PassSpec = {
  id: string,
  name: string,
  toolId: string,        // references ToolSpec.id
  direction: "ltr" | "rtl" | "zigzag" | "outline",
  stepoverMm: number | null,   // null → use tool.stepoverMm
  maxStepdownMm: number | null,// null → use tool.maxStepdownMm
  allowanceMm: number,   // raster stock left above final terrain (>= 0; finish = 0)
  outlineWidthMm: number,// outline only: groove width outside cut/part mask
  outlineDepthMm: number,// outline only: floor Z, must be below stockTopMm
  enabled: boolean,
}

// Global job settings.
JobSpec = {
  imageName: string,
  widthPx: number, heightPx: number,
  pixelSizeMm: number,   // mm per pixel (see Scale Conversion)
  zAtBlackMm: number,    // machine Z the surface reaches at pure black
  zAtWhiteMm: number,    // machine Z the surface reaches at pure white
  zeroMode: "stockTop" | "bed",
  originMode: "center" | "lowerLeft",
  stockTopMm: number,    // machine Z of the top of stock (see Zero/Origin)
  safeZMm: number,       // rapid-travel height, must clear stockTop
  passes: PassSpec[],
}

// Decoded image, produced once per file load.
HeightMap = {
  width: number, height: number,
  gray: Float32Array,    // length w*h, normalized 0..1 (0=black,1=white)
  cut: Uint8Array,       // length w*h, 1 = cut (alpha>0), 0 = skip
  bits: 8 | 16,          // how it was decoded (for the UI badge)
}
```

Arrays are **row-major**: index `= y*width + x`, `x` increasing right, `y`
increasing **downward** (image space). Y is flipped when converting to machine
coordinates (see Zero/Origin).

## Image Decoding (auto 16-bit / 8-bit)

Read the file as an `ArrayBuffer`. Determine format from the PNG header, then
decode:

1. **Validate PNG signature**: first 8 bytes = `89 50 4E 47 0D 0A 1A 0A`.
2. **Parse IHDR** (first chunk after signature): at byte offset 16 read
   `width` (u32 BE), `height` (u32 BE); at offset 24 read `bitDepth` (u8) and
   `colorType` (u8). Color types: `0`=grayscale, `2`=RGB, `3`=palette,
   `4`=grayscale+alpha, `6`=RGBA.
3. **Full-precision path** — if `bitDepth === 16` **and** `colorType` is `0` or
   `4`:
   - Concatenate all `IDAT` chunk payloads, run a **pure-JS zlib inflate**, then
     **PNG-unfilter** the scanlines (filters 0–4: None/Sub/Up/Average/Paeth).
     Inline a compact permissively-licensed inflate (e.g. tiny-inflate style,
     ~200 lines) directly in the source — no external load.
   - Samples are 16-bit big-endian. For `colorType 4`, each pixel = `[gray16,
     alpha16]`; for `colorType 0`, `[gray16]` with alpha implicitly opaque.
   - `gray[i] = gray16 / 65535`. `cut[i] = (colorType===4 ? alpha16 > 0 : 1)`.
   - Set `bits = 16`.
4. **Fallback 8-bit path** — anything else (8-bit, RGB, palette, RGBA):
   - Draw the decoded image onto an offscreen `<canvas>` and read `getImageData`.
   - Grayscale via luminance: `g = 0.2126*R + 0.7152*G + 0.0722*B`, then
     `gray[i] = g / 255`.
   - `cut[i] = A > 0 ? 1 : 0`.
   - Set `bits = 8`.
   - For a grayscale-source image the RGB channels are equal, so luminance
     returns the gray value unchanged — correct either way.

The UI shows a badge: "16-bit precision" or "8-bit (Canvas)".

## Scale Conversion

The user picks **one** input mode; compute `pixelSizeMm`:

- **pixels/mm** input `ppm`: `pixelSizeMm = 1 / ppm`.
- **physical width** input `Wmm`: `pixelSizeMm = Wmm / widthPx`.
- **physical height** input `Hmm`: `pixelSizeMm = Hmm / heightPx`.

Pixels are assumed square. If both width and height are given, prefer width and
show the resulting height for confirmation.

## Depth Mapping (exact)

Per pixel with normalized `gray` in `[0,1]`:

```
surfaceZmm = zAtBlackMm + gray * (zAtWhiteMm - zAtBlackMm)
```

`zAtBlackMm`/`zAtWhiteMm` are the finished-surface machine-Z at pure black and
pure white. The UI presents them per zero-mode so signs are intuitive:

- **`zeroMode = "bed"`** (Z=0 at machine bed, positive up): the user enters
  *heights above bed*. Black = deepest valley = lowest height; white = peaks =
  highest. Example UI: "black height 3mm, white height 38mm" →
  `zAtBlackMm = 3`, `zAtWhiteMm = 38`. (This matches the Python
  `value_to_z(max_depth=black, min_depth=white)`.)
- **`zeroMode = "stockTop"`** (Z=0 at top of stock, cuts negative): the user
  enters *depths below top* (positive numbers). Black = deepest =
  `zAtBlackMm = -blackDepth`; white = shallowest = `zAtWhiteMm = -whiteDepth`.

`stockTopMm` is `0` when `zeroMode = "stockTop"`, and `max(zAtBlackMm,
zAtWhiteMm)` (i.e. the highest surface point, or a user-supplied stock height,
whichever is larger) when `zeroMode = "bed"`. `safeZMm` defaults to
`stockTopMm + 5`.

`terrain[i]` (the final target surface, machine Z) is `surfaceZmm(gray[i])` for
pixels where `cut[i] === 1`, and treated as "no material / no constraint"
(`-Infinity`) where `cut[i] === 0`.

## Zero & Origin — Machine Coordinate Transform

Pixel `(px, py)` (integer, image space, origin top-left) → machine `(Xmm, Ymm)`
at the **pixel center**:

```
// center origin:
Xmm = (px + 0.5 - width/2)  * pixelSizeMm
Ymm = (height/2 - py - 0.5) * pixelSizeMm          // Y flips (image→machine)

// lowerLeft origin:
Xmm = (px + 0.5)          * pixelSizeMm
Ymm = (height - py - 0.5) * pixelSizeMm
```

Z uses `terrain`/`safeZ`/`stockTop` already expressed in machine Z by the depth
mapping above; no extra Z transform is needed.

## Safe-Surface Algorithm (exact)

The **safe surface** for a tool is the highest Z the tool *center* may reach at
each pixel so the tool body never cuts below `terrain` within its footprint. It
is a morphological dilation of `terrain` by the tool's inverted-bottom profile.

For each output pixel `(x,y)`:

```
safe[x,y] = max over (dx,dy) with (hypot(dx,dy)*pixelSizeMm) <= radiusMm of:
              terrain[x+dx, y+dy] - delta(dx,dy)
where, with d = hypot(dx,dy)*pixelSizeMm:
  flat:  delta = 0
  ball:  delta = radiusMm - sqrt(radiusMm^2 - d^2)
Out-of-bounds and non-cut (terrain=-Inf) neighbors contribute -Inf (ignored).
```

- **Correctness reference (simplest, O(N·r²))**: the double `dx,dy` loop above.
  Implement this first; it is the ground truth for tests.
- **Performance decomposition (recommended, O(N·r))**: for each `dy` in
  `[-R..R]` compute the per-row horizontal contribution, then merge into `safe`
  shifted by `dy` with elementwise `max`:
  - `flat`: horizontal max-filter of window `2*xRadius+1` where
    `xRadius = floor(sqrt(radiusPx² - dy²))`, `radiusPx = radiusMm/pixelSizeMm`.
  - `ball`: for each `dy`, build the 1-D profile `delta(dx) = radiusMm -
    sqrt(radiusMm² - (dx²+dy²)·pixelSizeMm²)` over `dx in [-xRadius..xRadius]`
    and take, per output x, `max_dx(terrain[x-dx,y] - delta(dx))` (grayscale
    dilation by that 1-D structuring element).
  Both must produce results **identical** to the O(N·r²) reference (verify in
  tests). A naive per-row window scan is fine; a monotonic-queue max-filter is
  an optional later optimization.

`radiusMm <= 0` (or a point tool) → `safe = terrain` copy.

## Remaining-Material Model (exact)

`remaining[i]` tracks the current top-of-material machine Z. Simulated across all
passes so later passes know what's actually left.

- **Init**: `remaining[i] = stockTopMm` for `cut[i]===1`; `+Infinity` for
  `cut[i]===0` until an outline pass or tool footprint actually removes
  material there.
- **Raster per-pass target surface**:
  `target[i] = safeSurface(terrain, tool)[i] + pass.allowanceMm`, clamped so
  `target[i] <= stockTopMm` (never "cut" above stock) and only defined where
  `cut[i]===1`.
- **Raster multi-sweep depth stepping** (a pass repeats full sweeps until it reaches
  `target`):
  1. If `max(remaining[i] - target[i])` over cut pixels `<= tol` (e.g. 1e-4),
     the pass is done.
  2. Otherwise snapshot `remaining` at the start of the sweep, then run one
     sweep. For each cut position visited along a row, the commanded center Z
     is `zc = max(target[x,y], sweepStartRemaining[x,y] - effectiveStepdown)`
     — i.e. remove at most `maxStepdown` below the material height at sweep
     start, never below target.
  3. After a row is cut, **stamp the footprint** into `remaining`: for every
     pixel within `radiusMm` of each cut position, with center Z `zc`:
     `remaining[nx,ny] = min(remaining[nx,ny], zc + bottomOffset(d))`, where
     `bottomOffset` is `0` (flat) or `radiusMm - sqrt(radiusMm²-d²)` (ball).
  4. Repeat sweeps (bounded by a safety cap, e.g. 200, log if hit).
- **Outline remaining-material stamping**: outline passes emit closed groove
  loops outside the `cut===1` keep-out region. For each emitted loop segment at
  depth `zc`, sample along the segment and stamp the tool footprint into the
  same `remaining` array using the same `bottomOffset(d)` formula. This makes
  later passes see material removed by the outline groove.

> This footprint stamping is the heavy part of generation. It is O(cutPositions
> × footprintPixels). Acceptable for the first version; note it in progress.

## Raster Generation (exact)

For each sweep of a pass:

- **Rows**: iterate `y` from bottom of image upward (largest `py` first, so
  machine Y goes low→high) stepping by `round(stepoverMm / pixelSizeMm)` pixels
  (min 1). This is the "row cadence".
- **Row spans**: within a row, find maximal runs of `cut[i]===1`. Only cut inside
  spans. Transparent gaps are skipped with a retract + rapid. `zigzag` may
  feed-link rows/spans only when the straight transition segment stays on
  `cut===1` pixels.
- **X order per row by `direction`**:
  - `ltr`: every row left→right.
  - `rtl`: every row right→left (climb-only style; after each row retract to
    `safeZ`, rapid back to the start X, then step to next row).
  - `zigzag`: alternate direction each row (no rapid-back between rows).
- **X sampling within a span**: evaluate every pixel center so Z follows the
  surface and remaining-material stamping stays pixel-accurate. When a
  consecutive cut run has the same formatted Z and feed, emit only the run's
  endpoint because the intermediate `X`-only moves are collinear/redundant.

**Move sequence per span** (emit machine coords via the transform above; Z from
the multi-sweep `zc`; modal `X/Y/Z/F` words are omitted when unchanged):

```
G0 Z<safeZ>                     // ensure clear, if Z is not already safe
G0 X<x0> Y<y>                   // rapid to span start; omit unchanged words
G1 Z<zc(x0)> F<plungeMmMin>     // plunge to first cut Z
G1 X<xEnd> [Z<zc(xEnd)>] F<feedMmMin>
... split into additional G1 endpoints whenever formatted Z changes ...
G0 Z<safeZ>                     // retract at span end
```

At row/pass end, retract to `safeZ`. Between spans in the same row, `ltr`/`rtl`
retract to `safeZ`, rapid to next span start, and plunge again. `zigzag`
keeps the tool down only for clear in-mask transitions: upward Z-only moves use
`G0`, XY travel at cutting depth uses `G1`, and downward Z moves use `G1`.
If the transition crosses any `cut===0` pixel, retract to `safeZ`, rapid to the
next span start, and plunge again.

> Python's "sampled travel height" optimization remains a Non-Goal; zigzag
> links use the higher adjacent cut Z rather than a sampled clearance surface.

## Outline Generation (exact)

For `direction === "outline"`, treat `cut===1` as the keep-out part region and
cut a groove outside it:

- Compute an exact Euclidean distance field from the keep-out mask.
- Choose concentric loop levels starting at the tool radius plus an outward
  simplification/bias margin, then step outward by the effective stepover until
  the requested `outlineWidthMm` is covered.
- Extract each loop with marching squares, stitch only closed loops, and drop
  any open chain that would require a long forced closing chord across the
  keep-out region.
- Emit each loop at depth levels from `stockTopMm` down to `outlineDepthMm`,
  stepping by the effective max stepdown. Each loop begins with `G0 Z<safeZ>`,
  rapids to the first loop point, plunges with `G1`, cuts the closed loop with
  `G1`, and retracts to `safeZ`.
- Stamp every emitted outline segment into the shared `remaining` array by
  sampling along the segment and applying the tool footprint profile. Later
  raster or outline passes therefore see the groove as removed material.

## GCode Output (exact)

- **One `.nc` per enabled pass, or one combined `.nc` with `M6` tool-change
  blocks when the combined-file option is enabled.** Disabled passes are
  skipped; enabled passes mutate `remaining` in order.
- **Filename**: `<imageBase>_<passIndex>_<toolName>.nc` where `imageBase` is the
  input filename without extension, `passIndex` is the 1-based index among
  enabled passes, and both filename components are sanitized to printable ASCII
  (`toolName` to `[A-Za-z0-9_]`). Combined output uses
  `<imageBase>_combined.nc`.
- **Header** (comment lines, `;` prefix): image name; width×height px;
  `pixelSizeMm` and derived physical size; `zeroMode`; `originMode`;
  `stockTopMm`; `safeZMm`; tool name/shape/diameter; pass name/direction/
  stepover/stepdown/allowance or outline width/depth; spindle RPM; commanded Z
  range for the pass (min/max, 0.01mm).
- **Preamble**: `G90` / `G21` / `G17` on separate lines, then `M3 S<rpm>`,
  then the first motion line `G0 Z<safeZ>` before any XY move.
- **No `M0` / pause** anywhere.
- **Number format**: X/Y/Z to **3 decimals**; feeds as integers. Omit `X`,
  `Y`, `Z`, and `F` words when their formatted modal value is unchanged from
  the previous emitted value.
- **Footer**: `G0 Z<safeZ>` then `M5` then `M2`.
- **ASCII**: every emitted GCode line is normalized to printable ASCII before it
  is counted or written.

## UI Spec (first version)

Left column (controls), right column (preview). Controls:

- File picker (`<input type="file" accept="image/png">`) + decoded badge
  (bits, dimensions).
- Scale: radio (pixels/mm | width mm | height mm) + numeric input; show derived
  `pixelSizeMm` and physical size.
- Depth: `zAtBlack`/`zAtWhite` inputs (labeled per zero-mode), `stockTop`
  (bed mode), `safeZ`.
- Zero-mode selector (stockTop | bed); origin selector (center | lowerLeft).
- **Tool table**: add/remove/reorder/edit rows for every `ToolSpec` field;
  `radiusMm` auto-derived from diameter.
- **Pass table**: add/remove/reorder/edit rows for every `PassSpec` field; tool
  chosen from a dropdown of defined tools; enable checkbox.
- **Generate** button → runs worker → shows per-pass download links + a log.

Preview `<canvas>`: render `gray` as grayscale, overlay non-cut (`cut===0`)
pixels as a distinct color (e.g. magenta at 40% alpha) so the mask is visible.
Optionally a "depth preview" toggle that maps `terrain` through a colormap.

**Default seed** (so the app is usable immediately; all editable): one flat tool
(6.35mm, stepover 3, stepdown 3, feed 1800, plunge 700, 15000rpm) and one ball
tool (1mm, stepover 0.2, stepdown 2, feed 1500, plunge 700, 20000rpm); two
passes — a flat roughing pass (`allowance 0.8`, `rtl`) and a ball finishing pass
(`allowance 0`, `zigzag`). These are starting points, not a fixed workflow.

## Validation

Block generation (hard error) on:

- No image loaded.
- `pixelSizeMm <= 0` or non-finite scale input.
- Any tool with `diameterMm <= 0`, `stepoverMm <= 0`, `maxStepdownMm <= 0`,
  `feedMmMin <= 0`, `plungeMmMin <= 0`.
- A pass referencing an undefined tool.
- No enabled passes.
- `zAtBlack === zAtWhite` (flat/zero depth range → nothing to cut).
- `safeZMm <= stockTopMm` (rapids would not clear stock).

Warn (allow, but surface a message):

- Very large images (e.g. `width*height > 4_000_000`) → memory/time.
- Pass `stepoverMm > tool.diameterMm` (uncut ridges between rows).
- 8-bit fallback used on an image that looks like a terrain map (banding risk).

## Testing (concrete, browser-callable)

Open `test.html` to load `app.js` plus `tests.js` and run `window.runTests()`
automatically. The function also remains console-callable on that page. Use
small synthetic maps with known answers:

1. **Depth mapping**: `gray=0 → zAtBlack`, `gray=1 → zAtWhite`, `gray=0.5 →`
   midpoint. Check both zero-modes.
2. **Origin transform**: for a 4×4 map at `pixelSizeMm=1`, center origin maps
   pixel `(0,0)` center to `(-1.5, +1.5)` and `(3,3)` to `(+1.5, -1.5)`;
   lowerLeft maps `(0,3)` to `(0.5, 0.5)`.
3. **Mask skip / zigzag gap safety**: pixels with `cut===0` never appear in any
   raster cut move, and zigzag transitions crossing `cut===0` retract/rapid
   instead of feeding across the gap at cutting depth.
4. **Safe surface — flat**: on a 5×5 map that is `0` everywhere except a single
   center pixel at height `10`, a flat tool of radius = 2px produces a flat disk
   of `10` (radius 2) around the center; corners stay `0`. Verify O(N·r)
   decomposition == O(N·r²) reference elementwise.
5. **Safe surface — ball**: same map; ball tool yields a domed profile where
   `safe(d) = 10 - (r - sqrt(r²-d²))` for `d<=r`, `0` beyond. Compare to closed
   form within 1e-9.
6. **Remaining material**: after one flat sweep at known `zc`, the stamped
   footprint lowers `remaining` to `zc` within radius and leaves it unchanged
   outside.
7. **GCode conventions**: generated text contains `M3 S<rpm>`, `G90`, `G21`,
   `G17`, ends with `M5`/`M2`, contains **no** `M0`, and contains only ASCII.
8. **Outline groove**: generated outline loops stay outside the keep-out region
   and stamp their emitted segments into `remaining`.

Ship 2 fixtures generated in-code (no file load needed): a 9×9 pyramid and a
5×5 single-spike, used by the tests above.

## Implementation Phases (each is an independent, testable ticket)

Each phase lists **deliverable** and **acceptance** (how to know it's done).

1. **App shell + image decode.**
   Deliver: `index.html`/`styles.css`/`app.js`; file picker; PNG signature +
   IHDR parse; 8-bit Canvas path working end-to-end; bits/dimensions badge;
   grayscale preview with mask overlay.
   Accept: loading an 8-bit PNG shows correct dimensions and a visible preview;
   loading a non-PNG shows a clear error.

2. **16-bit decode path.**
   Deliver: inline inflate + PNG unfilter; full-precision decode for
   `bitDepth 16`, colorType `0`/`4`; auto-selection between paths; badge shows
   "16-bit".
   Accept: a project GA16 height map decodes with `bits=16`; spot-checked
   `gray` values match the raw 16-bit sample / 65535 within 1e-6.

3. **Depth mapping + scale + zero/origin transforms.**
   Deliver: `pixelSizeMm` from all three scale inputs; `terrain` array;
   pixel→machine transform for both origin modes; both zero modes.
   Accept: tests 1 & 2 pass.

4. **Tool/pass UI + validation + defaults.**
   Deliver: editable tool & pass tables, default seed, all validation rules with
   inline messages.
   Accept: invalid configs are blocked with the right message; valid configs
   enable Generate; reorder/add/remove work.

5. **Safe-surface (worker).**
   Deliver: inline-Blob worker; O(N·r²) reference + O(N·r) decomposition for flat
   and ball; progress messages by row/chunk.
   Accept: tests 4 & 5 pass; worker runs from `file://` in Chrome without error.

6. **Raster generation + GCode + downloads (single pass, no remaining sim).**
   Deliver: row/span iteration; all three raster directions; move sequence;
   GCode header/preamble/footer/format; per-pass `.nc` Blob download.
   Accept: test 7 passes; a single finishing pass on a fixture produces a
   plausible `.nc` that follows the surface; opens in a GCode viewer.

7. **Remaining-material simulation across passes.**
   Deliver: `remaining` init + per-pass target + multi-sweep stepping + footprint
   stamping; raster and outline passes run in order and mutate `remaining`.
   Accept: test 6 passes; a rough(flat)→finish(ball) sequence shows the rough
   pass leaving `allowance` stock and the finish pass reaching `terrain`.

8. **Tests + fixtures + README + performance pass.**
   Deliver: `tests.js`/`test.html` with all fixtures and `window.runTests()`;
   README (usage + `file://` caveats + browser support); measure a real project
   map and, if too slow, apply the O(N·r) decomposition / chunking (no algorithm
   change to outputs).
   Accept: `test.html`/`runTests()` all green; a 600×600 map generates in reasonable time in
   Chrome without freezing the tab (worker keeps UI responsive).

## Non-Goals (explicitly out of scope for v1)

- The Python's fixed 4-step workflow, `ROUGH/FINE_STOCK_ALLOWANCE`,
  `STEP3_MAX_CUMULATIVE_CUT` interplay, and per-step feed-by-depth scaling.
- **Arc/line smoothing** (G2/G3 fitting, Douglas-Peucker simplification).
- **Time estimates** (trapezoidal-acceleration model) in headers.
- Sampled row-to-row travel-height optimization (`ltr`/`rtl` rapids stay at
  `safeZ`; clear zigzag links use adjacent cut Z, not a sampled clearance
  surface; masked gaps retract to `safeZ`).
- Metadata sidecar (`.txt`) reading/writing; sea-level/coast-gap semantics.
- Arbitrary imported vector toolpath strategies beyond the built-in mask outline
  groove.

Any of these can be added later as separate passes/options without disturbing
the v1 architecture.

## Main Risk & Mitigation

The expensive operations are (a) safe-surface dilation and (b) remaining-material
footprint stamping, both scaling with tool radius in pixels. Mitigation: keep all
heavy compute in the worker; implement the O(N·r) safe-surface decomposition; send
progress; and defer further optimization until a real Chrome timing is measured
(Phase 8). Outputs must remain identical to the O(N·r²) reference regardless of
optimization.
