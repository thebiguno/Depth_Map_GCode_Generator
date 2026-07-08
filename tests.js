"use strict";
// ============================================================================
// TEST REGISTRY — window.runTests() (see Design.md "Testing"). Incremental:
// later phases register more tests under window.__tests.
// ============================================================================

window.__tests = window.__tests || {};

// ----------------------------------------------------------------------------
// SHARED FIXTURES (Design.md "Testing": "Ship 2 fixtures generated in-code (no
// file load needed): a 9x9 pyramid and a 5x5 single-spike, used by the tests
// above."). Pure, deterministic, no DOM — usable both from these tests and
// (if ever needed) from a console/manual smoke check.
// ----------------------------------------------------------------------------

/**
 * A 5x5 single-spike fixture: flat at machine-Z 0 everywhere except the
 * center pixel (2,2), which is raised to `peakZ` (default 10). All pixels are
 * "cut" (cut===1 everywhere) — there's no transparency in this fixture, only
 * a height spike. Used by the safe-surface flat/ball tests (Design.md
 * "Testing" #4/#5), which need an isolated peak with a known, easy-to-verify
 * dilation footprint.
 * @param {number} [peakZ] - machine Z of the center spike (default 10).
 * @returns {{width:number, height:number, heightMap:HeightMap, terrain:Float32Array, cx:number, cy:number, peakZ:number}}
 */
function makeSpike5x5(peakZ) {
  const width = 5, height = 5;
  const cx = 2, cy = 2;
  const z = peakZ === undefined ? 10 : peakZ;

  const gray = new Float32Array(width * height); // unused by terrain-based tests; kept for HeightMap shape completeness
  const cut = new Uint8Array(width * height).fill(1);
  const heightMap = { width, height, gray, cut, bits: 8 };

  const terrain = new Float32Array(width * height).fill(0);
  terrain[cy * width + cx] = z;

  return { width, height, heightMap, terrain, cx, cy, peakZ: z };
}

/**
 * A 9x9 pyramid fixture: machine Z decreases linearly (Chebyshev/L-infinity
 * distance, i.e. a square-based pyramid, not a cone) from `peakZ` at the
 * center (4,4) to `peakZ - 4*step` at the outer ring (Chebyshev distance 4),
 * i.e. `terrain[x,y] = peakZ - step * max(|x-4|, |y-4|)`. All pixels are cut.
 * A step-per-ring shape (rather than a single spike) gives safe-surface tests
 * a fixture with genuine local slope, so a sanity check can assert monotonic,
 * non-decreasing dilation behavior (safe-surface can only ever raise or match
 * the terrain, never lower it) across a non-trivial neighborhood.
 * @param {number} [peakZ] - machine Z at the center (default 8).
 * @param {number} [step] - Z drop per Chebyshev ring (default 1).
 * @returns {{width:number, height:number, heightMap:HeightMap, terrain:Float32Array, cx:number, cy:number, peakZ:number, step:number}}
 */
function makePyramid9x9(peakZ, step) {
  const width = 9, height = 9;
  const cx = 4, cy = 4;
  const z = peakZ === undefined ? 8 : peakZ;
  const s = step === undefined ? 1 : step;

  const gray = new Float32Array(width * height);
  const cut = new Uint8Array(width * height).fill(1);
  const heightMap = { width, height, gray, cut, bits: 8 };

  const terrain = new Float32Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const ring = Math.max(Math.abs(x - cx), Math.abs(y - cy));
      terrain[y * width + x] = z - s * ring;
    }
  }

  return { width, height, heightMap, terrain, cx, cy, peakZ: z, step: s };
}

/**
 * Test 1 (Design.md "Testing" #1): depth mapping. Checks both zero-mode
 * examples given in the task spec, plus computeTerrain's -Infinity handling
 * for non-cut pixels.
 */
window.__tests.depthMapping = function () {
  const checks = [];

  // Bed-mode example: black height 3mm, white height 38mm.
  checks.push(["bed gray=0", surfaceZmm(0, 3, 38), 3]);
  checks.push(["bed gray=1", surfaceZmm(1, 3, 38), 38]);
  checks.push(["bed gray=0.5", surfaceZmm(0.5, 3, 38), 20.5]);

  // stockTop-mode example: blackInput=5 -> zAtBlack=-5, whiteInput=0.5 -> zAtWhite=-0.5.
  checks.push(["stockTop gray=0", surfaceZmm(0, -5, -0.5), -5]);
  checks.push(["stockTop gray=1", surfaceZmm(1, -5, -0.5), -0.5]);
  checks.push(["stockTop gray=0.5", surfaceZmm(0.5, -5, -0.5), -2.75]);

  let pass = checks.every(([, actual, expected]) => actual === expected);

  // computeTerrain: -Infinity at a cut===0 pixel.
  const heightMap = {
    width: 2,
    height: 1,
    gray: new Float32Array([0, 1]),
    cut: new Uint8Array([1, 0]),
    bits: 8,
  };
  const terrain = computeTerrain(heightMap, 3, 38);
  const terrainOk = terrain[0] === 3 && terrain[1] === -Infinity;
  pass = pass && terrainOk;

  return {
    pass,
    detail: { checks, terrain: Array.from(terrain), terrainOk },
  };
};

/**
 * Test 2 (Design.md "Testing" #2): origin transform. For a 4x4 map at
 * pixelSizeMm=1: center maps (0,0)->(-1.5,+1.5) and (3,3)->(+1.5,-1.5);
 * lowerLeft maps (0,3)->(0.5,0.5). Exact equality (exact in float).
 */
window.__tests.originTransform = function () {
  const w = 4, h = 4, px = 1;

  const c00 = pixelCenterToMachineXY(0, 0, px, w, h, "center");
  const c33 = pixelCenterToMachineXY(3, 3, px, w, h, "center");
  const ll03 = pixelCenterToMachineXY(0, 3, px, w, h, "lowerLeft");

  const pass =
    c00.x === -1.5 && c00.y === 1.5 &&
    c33.x === 1.5 && c33.y === -1.5 &&
    ll03.x === 0.5 && ll03.y === 0.5;

  return { pass, detail: { c00, c33, ll03 } };
};

/**
 * Phase 4 validation tests (Design.md "Validation"). Builds small in-memory
 * jobSpec/tools/heightMap fixtures and checks validateJob's hard-error and
 * warning rules. Covers: (a) missing image, (b) tool diameterMm<=0,
 * (c) zAtBlackMm===zAtWhiteMm, (d) safeZ<=stockTop, (e) valid seed
 * config -> zero errors, (f) stepover > diameter -> warning.
 */
window.__tests.validation = function () {
  const checks = [];

  function makeJobSpec(overrides) {
    return Object.assign(
      {
        imageName: "test.png",
        widthPx: 100,
        heightPx: 100,
        pixelSizeMm: 0.25,
        zAtBlackMm: 3,
        zAtWhiteMm: 38,
        zeroMode: "bed",
        originMode: "center",
        stockTopMm: 38,
        safeZMm: 43,
        passes: [
          { id: "p1", name: "Rough", toolId: "t1", direction: "xClimb", stepoverMm: null, maxStepdownMm: null, allowanceMm: 0.8, enabled: true },
          { id: "p2", name: "Finish", toolId: "t2", direction: "xBoth", stepoverMm: null, maxStepdownMm: null, allowanceMm: 0, enabled: true },
        ],
      },
      overrides || {}
    );
  }

  function makeTools() {
    return [
      { id: "t1", name: "flat_6_35mm", shape: "flat", diameterMm: 6.35, radiusMm: 3.175, stepoverMm: 3, maxStepdownMm: 3, feedMmMin: 1800, plungeMmMin: 700, spindleRpm: 15000 },
      { id: "t2", name: "ball_1mm", shape: "ball", diameterMm: 1, radiusMm: 0.5, stepoverMm: 0.2, maxStepdownMm: 2, feedMmMin: 1500, plungeMmMin: 700, spindleRpm: 20000 },
    ];
  }

  function makeHeightMap(overrides) {
    return Object.assign(
      { width: 100, height: 100, gray: new Float32Array(100 * 100), cut: new Uint8Array(100 * 100).fill(1), bits: 16 },
      overrides || {}
    );
  }

  // (a) missing image -> no-image error.
  {
    const { errors } = validateJob(makeJobSpec(), makeTools(), null);
    checks.push(["missing image -> error", errors.some((e) => /no image loaded/i.test(e))]);
  }

  // (b) tool with diameterMm 0 -> error.
  {
    const tools = makeTools();
    tools[0].diameterMm = 0;
    const { errors } = validateJob(makeJobSpec(), tools, makeHeightMap());
    checks.push(["diameterMm=0 -> error", errors.some((e) => /diameterMm/i.test(e))]);
  }

  // (c) zAtBlack === zAtWhite -> error.
  {
    const jobSpec = makeJobSpec({ zAtBlackMm: 10, zAtWhiteMm: 10 });
    const { errors } = validateJob(jobSpec, makeTools(), makeHeightMap());
    checks.push(["zAtBlack===zAtWhite -> error", errors.some((e) => /zAtBlackMm equals zAtWhiteMm/i.test(e))]);
  }

  // (d) safeZ <= stockTop -> error.
  {
    const jobSpec = makeJobSpec({ safeZMm: 38 });
    const { errors } = validateJob(jobSpec, makeTools(), makeHeightMap());
    checks.push(["safeZ<=stockTop -> error", errors.some((e) => /safeZMm .*must be above stockTopMm/i.test(e))]);
  }

  // (e) valid seed config with an image -> zero errors.
  {
    const { errors } = validateJob(makeJobSpec(), makeTools(), makeHeightMap());
    checks.push(["valid config -> zero errors", errors.length === 0]);
  }

  // (f) stepover > diameter -> warning present.
  {
    const jobSpec = makeJobSpec();
    jobSpec.passes[0].stepoverMm = 999;
    const { warnings } = validateJob(jobSpec, makeTools(), makeHeightMap());
    checks.push(["stepover > diameter -> warning", warnings.some((w) => /effective stepover/i.test(w))]);
  }

  const pass = checks.every(([, ok]) => ok);
  return { pass, detail: { checks } };
};

/**
 * Test 4 (Design.md "Testing" #4): safe surface, flat. 5x5 map, all 0 except
 * center (2,2)=10; flat tool, radiusMm=2, pixelSizeMm=1. Every pixel within
 * 2px of center (dx^2+dy^2<=4) must be 10; the four corners must be 0.
 * Also verifies computeSafeSurface (O(N*r) decomposition) matches the
 * O(N*r^2) reference elementwise (exact equality expected for the flat case).
 * Uses the shared makeSpike5x5() fixture (Design.md "Testing": "Ship 2
 * fixtures generated in-code... a 5x5 single-spike").
 */
window.__tests.validationRejectsBadPassNumbers = function () {
  const checks = [];
  const tools = [{ id: "t1", name: "flat", shape: "flat", diameterMm: 6, radiusMm: 3, stepoverMm: 3, maxStepdownMm: 3, feedMmMin: 1000, plungeMmMin: 500, spindleRpm: 12000 }];
  const hm = { width: 10, height: 10, gray: new Float32Array(100), cut: new Uint8Array(100).fill(1), bits: 16 };
  function job(passes) {
    return { imageName: "t.png", widthPx: 10, heightPx: 10, pixelSizeMm: 0.25, zAtBlackMm: 3, zAtWhiteMm: 38, zeroMode: "bed", originMode: "center", stockTopMm: 38, safeZMm: 43, passes: passes };
  }
  {
    const { errors } = validateJob(job([{ id: "p1", name: "R", toolId: "t1", direction: "xClimb", stepoverMm: null, maxStepdownMm: 0, allowanceMm: 0, enabled: true }]), tools, hm);
    checks.push(["pass maxStepdown=0 -> error", errors.some((e) => /max stepdown/i.test(e))]);
  }
  {
    const { errors } = validateJob(job([{ id: "p1", name: "R", toolId: "t1", direction: "xClimb", stepoverMm: -1, maxStepdownMm: null, allowanceMm: 0, enabled: true }]), tools, hm);
    checks.push(["pass stepover=-1 -> error", errors.some((e) => /stepover override/i.test(e))]);
  }
  {
    const { errors } = validateJob(job([{ id: "p1", name: "R", toolId: "t1", direction: "xClimb", stepoverMm: null, maxStepdownMm: null, allowanceMm: NaN, enabled: true }]), tools, hm);
    checks.push(["raster NaN allowance -> error", errors.some((e) => /allowance/i.test(e))]);
  }
  {
    const { errors } = validateJob(job([{ id: "p1", name: "O", toolId: "t1", direction: "outline", stepoverMm: null, maxStepdownMm: null, allowanceMm: 0, outlineWidthMm: 10, outlineDepthMm: 38, enabled: true }]), tools, hm);
    checks.push(["outline depth>=stockTop -> error", errors.some((e) => /stock top/i.test(e))]);
  }
  {
    const { errors } = validateJob(job([{ id: "p1", name: "R", toolId: "t1", direction: "xClimb", stepoverMm: null, maxStepdownMm: null, allowanceMm: 0.5, enabled: true }]), tools, hm);
    checks.push(["valid pass -> 0 errors", errors.length === 0]);
  }
  const pass = checks.every(([, ok]) => ok);
  return { pass, detail: { checks } };
};

window.__tests.formatCoordRejectsNonFinite = function () {
  const checks = [];
  let a = false; try { formatCoord(NaN); } catch (e) { a = true; }
  let b = false; try { formatCoord(Infinity); } catch (e) { b = true; }
  let c = false; try { formatFeed(NaN); } catch (e) { c = true; }
  checks.push(["formatCoord(NaN) throws", a]);
  checks.push(["formatCoord(Infinity) throws", b]);
  checks.push(["formatFeed(NaN) throws", c]);
  checks.push(["formatCoord(-0.5) === '-0.500'", formatCoord(-0.5) === "-0.500"]);
  checks.push(["formatCoord(-0.0004) === '0.000' (neg-zero normalized)", formatCoord(-0.0004) === "0.000"]);
  const pass = checks.every(([, ok]) => ok);
  return { pass, detail: { checks } };
};

window.__tests.gcodeOutputIsAscii = function () {
  const checks = [];
  const width = 2, height = 1;
  const cut = new Uint8Array(width * height).fill(1);
  const heightMap = { width, height, gray: new Float32Array(width * height), cut, bits: 8 };
  const targetSurface = new Float32Array([-1, -1]);
  const remaining = initRemaining(heightMap, 0);
  const tool = {
    id: "t1", name: "tøøl_6mm", shape: "flat",
    diameterMm: 1, radiusMm: 0.5, stepoverMm: 1, maxStepdownMm: 1,
    feedMmMin: 1000, plungeMmMin: 300, spindleRpm: 12000,
  };
  const pass = {
    id: "p1", name: "páss→rough", toolId: tool.id, direction: "xConventional",
    stepoverMm: null, maxStepdownMm: null, allowanceMm: 0, enabled: true,
  };
  const jobSpec = {
    imageName: "dépth→map.png", widthPx: width, heightPx: height, pixelSizeMm: 1,
    zeroMode: "stockTop", originMode: "lowerLeft", stockTopMm: 0, safeZMm: 5,
    passes: [pass],
  };
  const res = generatePassGCode({
    pass, tool, targetSurface, remaining, jobSpec, heightMap, passIndex: 1,
    imageBase: "dépth→map",
  });

  checks.push(["GCode text contains only ASCII", !/[^\x00-\x7F]/.test(res.gcode), res.gcode]);
  checks.push(["filename contains only ASCII", !/[^\x00-\x7F]/.test(res.filename), res.filename]);

  const pass_ = checks.every(([, ok]) => ok);
  return { pass: pass_, detail: { checks, filename: res.filename } };
};

window.__tests.outlineLoopTerminatesOnBadStepdown = function () {
  const checks = [];
  const width = 40, height = 40;
  const cut = new Uint8Array(width * height);
  for (let y = 12; y < 28; y++) for (let x = 12; x < 28; x++) cut[y * width + x] = 1;
  const tool = { id: "t1", name: "flat", shape: "flat", diameterMm: 3, radiusMm: 1.5, stepoverMm: 1, maxStepdownMm: 1, feedMmMin: 1000, plungeMmMin: 500, spindleRpm: 12000 };
  const pass = { id: "p1", name: "O", toolId: "t1", direction: "outline", stepoverMm: null, maxStepdownMm: 0, allowanceMm: 0, outlineWidthMm: 3, outlineDepthMm: -2, enabled: true };
  const jobSpec = { imageName: "t.png", pixelSizeMm: 0.25, zeroMode: "stockTop", originMode: "center", stockTopMm: 0, safeZMm: 5 };
  const res = generateOutlinePassGCode({ pass: pass, tool: tool, cut: cut, width: width, height: height, jobSpec: jobSpec, passIndex: 1, imageBase: "t" });
  checks.push(["terminates with finite, bounded sweeps", Number.isFinite(res.sweeps) && res.sweeps >= 1 && res.sweeps <= 2]);
  checks.push(["floor level reached", res.zMin === -2]);
  const pass_ = checks.every(([, ok]) => ok);
  return { pass: pass_, detail: { checks: checks, sweeps: res.sweeps, zMin: res.zMin } };
};

window.__tests.unfilterRejectsTruncated = function () {
  const checks = [];
  let threw = false;
  try { unfilterScanlines(new Uint8Array(5), 3, 2, 2); } catch (e) { threw = true; } // expected 3*(2+1)=9 bytes
  checks.push(["short inflated data -> throws", threw]);
  let ok = false;
  try {
    const data = new Uint8Array([0, 10, 20, 0, 30, 40, 0, 50, 60]); // 3 rows: filter byte 0 (None) + 2 data bytes
    const out = unfilterScanlines(data, 3, 2, 2);
    ok = out.length === 6 && out[0] === 10 && out[5] === 60;
  } catch (e) { ok = false; }
  checks.push(["exact-length data unfilters correctly", ok]);
  const pass = checks.every(([, o]) => o);
  return { pass, detail: { checks } };
};

window.__tests.parseIhdrRejectsBadHeaders = function () {
  const checks = [];
  let shortThrew = false;
  try { parseIhdr(new Uint8Array(10).buffer); } catch (e) { shortThrew = true; }
  checks.push(["short buffer -> throws", shortThrew]);
  function makeIhdrBuffer(w, h, bitDepth, colorType) {
    const buf = new ArrayBuffer(33);
    const dv = new DataView(buf);
    dv.setUint8(12, 73); dv.setUint8(13, 72); dv.setUint8(14, 68); dv.setUint8(15, 82); // "IHDR"
    dv.setUint32(16, w, false);
    dv.setUint32(20, h, false);
    dv.setUint8(24, bitDepth);
    dv.setUint8(25, colorType);
    return buf;
  }
  let hugeThrew = false;
  try { parseIhdr(makeIhdrBuffer(60000, 60000, 16, 4)); } catch (e) { hugeThrew = true; }
  checks.push(["huge dimensions -> throws", hugeThrew]);
  let normalOk = false;
  try {
    const ihdr = parseIhdr(makeIhdrBuffer(100, 100, 16, 0));
    normalOk = ihdr.width === 100 && ihdr.height === 100 && ihdr.bitDepth === 16 && ihdr.colorType === 0;
  } catch (e) { normalOk = false; }
  checks.push(["normal header parses", normalOk]);
  const pass = checks.every(([, o]) => o);
  return { pass, detail: { checks } };
};

window.__tests.toolNumberValidation = function () {
  const checks = [];
  const hm = { width: 10, height: 10, gray: new Float32Array(100), cut: new Uint8Array(100).fill(1), bits: 16 };
  function job(passes) {
    return { imageName: "t.png", widthPx: 10, heightPx: 10, pixelSizeMm: 0.25, zAtBlackMm: 3, zAtWhiteMm: 38, zeroMode: "bed", originMode: "center", stockTopMm: 38, safeZMm: 43, passes: passes };
  }
  function tool(id, num) {
    return { id: id, name: id, shape: "flat", diameterMm: 6, radiusMm: 3, stepoverMm: 3, maxStepdownMm: 3, feedMmMin: 1000, plungeMmMin: 500, spindleRpm: 12000, toolNumber: num };
  }
  const passes = [{ id: "p1", name: "R", toolId: "t1", direction: "xClimb", stepoverMm: null, maxStepdownMm: null, allowanceMm: 0, enabled: true }];
  {
    const { errors } = validateJob(job(passes), [tool("t1", 1.5)], hm);
    checks.push(["non-integer tool number -> error", errors.some((e) => /tool number/i.test(e))]);
  }
  {
    const { errors } = validateJob(job(passes), [tool("t1", -2)], hm);
    checks.push(["negative tool number -> error", errors.some((e) => /tool number/i.test(e))]);
  }
  {
    const { warnings } = validateJob(job(passes), [tool("t1", 1), tool("t2", 1)], hm);
    checks.push(["duplicate tool numbers -> warning", warnings.some((w) => /tool number 1/i.test(w))]);
  }
  {
    const { errors } = validateJob(job(passes), [tool("t1", 2)], hm);
    checks.push(["valid tool number -> no error", !errors.some((e) => /tool number/i.test(e))]);
  }
  {
    const { errors } = validateJob(job(passes), [tool("t1", null)], hm);
    checks.push(["blank tool number -> no error", !errors.some((e) => /tool number/i.test(e))]);
  }
  const pass = checks.every(([, ok]) => ok);
  return { pass, detail: { checks } };
};

window.__tests.sweepXBothSinglePixelSpanRetractsAcrossGap = function () {
  const checks = [];
  const width = 6, height = 2;
  const cut = new Uint8Array(width * height);
  // Bottom row (py=1, cut first, xBoth starts conventional): pixels 0,1,2.
  cut[1 * width + 0] = 1; cut[1 * width + 1] = 1; cut[1 * width + 2] = 1;
  // Top row (py=0, cut second): a single isolated pixel at px=5 (far right).
  cut[0 * width + 5] = 1;
  const lines = [];
  // py=1 cuts at Z=-2; the lone py=0 pixel is shallower (Z=-1), which would
  // otherwise tempt xBoth to link across the transparent gap at cutting depth.
  const zAtFn = (px, py) => (py === 1 ? -2 : -1);
  emitRasterSweepMoves({
    lines: lines, cut: cut, width: width, height: height, pixelSizeMm: 1,
    originMode: "center", rowStep: 1, direction: "xBoth", zAtFn: zAtFn,
    safeZMm: 5, feedMmMin: 1000, plungeMmMin: 300, atSafeZ: true,
  });
  // Machine X of the isolated pixel px=5: (5 + 0.5 - 6/2) * 1 = 2.5. This X
  // appears nowhere in the bottom row (px 0,1,2 -> X -2.5,-1.5,-0.5).
  const isoX = "X2.500";
  // The straight transition from the bottom span to this isolated pixel crosses
  // cut===0 pixels, so it must retract to safeZ, rapid to the span start, then
  // plunge there. The cutting move itself is the modal `G1 Z...` after the rapid.
  const rapidIdx = lines.findIndex((l) => l.indexOf("G0") === 0 && l.indexOf(isoX) !== -1);
  const feedIdx = lines.findIndex((l) => l.indexOf("G1") === 0 && l.indexOf(isoX) !== -1);
  const retractIdx = lines.findIndex((l) => l === "G0 Z5.000");
  const plungeAfterRapid = rapidIdx !== -1 && lines.slice(rapidIdx + 1).some((l) => /^G1 Z-1\.000\b/.test(l));
  checks.push(["isolated span reached by G0 after safe retract", rapidIdx !== -1 && retractIdx !== -1 && retractIdx < rapidIdx, lines]);
  checks.push(["no at-depth G1 XY crosses the masked gap", feedIdx === -1, lines]);
  checks.push(["isolated span is then plunged with G1", plungeAfterRapid, lines]);
  const pass = checks.every(([, ok]) => ok);
  return { pass, detail: { checks: checks, lines: lines } };
};

window.__tests.sweepXBothSameRowSplitSpanRetractsAcrossGap = function () {
  const checks = [];
  const width = 6, height = 1;
  const cut = new Uint8Array(width * height);
  cut[0] = 1; cut[1] = 1;
  cut[4] = 1; cut[5] = 1;

  const lines = [];
  emitRasterSweepMoves({
    lines, cut, width, height, pixelSizeMm: 1, originMode: "center", rowStep: 1,
    direction: "xBoth", zAtFn: () => -1, safeZMm: 5, feedMmMin: 1000,
    plungeMmMin: 300, atSafeZ: true,
  });

  const secondSpanRapidIdx = lines.findIndex((l) => /^G0\b/.test(l) && /\bX1\.500\b/.test(l));
  const unsafeFeedIdx = lines.findIndex((l) => /^G1\b/.test(l) && /\bX1\.500\b/.test(l));
  const retractBefore = secondSpanRapidIdx > 0 && lines.slice(0, secondSpanRapidIdx).some((l) => l === "G0 Z5.000");
  checks.push(["second same-row span is reached by rapid after retract", secondSpanRapidIdx !== -1 && retractBefore, lines]);
  checks.push(["no G1 XY crosses same-row transparent gap", unsafeFeedIdx === -1, lines]);

  const pass = checks.every(([, ok]) => ok);
  return { pass, detail: { checks, lines } };
};

window.__tests.sweepYDirectionsTraverseColumns = function () {
  const width = 3, height = 4, pixelSizeMm = 1;
  const cut = new Uint8Array(width * height).fill(1);

  function run(direction) {
    const lines = [];
    const visited = [];
    emitRasterSweepMoves({
      lines, cut, width, height, pixelSizeMm, originMode: "center", rowStep: 1,
      direction,
      zAtFn: (px, py) => -1 - 0.01 * (px * height + py),
      safeZMm: 5, feedMmMin: 1000, plungeMmMin: 300, atSafeZ: true,
      afterRow: (positions) => {
        for (const p of positions) visited.push([p.px, p.py]);
      },
    });
    return { lines, visited };
  }

  const expectedConventional = [
    [0, 0], [0, 1], [0, 2], [0, 3],
    [1, 0], [1, 1], [1, 2], [1, 3],
    [2, 0], [2, 1], [2, 2], [2, 3],
  ];
  const expectedClimb = [
    [0, 3], [0, 2], [0, 1], [0, 0],
    [1, 3], [1, 2], [1, 1], [1, 0],
    [2, 3], [2, 2], [2, 1], [2, 0],
  ];
  const expectedBoth = [
    [0, 0], [0, 1], [0, 2], [0, 3],
    [1, 3], [1, 2], [1, 1], [1, 0],
    [2, 0], [2, 1], [2, 2], [2, 3],
  ];

  const conventional = run("yConventional");
  const climb = run("yClimb");
  const both = run("yBoth");
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const hasCutYMove = (result) => result.lines.some((l) => /^G1\b/.test(l) && /\bY-?\d+\.\d+\b/.test(l));

  const checks = [
    ["yConventional sweeps each column top-to-bottom", same(conventional.visited, expectedConventional), conventional.visited],
    ["yClimb sweeps each column bottom-to-top", same(climb.visited, expectedClimb), climb.visited],
    ["yBoth alternates columns and starts conventional", same(both.visited, expectedBoth), both.visited],
    ["yConventional emits G1 moves with Y words", hasCutYMove(conventional), conventional.lines],
    ["yClimb emits G1 moves with Y words", hasCutYMove(climb), climb.lines],
    ["yBoth emits G1 moves with Y words", hasCutYMove(both), both.lines],
  ];

  const pass = checks.every(([, ok]) => ok);
  return { pass, detail: { checks, lines: { conventional: conventional.lines, climb: climb.lines, both: both.lines } } };
};

window.__tests.sweepYBothSplitColumnRetractsAcrossGap = function () {
  const checks = [];
  const width = 1, height = 6;
  const cut = new Uint8Array(width * height);
  cut[0] = 1; cut[1] = 1;
  cut[4] = 1; cut[5] = 1;

  const lines = [];
  emitRasterSweepMoves({
    lines, cut, width, height, pixelSizeMm: 1, originMode: "center", rowStep: 1,
    direction: "yBoth", zAtFn: () => -1, safeZMm: 5, feedMmMin: 1000,
    plungeMmMin: 300, atSafeZ: true,
  });

  const secondSpanRapidIdx = lines.findIndex((l) => /^G0\b/.test(l) && /\bY-1\.500\b/.test(l));
  const unsafeFeedIdx = lines.findIndex((l) => /^G1\b/.test(l) && /\bY-1\.500\b/.test(l));
  const retractBefore = secondSpanRapidIdx > 0 && lines.slice(0, secondSpanRapidIdx).some((l) => l === "G0 Z5.000");
  checks.push(["second vertical span is reached by rapid after retract", secondSpanRapidIdx !== -1 && retractBefore, lines]);
  checks.push(["no G1 Y crosses vertical transparent gap", unsafeFeedIdx === -1, lines]);

  const pass = checks.every(([, ok]) => ok);
  return { pass, detail: { checks, lines } };
};

window.__tests.gcodeGeneratorGoldenOutput = function () {
  // Byte-exact snapshot of the full GCode both pass generators emit for fixed
  // fixtures. Guards any refactor of the emitter/streaming/header machinery:
  // if the produced GCode changes by even one character, this fails. Self-
  // verifying — a mistranscribed golden string fails against the live output.
  const checks = [];

  // --- Raster fixture (mirrors gcodeConventions) ---
  const W = 6, H = 4;
  const cut = new Uint8Array(W * H).fill(1);
  cut[0 * W + 5] = 0; cut[1 * W + 5] = 0;
  const heightMap = { width: W, height: H, gray: new Float32Array(W * H), cut: cut, bits: 8 };
  const targetSurface = new Float32Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++)
    targetSurface[y * W + x] = cut[y * W + x] === 1 ? -0.5 - 0.05 * x : -Infinity;
  const rtool = { id: "t1", name: "Test Tool!", shape: "flat", diameterMm: 3, radiusMm: 1.5, stepoverMm: 1, maxStepdownMm: 1, feedMmMin: 1234, plungeMmMin: 321, spindleRpm: 12000 };
  const rpass = { id: "p1", name: "TestPass", toolId: "t1", direction: "xConventional", stepoverMm: null, maxStepdownMm: null, allowanceMm: 0, enabled: true };
  const rjob = { imageName: "myimage.png", widthPx: W, heightPx: H, pixelSizeMm: 1, zeroMode: "stockTop", originMode: "lowerLeft", stockTopMm: 0, safeZMm: 5, passes: [rpass] };
  const remaining = initRemaining(heightMap, rjob.stockTopMm);
  const rasterGcode = generatePassGCode({ pass: rpass, tool: rtool, targetSurface: targetSurface, remaining: remaining, jobSpec: rjob, heightMap: heightMap, passIndex: 1, imageBase: "gold" }).gcode;
  const EXPECTED_RASTER = "; image: myimage.png\n; dimensions: 6x4 px\n; pixelSizeMm: 1  physical size: 6.000 x 4.000 mm\n; zeroMode: stockTop\n; originMode: lowerLeft\n; stockTopMm: 0\n; safeZMm: 5\n; tool: Test Tool!  shape: flat  diameterMm: 3\n; pass: TestPass  direction: xConventional  stepoverMm: 1  stepdownMm: 1  allowanceMm: 0\n; spindleRpm: 12000\n; commanded Z range: -0.75 to -0.50 mm\n; sweeps: 1\nG90\nG21\nG17\nM3 S12000\nG0 Z5.000\nG0 X0.500 Y0.500\nG1 Z-0.500 F321\nG1 X1.500 Z-0.550 F1234\nG1 X2.500 Z-0.600\nG1 X3.500 Z-0.650\nG1 X4.500 Z-0.700\nG1 X5.500 Z-0.750\nG0 Z5.000\nG0 X0.500 Y1.500\nG1 Z-0.500 F321\nG1 X1.500 Z-0.550 F1234\nG1 X2.500 Z-0.600\nG1 X3.500 Z-0.650\nG1 X4.500 Z-0.700\nG1 X5.500 Z-0.750\nG0 Z5.000\nG0 X0.500 Y2.500\nG1 Z-0.500 F321\nG1 X1.500 Z-0.550 F1234\nG1 X2.500 Z-0.600\nG1 X3.500 Z-0.650\nG1 X4.500 Z-0.700\nG0 Z5.000\nG0 X0.500 Y3.500\nG1 Z-0.500 F321\nG1 X1.500 Z-0.550 F1234\nG1 X2.500 Z-0.600\nG1 X3.500 Z-0.650\nG1 X4.500 Z-0.700\nG0 Z5.000\nG0 Z5.000\nM5\nM2\n";
  checks.push(["raster pass GCode is byte-identical to golden", rasterGcode === EXPECTED_RASTER, rasterGcode]);

  // --- Outline fixture (small central block) ---
  const OW = 20, OH = 20;
  const ocut = new Uint8Array(OW * OH);
  for (let y = 6; y < 14; y++) for (let x = 6; x < 14; x++) ocut[y * OW + x] = 1;
  const otool = { id: "t2", name: "OutlineTool", shape: "flat", diameterMm: 2, radiusMm: 1, stepoverMm: 1, maxStepdownMm: 1, feedMmMin: 900, plungeMmMin: 250, spindleRpm: 11000 };
  const opass = { id: "p2", name: "OutlinePass", toolId: "t2", direction: "outline", stepoverMm: null, maxStepdownMm: null, allowanceMm: 0, outlineWidthMm: 1.5, outlineDepthMm: -1, enabled: true };
  const ojob = { imageName: "outline.png", pixelSizeMm: 0.5, zeroMode: "stockTop", originMode: "center", stockTopMm: 0, safeZMm: 5 };
  const outlineGcode = generateOutlinePassGCode({ pass: opass, tool: otool, cut: ocut, width: OW, height: OH, jobSpec: ojob, passIndex: 1, imageBase: "gold" }).gcode;
  const EXPECTED_OUTLINE = "; image: outline.png\n; dimensions: 20x20 px\n; pixelSizeMm: 0.5  physical size: 10.000 x 10.000 mm\n; zeroMode: stockTop\n; originMode: center\n; stockTopMm: 0\n; safeZMm: 5\n; tool: OutlineTool  shape: flat  diameterMm: 2\n; pass: OutlinePass  direction: outline  outlineWidthMm: 1.5  outlineDepthMm: -1\n; spindleRpm: 11000\n; loopCount: 3  depthLevels: 1\n; commanded Z range: -1.00 to -1.00 mm\n; depth levels: 1\nG90\nG21\nG17\nM3 S11000\nG0 Z5.000\nG0 X-2.796 Y2.750\nG1 Z-1.000 F250\nG1 X-1.750 Y3.200 F900\nG1 X1.750\nG1 X2.750 Y2.796\nG1 X3.200 Y1.750\nG1 Y-1.750\nG1 X2.796 Y-2.750\nG1 X1.750 Y-3.200\nG1 X-1.750\nG1 X-2.750 Y-2.796\nG1 X-3.200 Y-1.750\nG1 Y1.750\nG1 X-2.796 Y2.750\nG0 Z5.000\nG0 X-3.155 Y3.750\nG1 Z-1.000 F250\nG1 X-1.750 Y4.200 F900\nG1 X1.750\nG1 X2.750 Y3.984\nG1 X3.684 Y3.250\nG1 X4.200 Y1.750\nG1 Y-1.750\nG1 X3.984 Y-2.750\nG1 X3.250 Y-3.684\nG1 X1.750 Y-4.200\nG1 X-1.750\nG1 X-2.750 Y-3.984\nG1 X-3.684 Y-3.250\nG1 X-4.200 Y-1.750\nG1 Y1.750\nG1 X-3.984 Y2.750\nG1 X-3.155 Y3.750\nG0 Z5.000\nG0 X-3.441 Y4.750\nG1 Z-1.000 F250\nG1 X-1.750 Y5.200 F900\nG1 X2.250 Y5.163\nG1 X3.441 Y4.750\nG1 X4.557 Y3.750\nG1 X5.163 Y2.250\nG1 Y-2.250\nG1 X4.750 Y-3.441\nG1 X3.750 Y-4.557\nG1 X2.250 Y-5.163\nG1 X-2.250\nG1 X-3.441 Y-4.750\nG1 X-4.557 Y-3.750\nG1 X-5.163 Y-2.250\nG1 Y2.250\nG1 X-4.557 Y3.750\nG1 X-3.441 Y4.750\nG0 Z5.000\nG0 Z5.000\nM5\nM2\n";
  checks.push(["outline pass GCode is byte-identical to golden", outlineGcode === EXPECTED_OUTLINE, outlineGcode]);

  const pass = checks.every((c) => c[1]);
  return { pass: pass, detail: { checks: checks } };
};

window.__tests.safeSurfaceFlat = function () {
  const { width, height, terrain, cx, cy, peakZ } = makeSpike5x5(10);
  const pixelSizeMm = 1;
  const radiusMm = 2;

  const ref = computeSafeSurfaceReference(terrain, width, height, pixelSizeMm, radiusMm, "flat");

  const checks = [];
  let withinRadiusOk = true;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const dx = x - cx, dy = y - cy;
      if (dx * dx + dy * dy <= 4) {
        if (ref[y * width + x] !== peakZ) withinRadiusOk = false;
      }
    }
  }
  checks.push(["pixels within radius 2 == 10", withinRadiusOk]);

  const corners = [ref[0], ref[width - 1], ref[(height - 1) * width], ref[height * width - 1]];
  const cornersOk = corners.every((v) => v === 0);
  checks.push(["corners == 0", cornersOk, corners]);

  const fast = computeSafeSurface(terrain, width, height, pixelSizeMm, radiusMm, "flat");
  let maxDiff = 0;
  for (let i = 0; i < ref.length; i++) {
    const d = Math.abs(ref[i] - fast[i]);
    if (d > maxDiff) maxDiff = d;
  }
  checks.push(["fast === reference elementwise", maxDiff === 0, maxDiff]);

  const pass = checks.every(([, ok]) => ok);
  return { pass, detail: { checks, maxDiff, ref: Array.from(ref) } };
};

/**
 * Test 5 (Design.md "Testing" #5): safe surface, ball. Same 5x5/center=10 map;
 * ball tool, radiusMm=2, pixelSizeMm=1. For every pixel at distance d<=2 from
 * center, safe ≈ 10 - (2 - sqrt(4-d^2)) (closed form) within tolerance; note
 * `safe` is a Float32Array (spec-mandated), so comparing to a float64 closed
 * form has an inherent ~1e-7 storage-rounding floor — see deviations note in
 * the Phase 5 report; we use 1e-6 rather than the spec's literal 1e-9.
 * Pixels beyond d>2 must be <=0. Also verifies computeSafeSurface matches the
 * reference within 1e-6 (observed: bit-exact, maxDiff 0). Uses the shared
 * makeSpike5x5() fixture (Design.md "Testing": "Ship 2 fixtures generated
 * in-code... a 5x5 single-spike").
 */
window.__tests.safeSurfaceBall = function () {
  const { width, height, terrain, cx, cy, peakZ } = makeSpike5x5(10);
  const pixelSizeMm = 1;
  const radiusMm = 2;

  const ref = computeSafeSurfaceReference(terrain, width, height, pixelSizeMm, radiusMm, "ball");

  const checks = [];
  let closedFormOk = true;
  let maxClosedFormDiff = 0;
  let beyondRadiusOk = true;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const dx = x - cx, dy = y - cy;
      const d = Math.hypot(dx, dy) * pixelSizeMm;
      const val = ref[y * width + x];
      if (d <= radiusMm) {
        const expected = peakZ - (radiusMm - Math.sqrt(radiusMm * radiusMm - d * d));
        const diff = Math.abs(val - expected);
        if (diff > maxClosedFormDiff) maxClosedFormDiff = diff;
        if (diff > 1e-6) closedFormOk = false;
      } else {
        if (!(val <= 0)) beyondRadiusOk = false;
      }
    }
  }
  checks.push(["within-radius matches closed form (<=1e-6)", closedFormOk, maxClosedFormDiff]);
  checks.push(["beyond-radius <= 0", beyondRadiusOk]);

  const fast = computeSafeSurface(terrain, width, height, pixelSizeMm, radiusMm, "ball");
  let maxDiff = 0;
  for (let i = 0; i < ref.length; i++) {
    const d = Math.abs(ref[i] - fast[i]);
    if (d > maxDiff) maxDiff = d;
  }
  checks.push(["fast matches reference (<=1e-6)", maxDiff <= 1e-6, maxDiff]);

  const pass = checks.every(([, ok]) => ok);
  return { pass, detail: { checks, maxClosedFormDiff, maxDiff, ref: Array.from(ref) } };
};

/**
 * Test (Design.md "Testing" #4/#5 decomposition-vs-reference requirement,
 * generalized): 3 deterministic pseudo-random terrains (seeded LCG, not
 * Math.random) of size ~24x18, values in [0,20] with a few -Infinity cells;
 * for radii {2,4}px and both shapes, computeSafeSurface must match
 * computeSafeSurfaceReference within 1e-6. Reports the max abs diff observed
 * across all seed/radius/shape combinations.
 */
window.__tests.safeSurfaceFastMatchesReference = function () {
  // Simple seeded LCG (Numerical Recipes constants) — deterministic, not
  // Math.random(), so results are reproducible across runs.
  function makeLcg(seed) {
    let state = seed >>> 0;
    return function () {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      return state / 4294967296;
    };
  }

  function makeTerrain(seed, width, height) {
    const rand = makeLcg(seed);
    const terrain = new Float32Array(width * height);
    for (let i = 0; i < width * height; i++) {
      const r = rand();
      if (r < 0.05) {
        terrain[i] = -Infinity;
      } else {
        terrain[i] = rand() * 20;
      }
    }
    return terrain;
  }

  const width = 24, height = 18;
  const seeds = [12345, 67890, 424242];
  const radii = [2, 4];
  const shapes = ["flat", "ball"];
  const pixelSizeMm = 1;

  const checks = [];
  let globalMaxDiff = 0;

  for (const seed of seeds) {
    const terrain = makeTerrain(seed, width, height);
    for (const radiusPx of radii) {
      const radiusMm = radiusPx * pixelSizeMm;
      for (const shape of shapes) {
        const ref = computeSafeSurfaceReference(terrain, width, height, pixelSizeMm, radiusMm, shape);
        const fast = computeSafeSurface(terrain, width, height, pixelSizeMm, radiusMm, shape);

        let maxDiff = 0;
        for (let i = 0; i < ref.length; i++) {
          if (ref[i] === -Infinity && fast[i] === -Infinity) continue;
          const d = Math.abs(ref[i] - fast[i]);
          if (d > maxDiff) maxDiff = d;
        }
        if (maxDiff > globalMaxDiff) globalMaxDiff = maxDiff;
        checks.push([`seed=${seed} radius=${radiusPx}px shape=${shape}`, maxDiff <= 1e-6, maxDiff]);
      }
    }
  }

  const pass = checks.every(([, ok]) => ok);
  return { pass, detail: { checks, globalMaxDiff } };
};

/**
 * Safe-surface sanity check on the shared makePyramid9x9() fixture (Design.md
 * "Testing": "Ship 2 fixtures generated in-code... a 9x9 pyramid"). The
 * pyramid has genuine local slope (unlike the single-spike fixture), so this
 * exercises the dilation over a non-trivial neighborhood and checks properties
 * that must hold for ANY terrain, for both flat and ball tools:
 *   (a) safe-surface is never below terrain (dilation only ever raises or
 *       matches the surface, per the "max over neighbors" definition).
 *   (b) the center pixel (the global max of this terrain) is unchanged by
 *       dilation — nothing can be higher than the peak, so max-over-neighbors
 *       at the peak is just the peak itself.
 *   (c) the outer-ring corner pixels (farthest from the peak, Chebyshev
 *       distance 4) are raised above their own terrain value once the tool
 *       radius reaches into the pyramid's higher interior — dilation should
 *       do *something* there, not leave them untouched, for a radius that
 *       comfortably spans several rings.
 *   (d) computeSafeSurface (O(N*r) decomposition) matches
 *       computeSafeSurfaceReference elementwise for both shapes (flat:
 *       exact; ball: within 1e-6 — same tolerance rationale as
 *       safeSurfaceBall above).
 */
window.__tests.safeSurfacePyramid = function () {
  const { width, height, terrain, cx, cy, peakZ } = makePyramid9x9(8, 1);
  const pixelSizeMm = 1;
  const radiusMm = 3; // spans 3 rings — comfortably into the pyramid's interior

  const checks = [];

  for (const shape of ["flat", "ball"]) {
    const ref = computeSafeSurfaceReference(terrain, width, height, pixelSizeMm, radiusMm, shape);
    const fast = computeSafeSurface(terrain, width, height, pixelSizeMm, radiusMm, shape);

    // (a) never below terrain.
    let neverBelowTerrain = true;
    let minSlack = Infinity;
    for (let i = 0; i < ref.length; i++) {
      const slack = ref[i] - terrain[i];
      if (slack < minSlack) minSlack = slack;
      if (slack < -1e-6) neverBelowTerrain = false;
    }
    checks.push([`(a) shape=${shape}: safe >= terrain everywhere`, neverBelowTerrain, minSlack]);

    // (b) center (global peak) unchanged.
    const centerIdx = cy * width + cx;
    const centerOk = Math.abs(ref[centerIdx] - peakZ) < 1e-6;
    checks.push([`(b) shape=${shape}: center stays at peak (${peakZ})`, centerOk, ref[centerIdx]]);

    // (c) outer-ring corners raised above their own terrain value.
    const corners = [
      [0, 0], [width - 1, 0], [0, height - 1], [width - 1, height - 1],
    ];
    let cornersRaised = true;
    const cornerDetail = [];
    for (const [x, y] of corners) {
      const i = y * width + x;
      const raised = ref[i] > terrain[i] + 1e-6;
      cornerDetail.push({ x, y, terrain: terrain[i], safe: ref[i] });
      if (!raised) cornersRaised = false;
    }
    checks.push([`(c) shape=${shape}: outer corners raised above own terrain`, cornersRaised, cornerDetail]);

    // (d) fast === reference (flat: exact; ball: within 1e-6).
    let maxDiff = 0;
    for (let i = 0; i < ref.length; i++) {
      const d = Math.abs(ref[i] - fast[i]);
      if (d > maxDiff) maxDiff = d;
    }
    const tol = shape === "flat" ? 0 : 1e-6;
    checks.push([`(d) shape=${shape}: fast matches reference (<=${tol})`, maxDiff <= tol, maxDiff]);
  }

  const pass = checks.every(([, ok]) => ok);
  return { pass, detail: { checks } };
};

/**
 * Test 7 (Design.md "Testing" #7): GCode conventions. Builds a small 6x4
 * in-memory fixture (a couple of transparent/non-cut pixels), a flat tool, a
 * single "xConventional" pass, and a hand-made targetSurface Float32Array with a
 * shallow slope (so "surface following" can be checked exactly and the
 * multi-sweep loop (Phase 7) converges in a single sweep, given
 * maxStepdownMm=1 and a max target depth of 0.75mm below stockTopMm=0), then
 * calls generatePassGCode (Phase 7 signature: remaining REQUIRED) and asserts
 * the required GCode-format conventions.
 */
window.__tests.gcodeConventions = function () {
  const checks = [];

  const width = 6, height = 4;
  const cut = new Uint8Array(width * height).fill(1);
  // A couple of transparent (non-cut) pixels, e.g. top-right corner pixels.
  cut[0 * width + 5] = 0; // (5,0)
  cut[1 * width + 5] = 0; // (5,1)

  const heightMap = { width, height, gray: new Float32Array(width * height), cut, bits: 8 };

  // Hand-made target surface with a shallow slope: targetSurface[y*w+x] =
  // -0.5 - 0.05*x (a simple linear ramp so per-pixel Z is deterministic and
  // easy to check). Max depth is 0.75mm, well within a single sweep's
  // maxStepdownMm=1 starting from stockTopMm=0, so this test exercises
  // exactly one sweep (asserted below via result.sweeps === 1).
  const targetSurface = new Float32Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      targetSurface[y * width + x] = cut[y * width + x] === 1 ? -0.5 - 0.05 * x : -Infinity;
    }
  }

  const tool = {
    id: "t1", name: "Test Tool!", shape: "flat", diameterMm: 3, radiusMm: 1.5,
    stepoverMm: 1, maxStepdownMm: 1, feedMmMin: 1234, plungeMmMin: 321, spindleRpm: 12000,
  };
  const pass = {
    id: "p1", name: "TestPass", toolId: "t1", direction: "xConventional",
    stepoverMm: null, maxStepdownMm: null, allowanceMm: 0, enabled: true,
  };
  const jobSpec = {
    imageName: "myimage.png", widthPx: width, heightPx: height, pixelSizeMm: 1,
    zeroMode: "stockTop", originMode: "lowerLeft", stockTopMm: 0, safeZMm: 5,
    passes: [pass],
  };

  const remaining = initRemaining(heightMap, jobSpec.stockTopMm);

  const savedImageBaseName = currentImageBaseName;
  currentImageBaseName = "myimage";
  let result;
  try {
    result = generatePassGCode({ pass, tool, targetSurface, remaining, jobSpec, heightMap, passIndex: 1 });
  } finally {
    currentImageBaseName = savedImageBaseName;
  }

  checks.push(["converges in a single sweep", result.sweeps === 1, result.sweeps]);

  const gcode = result.gcode;
  const nonEmptyLines = gcode.split("\n").filter((l) => l.trim() !== "");

  checks.push(["contains M3 S<rpm>", /\bM3 S\d+\b/.test(gcode)]);
  checks.push(["contains G90", /\bG90\b/.test(gcode)]);
  checks.push(["contains G21", /\bG21\b/.test(gcode)]);
  checks.push(["contains G17", /\bG17\b/.test(gcode)]);

  const motionLines = nonEmptyLines.filter((l) => /^(G0|G1)\b/.test(l));
  checks.push([
    "first motion line explicitly raises to safe Z",
    motionLines[0] === `G0 Z${formatCoord(jobSpec.safeZMm)}`,
    motionLines[0],
  ]);

  const streamedChunks = [];
  const streamedRemaining = initRemaining(heightMap, jobSpec.stockTopMm);
  const streamedResult = generatePassGCode({
    pass, tool, targetSurface, remaining: streamedRemaining, jobSpec, heightMap, passIndex: 1,
    imageBase: "myimage", onChunk: (chunk) => streamedChunks.push(chunk),
  });
  const streamedMotionLines = streamedChunks.join("").split("\n").filter((l) => /^(G0|G1)\b/.test(l));
  checks.push([
    "streamed first motion line explicitly raises to safe Z",
    streamedResult.gcode === null && streamedMotionLines[0] === `G0 Z${formatCoord(jobSpec.safeZMm)}`,
    { gcode: streamedResult.gcode, firstMotion: streamedMotionLines[0] },
  ]);

  const lastTwo = nonEmptyLines.slice(-2);
  checks.push(["second-to-last non-empty line is M5", lastTwo[0] === "M5", lastTwo]);
  checks.push(["last non-empty line is M2", lastTwo[1] === "M2", lastTwo]);

  // No standalone M0 (word-boundary; M03/M05 etc. must NOT trigger this).
  const hasM0 = /\bM0\b/.test(gcode);
  checks.push(["contains no M0", !hasM0]);

  // All X/Y/Z numbers have exactly 3 decimals.
  const coordNumbers = gcode.match(/[XYZ]-?\d+\.\d+/g) || [];
  const allThreeDecimals = coordNumbers.length > 0 && coordNumbers.every((tok) => {
    const numPart = tok.slice(1);
    const decimals = numPart.split(".")[1];
    return decimals && decimals.length === 3;
  });
  checks.push(["all X/Y/Z numbers have exactly 3 decimals", allThreeDecimals, coordNumbers.slice(0, 10)]);

  // Filename matches <base>_1_<sanitized>.nc.
  const expectedFilename = "myimage_1_Test_Tool_.nc";
  checks.push(["filename matches <base>_1_<sanitized>.nc", result.filename === expectedFilename, result.filename]);

  // Surface following (on the final — here, only — sweep): every effective
  // G1 cutting move's modal Z equals targetSurface at the px/py it
  // corresponds to, within 1e-3. Reconstruct expected Z values by replaying
  // the same row-track/span traversal generatePassGCode uses (xConventional, rowStep=1)
  // and compare against modal-replayed G1 Z values in order. Valid because
  // this fixture converges in exactly one sweep (asserted above).
  const g1ZValues = [];
  let modalZ = null;
  for (const line of nonEmptyLines) {
    if (!/^(G0|G1)\b/.test(line)) continue;
    const zMatch = line.match(/\bZ(-?\d+\.\d+)/);
    if (zMatch) modalZ = parseFloat(zMatch[1]);
    if (/^G1\b/.test(line) && modalZ !== null) {
      g1ZValues.push(modalZ);
    }
  }
  const expectedZValues = [];
  for (let py = height - 1; py >= 0; py--) {
    const spans = findRowSpans(cut, width, py);
    for (const [s, e] of spans) {
      for (let px = s; px <= e; px++) {
        expectedZValues.push(targetSurface[py * width + px]);
      }
    }
  }
  let surfaceFollowingOk = g1ZValues.length === expectedZValues.length;
  let maxZDiff = 0;
  if (surfaceFollowingOk) {
    for (let i = 0; i < g1ZValues.length; i++) {
      const d = Math.abs(g1ZValues[i] - expectedZValues[i]);
      if (d > maxZDiff) maxZDiff = d;
      if (d > 1e-3) surfaceFollowingOk = false;
    }
  }
  checks.push([
    "cut-move Z values equal targetSurface (surface following, <=1e-3)",
    surfaceFollowingOk,
    { emittedCount: g1ZValues.length, expectedCount: expectedZValues.length, maxZDiff },
  ]);

  const pass_ = checks.every(([, ok]) => ok);
  return { pass: pass_, detail: { checks, filename: result.filename, zMin: result.zMin, zMax: result.zMax, sweeps: result.sweeps } };
};

/**
 * Regression test: in "xBoth" passes, emitRasterSweepMoves must NOT retract
 * to safe Z between clear adjacent tracks. One-way X sweeps retract per track;
 * xBoth instead uses a minimal transition:
 * travel XY at feed speed at the higher of {current Z, next-start Z}, then
 * step to the start Z (raise-then-move if the next start is raised above
 * current, else move-then-plunge).
 *
 * Calls emitRasterSweepMoves directly (rather than going through
 * generatePassGCode) so the test is a single deterministic sweep with no
 * multi-sweep looping and no footer retract to account for. Fixture: a 5x3
 * all-cut map with two hand-picked Z functions — `zRaise`, where each next
 * row's start is higher than the prior row's end (exercises the
 * raise-then-move branch), and `zPlunge`, where each next row's start is
 * lower (exercises the move-then-plunge branch). Both expected outputs are
 * exact literal transcriptions of real emitRasterSweepMoves output, captured
 * directly from the implementation, so this is also a golden/
 * characterization check. An "xConventional" control run of the zRaise fixture
 * confirms the no-mid-sweep-retract behavior is xBoth-specific (xConventional
 * still retracts once per row).
 */
window.__tests.sweepXBothNoSafeRetractBetweenRows = function () {
  const checks = [];

  const width = 5, height = 3, pixelSizeMm = 1;
  const cut = new Uint8Array(width * height).fill(1); // every pixel cut

  // Next-row start Z is HIGHER than the prior row's end Z -> raise-then-move.
  const zRaise = (px, py) => -(py * 0.2) - (px * 0.05);
  // Next-row start Z is LOWER than the prior row's end Z -> move-then-plunge.
  const zPlunge = (px, py) => (py * 0.2) - (px * 0.05);

  function run(zAtFn, direction) {
    const lines = [];
    emitRasterSweepMoves({
      lines, cut, width, height, pixelSizeMm, originMode: "center", rowStep: 1,
      direction, zAtFn, safeZMm: 5, feedMmMin: 1000, plungeMmMin: 300,
      atSafeZ: true, modalState: {},
    });
    return lines;
  }

  const isSafeRetract = (l) => l.startsWith("G0") && /(^| )Z5\.000($| )/.test(l);

  // --- Golden fixtures: exact captured output from emitRasterSweepMoves. ---
  const expectedRaiseXBoth = [
    "G0 X-2.000 Y-1.000",
    "G1 Z-0.400 F300",
    "G1 X-1.000 Z-0.450 F1000",
    "G1 X0.000 Z-0.500",
    "G1 X1.000 Z-0.550",
    "G1 X2.000 Z-0.600",
    "G0 Z-0.400",
    "G1 Y0.000",
    "G1 X1.000 Z-0.350",
    "G1 X0.000 Z-0.300",
    "G1 X-1.000 Z-0.250",
    "G1 X-2.000 Z-0.200",
    "G0 Z0.000",
    "G1 Y1.000",
    "G1 X-1.000 Z-0.050",
    "G1 X0.000 Z-0.100",
    "G1 X1.000 Z-0.150",
    "G1 X2.000 Z-0.200",
    "G0 Z5.000",
  ];
  const expectedPlungeXBoth = [
    "G0 X-2.000 Y-1.000",
    "G1 Z0.400 F300",
    "G1 X-1.000 Z0.350 F1000",
    "G1 X0.000 Z0.300",
    "G1 X1.000 Z0.250",
    "G1 X2.000 Z0.200",
    "G1 Y0.000",
    "G1 Z0.000 F300",
    "G1 X1.000 Z0.050 F1000",
    "G1 X0.000 Z0.100",
    "G1 X-1.000 Z0.150",
    "G1 X-2.000 Z0.200",
    "G1 Y1.000",
    "G1 Z0.000 F300",
    "G1 X-1.000 Z-0.050 F1000",
    "G1 X0.000 Z-0.100",
    "G1 X1.000 Z-0.150",
    "G1 X2.000 Z-0.200",
    "G0 Z5.000",
  ];

  const raiseXBoth = run(zRaise, "xBoth");
  const plungeXBoth = run(zPlunge, "xBoth");
  const raiseXConventional = run(zRaise, "xConventional");

  const arraysEqual = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);

  checks.push([
    "golden: run(zRaise, 'xBoth') matches captured expected output exactly",
    arraysEqual(raiseXBoth, expectedRaiseXBoth),
    raiseXBoth,
  ]);
  checks.push([
    "golden: run(zPlunge, 'xBoth') matches captured expected output exactly",
    arraysEqual(plungeXBoth, expectedPlungeXBoth),
    plungeXBoth,
  ]);

  // 1. zRaise/xBoth: exactly one safe retract, and it is the last line.
  const raiseXBothRetracts = raiseXBoth.filter(isSafeRetract);
  checks.push([
    "xBoth (raise fixture): exactly 1 safe-Z retract, and it is the last line",
    raiseXBothRetracts.length === 1 && isSafeRetract(raiseXBoth[raiseXBoth.length - 1]),
    { count: raiseXBothRetracts.length, lastLine: raiseXBoth[raiseXBoth.length - 1] },
  ]);

  // 2. zPlunge/xBoth: exactly one safe retract, and it is the last line.
  const plungeXBothRetracts = plungeXBoth.filter(isSafeRetract);
  checks.push([
    "xBoth (plunge fixture): exactly 1 safe-Z retract, and it is the last line",
    plungeXBothRetracts.length === 1 && isSafeRetract(plungeXBoth[plungeXBoth.length - 1]),
    { count: plungeXBothRetracts.length, lastLine: plungeXBoth[plungeXBoth.length - 1] },
  ]);

  // 3. xConventional control: exactly 3 safe retracts (one per cut row) proves
  // the no-mid-sweep-retract behavior is xBoth-only.
  const raiseXConventionalRetracts = raiseXConventional.filter(isSafeRetract);
  checks.push([
    "xConventional control (raise fixture): exactly 3 safe-Z retracts",
    raiseXConventionalRetracts.length === 3,
    { count: raiseXConventionalRetracts.length },
  ]);

  // 4. Raise transitions: G0 Z<non-safe> lines (the "raise first" step)
  // appear exactly twice (once per inter-row transition), and no G1 F300
  // (plunge) line occurs after the first one — raises use G0, never a plunge.
  const raiseNonSafeG0Z = raiseXBoth.filter(
    (l) => l.startsWith("G0") && /\bZ(-?\d+\.\d+)\b/.test(l) && !isSafeRetract(l)
  );
  const firstPlungeIdx = raiseXBoth.findIndex((l) => l.startsWith("G1") && /\bF300\b/.test(l));
  const laterPlunges = raiseXBoth
    .slice(firstPlungeIdx + 1)
    .filter((l) => l.startsWith("G1") && /\bF300\b/.test(l));
  checks.push([
    "xBoth (raise fixture): exactly 2 raise-transition G0 Z moves, no plunge (F300) after the initial one",
    raiseNonSafeG0Z.length === 2 && laterPlunges.length === 0,
    { raiseNonSafeG0Z, laterPlunges },
  ]);

  // 5. Plunge transitions: G1 lines carrying F300 (plunge feed) appear
  // exactly 3 times (1 initial start plunge + 2 inter-row plunges); each
  // inter-row plunge is immediately preceded by a G1 X/Y feed move with no Z word.
  const plungeFeedLines = [];
  plungeXBoth.forEach((l, i) => {
    if (l.startsWith("G1") && /\bF300\b/.test(l)) plungeFeedLines.push(i);
  });
  const interRowPlungeIdxs = plungeFeedLines.slice(1); // skip the initial start plunge
  const interRowPlungesPrecededByBareG1 = interRowPlungeIdxs.every((i) => {
    const prev = plungeXBoth[i - 1] || "";
    return prev.startsWith("G1") && /\bY/.test(prev) && !/\bZ/.test(prev);
  });
  checks.push([
    "xBoth (plunge fixture): exactly 3 F300 plunge lines, each inter-row one preceded by a bare G1 X/Y move",
    plungeFeedLines.length === 3 && interRowPlungesPrecededByBareG1,
    { plungeFeedLines: plungeFeedLines.map((i) => plungeXBoth[i]), interRowPlungesPrecededByBareG1 },
  ]);

  // 6. Surface following intact: the modal Z commanded for each cut pixel
  // matches zRaise at that pixel. Replays the same row/px traversal
  // emitRasterSweepMoves uses (xBoth alternates row direction, starting
  // xConventional). A row's first pixel is reached by a G1 line: either the initial
  // row-start plunge, or the inter-row XY feed after any upward G0 Z raise.
  // Every other pixel is set by an ordinary "G1 X.. Z.." cut move, so the
  // checkpoints are the modal Z value at every G1 line.
  const expectedRaiseCutZs = [];
  for (let rowIndex = 0, py = height - 1; py >= 0; py--, rowIndex++) {
    const rowLtr = rowIndex % 2 === 0;
    if (rowLtr) {
      for (let px = 0; px < width; px++) expectedRaiseCutZs.push(zRaise(px, py));
    } else {
      for (let px = width - 1; px >= 0; px--) expectedRaiseCutZs.push(zRaise(px, py));
    }
  }
  const raiseCutZs = [];
  let modalZForCuts = null;
  for (const line of raiseXBoth) {
    const zMatch = line.match(/\bZ(-?\d+\.\d+)\b/);
    if (zMatch) modalZForCuts = parseFloat(zMatch[1]);
    if (line.startsWith("G1") && modalZForCuts !== null) {
      raiseCutZs.push(modalZForCuts);
    }
  }
  let surfaceFollowingOk = raiseCutZs.length === expectedRaiseCutZs.length;
  let maxZDiff = 0;
  if (surfaceFollowingOk) {
    for (let i = 0; i < raiseCutZs.length; i++) {
      const d = Math.abs(raiseCutZs[i] - expectedRaiseCutZs[i]);
      if (d > maxZDiff) maxZDiff = d;
      if (d > 1e-3) surfaceFollowingOk = false;
    }
  }
  checks.push([
    "xBoth (raise fixture): cut-move Z values match zRaise(px, py) at each traversed pixel (<=1e-3)",
    surfaceFollowingOk,
    { emittedCount: raiseCutZs.length, expectedCount: expectedRaiseCutZs.length, maxZDiff },
  ]);

  const pass_ = checks.every(([, ok]) => ok);
  return { pass: pass_, detail: { checks } };
};

/**
 * Modal word output: per Design.md "GCode Output" ("Omit a word if the axis
 * value is unchanged from the previous move"), X/Y/Z/F words must only be
 * written when they differ from the previously emitted modal value. Builds a
 * small flat-target fixture (every cut pixel commands the exact same Z) with
 * 2 rows x a 4px span each, `direction: "xConventional"`, converging in a single sweep
 * (shallow target vs. the stepdown budget, same trick as gcodeConventions
 * above). The flat same-Z rows should collapse to one endpoint cut move per
 * row, while still preserving the plunge/cut feed transition.
 */
window.__tests.feedWordOmittedWhenUnchanged = function () {
  const checks = [];

  const width = 4, height = 2;
  const cut = new Uint8Array(width * height).fill(1); // both rows fully cut, span = [0,3] (4px, >=3 required)

  const heightMap = { width, height, gray: new Float32Array(width * height), cut, bits: 8 };

  // Flat target: every cut pixel commands the exact same Z, so every cut
  // move within a row (after the plunge) repeats the same feed as the move
  // before it. Shallow (0.4mm) vs. maxStepdownMm=1 from stockTopMm=0, so
  // this converges in exactly one sweep.
  const targetSurface = new Float32Array(width * height).fill(-0.4);

  const tool = {
    id: "t1", name: "FeedTestTool", shape: "flat", diameterMm: 3, radiusMm: 1.5,
    stepoverMm: 1, maxStepdownMm: 1, feedMmMin: 1500, plungeMmMin: 400, spindleRpm: 10000,
  };
  const pass = {
    id: "p1", name: "FeedTestPass", toolId: "t1", direction: "xConventional",
    stepoverMm: null, maxStepdownMm: null, allowanceMm: 0, enabled: true,
  };
  const jobSpec = {
    imageName: "feedtest.png", widthPx: width, heightPx: height, pixelSizeMm: 1,
    zeroMode: "stockTop", originMode: "lowerLeft", stockTopMm: 0, safeZMm: 5,
    passes: [pass],
  };

  const remaining = initRemaining(heightMap, jobSpec.stockTopMm);

  const savedImageBaseName = currentImageBaseName;
  currentImageBaseName = "feedtest";
  let result;
  try {
    result = generatePassGCode({ pass, tool, targetSurface, remaining, jobSpec, heightMap, passIndex: 1 });
  } finally {
    currentImageBaseName = savedImageBaseName;
  }

  checks.push(["converges in a single sweep", result.sweeps === 1, result.sweeps]);
  checks.push(["distinct plunge/cut feeds (fixture precondition)", tool.feedMmMin !== tool.plungeMmMin, { feed: tool.feedMmMin, plunge: tool.plungeMmMin }]);

  const gcode = result.gcode;
  const nonEmptyLines = gcode.split("\n").filter((l) => l.trim() !== "");
  const g1Lines = nonEmptyLines.filter((l) => l.startsWith("G1 "));

  // Each row (4px span) should emit 2 G1 lines after constant-Z run
  // collapsing: 1 plunge + 1 endpoint cut. 2 rows => 4 G1 lines total.
  checks.push(["expected collapsed G1 line count (2 rows x plunge+endpoint)", g1Lines.length === 4, g1Lines.length]);

  // The very first G1 line in the whole file must include an explicit F
  // word — there is no prior modal feed to rely on.
  const firstHasF = g1Lines.length > 0 && /\bF\d+\b/.test(g1Lines[0]);
  checks.push(["first G1 line includes an F word", firstHasF, g1Lines[0]]);

  // Semantic-transparency / GRBL-modal simulation: walk every G1 line in
  // order, tracking "last explicit F" (starts undefined, updates whenever a
  // line carries an F word). Reconstruct the "effective feed" per line and
  // confirm it's ALWAYS defined (no line ever relies on a modal F that was
  // never actually commanded), and specifically confirm:
  //   - the plunge (1st G1 in each span) explicitly carries F, and that F
  //     equals plungeMmMin the first time (no prior modal feed at all) and
  //     re-emits F on every subsequent plunge too (since it always differs
  //     from the preceding cut move's feed in this fixture).
  //   - consecutive same-value cut moves within a span do NOT re-emit F.
  let lastExplicitF; // undefined until the first F word is seen
  let everUndefinedEffectiveFeed = false;
  const reconstructed = [];
  const plungeIndices = []; // index into g1Lines of each span's first (plunge) line
  for (let i = 0; i < g1Lines.length; i++) {
    const line = g1Lines[i];
    const m = line.match(/\bF(\d+)\b/);
    if (m) lastExplicitF = m[1];
    if (lastExplicitF === undefined) everUndefinedEffectiveFeed = true;
    reconstructed.push(lastExplicitF);
    // A plunge line has no X token; a cut-follow line carries X and may
    // inherit unchanged Z/F modal values.
    if (!/^G1 X/.test(line)) plungeIndices.push(i);
  }
  checks.push(["effective feed always defined (GRBL-modal replay)", !everUndefinedEffectiveFeed, reconstructed]);

  const plungeFeedStr = String(Math.round(tool.plungeMmMin));
  const cutFeedStr = String(Math.round(tool.feedMmMin));
  checks.push(["exactly 2 plunge lines (one per row)", plungeIndices.length === 2, plungeIndices]);

  const everyPlungeHasF = plungeIndices.every((i) => /\bF\d+\b/.test(g1Lines[i]));
  checks.push(["every plunge line explicitly carries F (differs from preceding cut feed)", everyPlungeHasF, plungeIndices.map((i) => g1Lines[i])]);

  const everyPlungeReconstructsToPlungeFeed = plungeIndices.every((i) => reconstructed[i] === plungeFeedStr);
  checks.push(["every plunge's effective feed equals plungeMmMin", everyPlungeReconstructsToPlungeFeed, { expected: plungeFeedStr, got: plungeIndices.map((i) => reconstructed[i]) }]);

  const endpointCutIndices = plungeIndices.map((i) => i + 1).filter((i) => i < g1Lines.length);
  const endpointCutLines = endpointCutIndices.map((i) => g1Lines[i]);

  const oneEndpointCutPerRow = endpointCutLines.length === 2 && endpointCutLines.every((line) => /^G1 X3\.500\b/.test(line));
  checks.push(["constant-Z rows collapse to one endpoint cut move per row", oneEndpointCutPerRow, endpointCutLines]);

  // The endpoint cut after each plunge must re-emit F (plunge -> cut
  // transition, values differ), but must NOT re-emit Z because the flat
  // target has the same modal Z as the plunge.
  const endpointCutsReemitF = endpointCutLines.every((line) => /\bF\d+\b/.test(line));
  checks.push(["endpoint cut moves re-emit F (plunge->cut transition)", endpointCutsReemitF, endpointCutLines]);

  const endpointCutsOmitUnchangedZ = endpointCutLines.every((line) => !/\bZ-?\d+\.\d+\b/.test(line));
  checks.push(["collapsed endpoint cut moves omit unchanged Z", endpointCutsOmitUnchangedZ, endpointCutLines]);

  const everyEndpointCutReconstructsToCutFeed = endpointCutIndices.every((i) => reconstructed[i] === cutFeedStr);
  checks.push(["every endpoint cut's effective feed equals feedMmMin", everyEndpointCutReconstructsToCutFeed, { expected: cutFeedStr, got: endpointCutIndices.map((i) => reconstructed[i]) }]);

  const pass_ = checks.every(([, ok]) => ok);
  return { pass: pass_, detail: { checks, g1Lines, reconstructed } };
};

/**
 * Test 3 (Design.md "Testing" #3): mask skip — "pixels with cut===0 never
 * appear in any cut move." Builds a small 10x8 heightMap with a block of
 * cut===0 ("transparent") pixels punched out of the interior (not just at the
 * edges, so row spans genuinely have to split around a hole rather than just
 * stopping early), generates one pass's GCode (xConventional, single sweep), then
 * inverts pixelCenterToMachineXY to map every effective G1 cutting position
 * back to the nearest source pixel and asserts:
 *   - every CUTTING move (modal `G1` at/below stockTopMm, even if unchanged
 *     X/Y/Z words are omitted) lands on a pixel with cut===1.
 *   - rapids (G0) are allowed to pass over cut===0 pixels (only their X/Y is
 *     used to reposition; they never remove material) — not asserted against,
 *     per the task's "rapids that merely pass over are fine" carve-out.
 *
 * Coordinate inversion is the exact algebraic inverse of
 * pixelCenterToMachineXY's two branches (Design.md "Zero & Origin"):
 *   center:    px = Xmm/pixelSizeMm - 0.5 + width/2   (and analogous for py/Y)
 *   lowerLeft: px = Xmm/pixelSizeMm - 0.5
 * then rounded to the nearest integer pixel (the forward transform maps
 * integer px/py to pixel centers, so any move this code emits at a pixel
 * center inverts back to within floating-point epsilon of that integer).
 */
window.__tests.maskSkip = function () {
  const width = 10, height = 8;
  const cut = new Uint8Array(width * height).fill(1);
  // Punch a 3x3 hole of cut===0 pixels out of the interior, e.g. columns
  // 4..6, rows 2..4 (well away from every edge), so row spans on rows 2-4
  // must split into a left run and a right run around the hole.
  for (let y = 2; y <= 4; y++) {
    for (let x = 4; x <= 6; x++) {
      cut[y * width + x] = 0;
    }
  }
  const heightMap = { width, height, gray: new Float32Array(width * height), cut, bits: 8 };

  const pixelSizeMm = 1;
  const originMode = "lowerLeft";
  const stockTopMm = 0;
  const safeZMm = 5;

  // Flat terrain (well within a single sweep) so this test exercises exactly
  // the row-track/span/mask logic, not multi-sweep stepping.
  const targetSurface = new Float32Array(width * height);
  for (let i = 0; i < targetSurface.length; i++) {
    targetSurface[i] = cut[i] === 1 ? -1 : -Infinity;
  }

  const tool = {
    id: "t1", name: "mask_test_tool", shape: "flat", diameterMm: 2, radiusMm: 1,
    stepoverMm: 1, maxStepdownMm: 5, feedMmMin: 1000, plungeMmMin: 300, spindleRpm: 10000,
  };
  const pass = {
    id: "p1", name: "MaskSkipPass", toolId: "t1", direction: "xConventional",
    stepoverMm: null, maxStepdownMm: null, allowanceMm: 0, enabled: true,
  };
  const jobSpec = {
    imageName: "masktest.png", widthPx: width, heightPx: height, pixelSizeMm,
    zeroMode: "stockTop", originMode, stockTopMm, safeZMm,
    passes: [pass],
  };

  const remaining = initRemaining(heightMap, stockTopMm);
  const result = generatePassGCode({ pass, tool, targetSurface, remaining, jobSpec, heightMap, passIndex: 1 });

  const checks = [];
  checks.push(["converges in a single sweep", result.sweeps === 1, result.sweeps]);

  // Invert pixelCenterToMachineXY for the fixture's originMode ("lowerLeft").
  function machineXYToNearestPixel(xMm, yMm) {
    const pxFloat = xMm / pixelSizeMm - 0.5;
    const pyFloat = height - (yMm / pixelSizeMm + 0.5);
    return { px: Math.round(pxFloat), py: Math.round(pyFloat) };
  }

  // Sanity-check the inversion is a true inverse of the forward transform
  // (round-trip every pixel center exactly) before trusting it below.
  let roundTripOk = true;
  for (let py = 0; py < height; py++) {
    for (let px = 0; px < width; px++) {
      const { x, y } = pixelCenterToMachineXY(px, py, pixelSizeMm, width, height, originMode);
      const back = machineXYToNearestPixel(x, y);
      if (back.px !== px || back.py !== py) roundTripOk = false;
    }
  }
  checks.push(["coordinate inversion round-trips every pixel center exactly", roundTripOk]);

  // Parse every line: track modal X/Y/Z coordinates. A cutting move is any
  // G1 line whose effective modal Z is at/below stockTopMm; unchanged Z may
  // be omitted on follow-on `G1 X...` moves, so literal Z-word presence is
  // not required here. G0 retracts/rapids are excluded by construction.
  const lines = result.gcode.split("\n");
  let lastX = null;
  let lastY = null;
  let lastZ = null;
  let cuttingMovesChecked = 0;
  let maskViolations = [];

  for (const line of lines) {
    const isG1 = /^G1\b/.test(line);
    const isG0 = /^G0\b/.test(line);
    if (!isG1 && !isG0) continue;

    const xMatch = line.match(/X(-?\d+\.\d+)/);
    const yMatch = line.match(/Y(-?\d+\.\d+)/);
    const zMatch = line.match(/Z(-?\d+\.\d+)/);
    if (xMatch) lastX = parseFloat(xMatch[1]);
    if (yMatch) lastY = parseFloat(yMatch[1]);
    if (zMatch) lastZ = parseFloat(zMatch[1]);

    if (isG1 && lastZ !== null && lastZ <= stockTopMm && lastX !== null && lastY !== null) {
      // A cutting move: G1 at/below stock top, evaluated at modal X/Y.
      cuttingMovesChecked++;
      const { px, py } = machineXYToNearestPixel(lastX, lastY);
      const inBounds = px >= 0 && px < width && py >= 0 && py < height;
      const onCutPixel = inBounds && cut[py * width + px] === 1;
      if (!onCutPixel) {
        maskViolations.push({ line, px, py, inBounds, cutValue: inBounds ? cut[py * width + px] : null });
      }
    }
  }

  checks.push(["at least one cutting move was actually checked", cuttingMovesChecked > 0, cuttingMovesChecked]);
  checks.push(["no cutting move lands on a cut===0 (or out-of-bounds) pixel", maskViolations.length === 0, maskViolations.slice(0, 5)]);

  const pass_ = checks.every(([, ok]) => ok);
  return { pass: pass_, detail: { checks, cuttingMovesChecked, violationCount: maskViolations.length } };
};

/**
 * Test 6 (Design.md "Testing" #6): remaining material — single-stamp check.
 * A small 7x7 all-cut map, `remaining` initialized to 10 everywhere. Stamp a
 * FLAT tool of radius 2px (pixelSizeMm=1) at the center pixel (3,3) with
 * center Z zc=2. Asserts: every pixel within 2px of center (dx^2+dy^2<=4) is
 * lowered to exactly 2 (flat -> offset 0 everywhere in the footprint); every
 * pixel outside that radius is unchanged at 10.
 */
window.__tests.remainingStamp = function () {
  const width = 7, height = 7;
  const cut = new Uint8Array(width * height).fill(1);
  const heightMap = { width, height, cut };
  const stockTopMm = 10;

  const remaining = initRemaining(heightMap, stockTopMm);
  const initOk = remaining.every((v) => v === 10);

  const cx = 3, cy = 3;
  const radiusMm = 2;
  const pixelSizeMm = 1;
  const zc = 2;
  stampToolFootprint(remaining, width, height, cx, cy, zc, radiusMm, pixelSizeMm, "flat");

  let withinOk = true;
  let outsideOk = true;
  const withinDetails = [];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const dx = x - cx, dy = y - cy;
      const d2 = dx * dx + dy * dy;
      const v = remaining[y * width + x];
      if (d2 <= 4) {
        if (v !== 2) {
          withinOk = false;
          withinDetails.push({ x, y, v });
        }
      } else {
        if (v !== 10) outsideOk = false;
      }
    }
  }

  const checks = [
    ["remaining initialized to stockTopMm everywhere (all-cut map)", initOk],
    ["every pixel within radius 2px === zc (2)", withinOk, withinDetails],
    ["every pixel outside radius 2px unchanged (10)", outsideOk],
  ];

  const pass = checks.every(([, ok]) => ok);
  return { pass, detail: { checks, remaining: Array.from(remaining) } };
};

/**
 * Design.md "Remaining-Material Model (exact)" step 4 (multi-sweep depth
 * stepping, exercised end-to-end via generatePassGCode). All-cut small map,
 * flat terrain so targetSurface is 0 everywhere, stockTopMm=10, a flat tool,
 * effectiveStepdown=3. Since remaining starts at 10 and each sweep removes at
 * most 3mm down to target 0, the pass must take ceil(10/3) = 4 sweeps, and
 * afterward every cut pixel's remaining must be within tol of 0 (target
 * reached everywhere).
 *
 * Uses a point-radius tool (radiusMm effectively 0, i.e. `stampToolFootprint`
 * only lowers the single cut pixel itself). This keeps the sweep count an
 * exact, easy-to-predict ceil(stockTop/stepdown); the nonzero-radius
 * no-cascade behavior is covered by roughingStepdownDoesNotCascadeWithinSweep.
 */
window.__tests.remainingMultiSweep = function () {
  const width = 5, height = 5;
  const cut = new Uint8Array(width * height).fill(1);
  const heightMap = { width, height, cut };
  const stockTopMm = 10;

  const remaining = initRemaining(heightMap, stockTopMm);
  const targetSurface = new Float32Array(width * height).fill(0);

  const tool = {
    id: "t1", name: "flat_test", shape: "flat", diameterMm: 0.01, radiusMm: 0.005,
    stepoverMm: 1, maxStepdownMm: 3, feedMmMin: 1000, plungeMmMin: 300, spindleRpm: 10000,
  };
  const pass = {
    id: "p1", name: "RoughAll", toolId: "t1", direction: "xConventional",
    stepoverMm: null, maxStepdownMm: null, allowanceMm: 0, enabled: true,
  };
  const jobSpec = {
    imageName: "test.png", widthPx: width, heightPx: height, pixelSizeMm: 1,
    zeroMode: "bed", originMode: "lowerLeft", stockTopMm, safeZMm: stockTopMm + 5,
    passes: [pass],
  };

  const result = generatePassGCode({ pass, tool, targetSurface, remaining, jobSpec, heightMap, passIndex: 1 });

  const expectedSweeps = Math.ceil(stockTopMm / tool.maxStepdownMm); // ceil(10/3) = 4
  let maxRemaining = -Infinity;
  for (let i = 0; i < remaining.length; i++) {
    if (cut[i] !== 1) continue;
    if (remaining[i] > maxRemaining) maxRemaining = remaining[i];
  }

  const checks = [
    ["sweeps === ceil(stockTopMm/effectiveStepdown) = 4", result.sweeps === expectedSweeps, result.sweeps],
    ["max(remaining) over cut pixels <= 1e-4 (target reached)", maxRemaining <= 1e-4, maxRemaining],
  ];

  const pass_ = checks.every(([, ok]) => ok);
  return { pass: pass_, detail: { checks, sweeps: result.sweeps, maxRemaining } };
};

window.__tests.roughingStepdownDoesNotCascadeWithinSweep = function () {
  const width = 5, height = 5;
  const cut = new Uint8Array(width * height).fill(1);
  const heightMap = { width, height, cut };
  const stockTopMm = 0;
  const targetDepthMm = -5;
  const maxStepdownMm = 1;
  const targetSurface = new Float32Array(width * height).fill(targetDepthMm);
  const remaining = initRemaining(heightMap, stockTopMm);

  const tool = {
    id: "t1", name: "wide_flat_rough", shape: "flat", diameterMm: 4, radiusMm: 2,
    stepoverMm: 1, maxStepdownMm, feedMmMin: 1000, plungeMmMin: 300, spindleRpm: 10000,
  };
  const pass = {
    id: "p1", name: "RoughWide", toolId: "t1", direction: "xConventional",
    stepoverMm: null, maxStepdownMm: null, allowanceMm: 0, enabled: true,
  };
  const jobSpec = {
    imageName: "wide-stepdown.png", widthPx: width, heightPx: height, pixelSizeMm: 1,
    zeroMode: "stockTop", originMode: "lowerLeft", stockTopMm, safeZMm: 5,
    passes: [pass],
  };

  const result = generatePassGCode({ pass, tool, targetSurface, remaining, jobSpec, heightMap, passIndex: 1 });
  const lines = result.gcode.split("\n").filter((l) => l.trim() !== "");
  const plungeZs = lines
    .filter((l) => /^G1 Z-?\d+\.\d+\b/.test(l))
    .map((l) => parseFloat(l.match(/\bZ(-?\d+\.\d+)\b/)[1]));
  const firstSweepPlungeZs = plungeZs.slice(0, height);
  const firstSweepMinZ = firstSweepPlungeZs.reduce((min, z) => Math.min(min, z), Infinity);
  const expectedSweeps = Math.ceil(Math.abs(targetDepthMm - stockTopMm) / maxStepdownMm);

  const checks = [
    [
      "wide roughing tool takes one max-stepdown per sweep, not per row",
      result.sweeps === expectedSweeps,
      { sweeps: result.sweeps, expectedSweeps },
    ],
    [
      "first sweep never commands below stockTop - maxStepdown",
      firstSweepMinZ >= stockTopMm - maxStepdownMm - 1e-6,
      { firstSweepPlungeZs, firstSweepMinZ },
    ],
  ];

  const pass_ = checks.every(([, ok]) => ok);
  return { pass: pass_, detail: { checks, firstSweepPlungeZs, sweeps: result.sweeps } };
};

/**
 * Acceptance test for Phase 7 (Design.md phase 7 "Accept": "a rough(flat)->
 * finish(ball) sequence shows the rough pass leaving allowance stock and the
 * finish pass reaching terrain"). Uses a simple 1-D ramp terrain broadcast
 * across every row (so safeSurface/targetSurface are non-trivial but still
 * easy to reason about), one shared `remaining` array, a flat rough pass with
 * allowanceMm=0.8 followed by a ball finish pass with allowanceMm=0 through
 * the SAME remaining.
 *
 * Asserted expectations (see checks[] below for the exact tolerances used):
 *   (a) After the rough pass: remaining[i] >= targetFinish[i] - tol
 *       everywhere cut (rough never cuts below what finish will need), AND
 *       at least one pixel has remaining - targetFinish >= ~0.7 (most of the
 *       0.8mm allowance is still standing as stock — not fully eroded by the
 *       flat tool's footprint stamping).
 *   (b) After the finish (ball) pass: remaining is within a small tolerance
 *       of the ball pass's own target surface everywhere it was cut (finish
 *       fully reaches its target).
 */
window.__tests.roughThenFinish = function () {
  const width = 12, height = 5;
  const cut = new Uint8Array(width * height).fill(1);
  const heightMap = { width, height, cut };

  // 1-D ramp terrain (machine Z), broadcast identically across every row:
  // terrain[x] = -1 - 0.3*x, i.e. 0 at x=0 sloping down to -3.3 at x=11.
  const terrain = new Float32Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      terrain[y * width + x] = -1 - 0.3 * x;
    }
  }

  const stockTopMm = 0;
  const pixelSizeMm = 1;

  const flatTool = {
    id: "t1", name: "flat_rough", shape: "flat", diameterMm: 4, radiusMm: 2,
    stepoverMm: 1, maxStepdownMm: 1, feedMmMin: 1000, plungeMmMin: 300, spindleRpm: 10000,
  };
  const ballTool = {
    id: "t2", name: "ball_finish", shape: "ball", diameterMm: 2, radiusMm: 1,
    stepoverMm: 0.5, maxStepdownMm: 1, feedMmMin: 800, plungeMmMin: 300, spindleRpm: 15000,
  };

  const roughPass = {
    id: "p1", name: "Rough", toolId: "t1", direction: "xClimb",
    stepoverMm: null, maxStepdownMm: null, allowanceMm: 0.8, enabled: true,
  };
  const finishPass = {
    id: "p2", name: "Finish", toolId: "t2", direction: "xBoth",
    stepoverMm: null, maxStepdownMm: null, allowanceMm: 0, enabled: true,
  };

  const jobSpec = {
    imageName: "ramp.png", widthPx: width, heightPx: height, pixelSizeMm,
    zeroMode: "stockTop", originMode: "lowerLeft", stockTopMm, safeZMm: stockTopMm + 5,
    passes: [roughPass, finishPass],
  };

  // ONE shared remaining array across both passes (the point of Phase 7).
  const remaining = initRemaining(heightMap, stockTopMm);

  // Safe surfaces computed with the reference (ground-truth) algorithm —
  // this test isn't exercising safe-surface itself (Phase 5 already does),
  // just remaining-material chaining, so using the O(N*r^2) reference here
  // keeps this test simple and independent of the worker/decomposition path.
  const safeFlat = computeSafeSurfaceReference(terrain, width, height, pixelSizeMm, flatTool.radiusMm, "flat");
  const targetRough = computePassTargetSurface(safeFlat, roughPass.allowanceMm, stockTopMm);

  const roughResult = generatePassGCode({
    pass: roughPass, tool: flatTool, targetSurface: targetRough, remaining,
    jobSpec, heightMap, passIndex: 1,
  });

  const safeBall = computeSafeSurfaceReference(terrain, width, height, pixelSizeMm, ballTool.radiusMm, "ball");
  const targetFinish = computePassTargetSurface(safeBall, finishPass.allowanceMm, stockTopMm);

  // (a) Snapshot remaining vs targetFinish right after the rough pass, BEFORE
  // the finish pass mutates it further.
  const tolA = 1e-3;
  let roughLeavesStockOk = true;
  let maxAllowanceLeft = -Infinity;
  const roughViolations = [];
  for (let i = 0; i < remaining.length; i++) {
    if (cut[i] !== 1) continue;
    const diff = remaining[i] - targetFinish[i];
    if (diff < -tolA) {
      roughLeavesStockOk = false;
      roughViolations.push({ i, remaining: remaining[i], targetFinish: targetFinish[i], diff });
    }
    if (diff > maxAllowanceLeft) maxAllowanceLeft = diff;
  }
  const allowanceStockPresent = maxAllowanceLeft >= 0.7; // most of the 0.8mm allowance still standing somewhere

  const finishResult = generatePassGCode({
    pass: finishPass, tool: ballTool, targetSurface: targetFinish, remaining,
    jobSpec, heightMap, passIndex: 2,
  });

  // (b) After the finish pass, remaining must be within tol of targetFinish
  // everywhere it was cut.
  const tolB = 1e-3;
  let finishReachesTargetOk = true;
  let maxFinishDiff = 0;
  for (let i = 0; i < remaining.length; i++) {
    if (cut[i] !== 1) continue;
    const diff = Math.abs(remaining[i] - targetFinish[i]);
    if (diff > maxFinishDiff) maxFinishDiff = diff;
    if (diff > tolB) finishReachesTargetOk = false;
  }

  const checks = [
    [
      "(a) after rough pass, remaining >= targetFinish - 1e-3 everywhere cut (rough never undercuts finish target)",
      roughLeavesStockOk,
      roughViolations.slice(0, 5),
    ],
    [
      "(a) after rough pass, at least one pixel retains >= ~0.7mm of the 0.8mm allowance as stock",
      allowanceStockPresent,
      maxAllowanceLeft,
    ],
    [
      "(b) after finish pass, remaining within 1e-3 of targetFinish everywhere cut",
      finishReachesTargetOk,
      maxFinishDiff,
    ],
  ];

  const pass_ = checks.every(([, ok]) => ok);
  return {
    pass: pass_,
    detail: {
      checks,
      roughSweeps: roughResult.sweeps,
      finishSweeps: finishResult.sweeps,
      maxAllowanceLeftAfterRough: maxAllowanceLeft,
      maxFinishDiff,
    },
  };
};

/**
 * Regression test for the multi-sweep NON-TERMINATION bug (fixed via fixpoint
 * detection). With stepover > 1px, only pixels ON cutting rows (every
 * `rowStep`) are cut centers driven down to target; between-track pixels are
 * only lowered by neighboring cut centers' footprint spillover and PLATEAU at
 * `min(nearby cut-center zc)`, which can permanently stay above their own
 * target[i]. The OLD termination condition ("any cut pixel > target") would
 * therefore stay true forever and loop to MAX_SWEEPS_PER_PASS. The FIX
 * terminates when a full sweep removes no material.
 *
 * This fixture reproduces those conditions: a non-flat dome-ish terrain on a
 * 40x30 map, a tool whose stepover gives rowStep >= 3 and whose radius spans
 * several px. Asserts the pass converges well below the safety cap and within
 * a sane small sweep count. WOULD have hit sweeps===200 before the fix.
 */
window.__tests.multiSweepConvergesWithStepover = function () {
  const width = 40, height = 30;
  const cut = new Uint8Array(width * height).fill(1);
  const heightMap = { width, height, cut };

  // A radial "dome" terrain (machine Z): deepest (-19) at the edges, shallow
  // (~0) at the center — a smooth non-flat surface so between-track pixels have
  // genuinely different targets from the cut rows. stockTopMm = 0.
  const cx = (width - 1) / 2;
  const cy = (height - 1) / 2;
  const maxR = Math.hypot(cx, cy);
  const depth = 19; // ~19mm total depth range, matching the repro
  const terrain = new Float32Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const r = Math.hypot(x - cx, y - cy) / maxR; // 0 center .. 1 corner
      terrain[y * width + x] = -depth * r; // 0 at center, -19 at corners
    }
  }

  const stockTopMm = 0;
  const pixelSizeMm = 0.25; // same scale as the repro (default settings)

  // Flat rough tool: radius 3.175mm = 12.7px (spans several px), stepover 3mm
  // -> rowStep = round(3 / 0.25) = 12 px (> 1, the crux of the bug), stepdown
  // 3mm. This is exactly the repro's tool/pass geometry.
  const tool = {
    id: "t1", name: "flat_6_35mm", shape: "flat", diameterMm: 6.35, radiusMm: 3.175,
    stepoverMm: 3, maxStepdownMm: 3, feedMmMin: 1800, plungeMmMin: 700, spindleRpm: 15000,
  };
  const pass = {
    id: "p1", name: "Rough", toolId: "t1", direction: "xClimb",
    stepoverMm: null, maxStepdownMm: null, allowanceMm: 0.8, enabled: true,
  };
  const jobSpec = {
    imageName: "dome.png", widthPx: width, heightPx: height, pixelSizeMm,
    zeroMode: "stockTop", originMode: "center", stockTopMm, safeZMm: stockTopMm + 5,
    passes: [pass],
  };

  const rowStep = Math.max(1, Math.round(tool.stepoverMm / pixelSizeMm)); // 12

  const remaining = initRemaining(heightMap, stockTopMm);
  const safe = computeSafeSurfaceReference(terrain, width, height, pixelSizeMm, tool.radiusMm, "flat");
  const targetSurface = computePassTargetSurface(safe, pass.allowanceMm, stockTopMm);

  const result = generatePassGCode({ pass, tool, targetSurface, remaining, jobSpec, heightMap, passIndex: 1 });

  // Sane upper bound: depth range / stepdown, plus slack for the plateau /
  // footprint-interaction sweeps. ceil(19/3) = 7, so <= 10 is a comfortable
  // "sane small range" ceiling that still catches a runaway (200) regression.
  const naiveSweeps = Math.ceil(depth / tool.maxStepdownMm); // 7
  const saneUpperBound = naiveSweeps + 3; // 10

  // Also confirm no gouging: rough must never cut below the physical floor
  // `min(terrain[i] + allowanceMm, stockTopMm)`. NOTES:
  //  - The floor is `terrain[i] + allowance`, NOT this pixel's own
  //    `targetSurface[i]` (= safe[i] + allowance). A flat tool centered on a
  //    neighbor cut center legitimately stamps its footprint (flat bottom =
  //    the center's zc) across this pixel; because the safe surface
  //    guarantees safe[center] = max(terrain) over the footprint, that zc is
  //    >= terrain[i] + allowance but CAN be below safe[i] + allowance when
  //    this pixel's own safe value is higher. So comparing against
  //    targetSurface[i] would spuriously flag legitimate footprint spillover.
  //  - The floor is also clamped to `stockTopMm`: where terrain + allowance
  //    would sit above the stock top (shallow peaks, like the dome center),
  //    the target is clamped to stockTop and the pixel is left uncut AT
  //    stock top — remaining == stockTop there is correct, not a gouge.
  let noGougeOk = true;
  let maxGouge = 0;
  for (let i = 0; i < remaining.length; i++) {
    if (cut[i] !== 1) continue;
    const floor = Math.min(terrain[i] + pass.allowanceMm, stockTopMm); // physical lower bound
    const below = floor - remaining[i]; // >0 means cut below the floor (gouge)
    if (below > maxGouge) maxGouge = below;
    if (below > 1e-3) noGougeOk = false;
  }

  const checks = [
    ["converged (sweeps < MAX_SWEEPS_PER_PASS=200)", result.sweeps < MAX_SWEEPS_PER_PASS, result.sweeps],
    [`sweeps in sane range (<= ceil(depth/stepdown)+3 = ${saneUpperBound})`, result.sweeps <= saneUpperBound, result.sweeps],
    ["rowStep is >1 (the bug's precondition)", rowStep > 1, rowStep],
    ["no gouging: remaining >= terrain + allowance - 1e-3 everywhere cut", noGougeOk, maxGouge],
  ];

  const pass_ = checks.every(([, ok]) => ok);
  return {
    pass: pass_,
    detail: { checks, sweeps: result.sweeps, rowStep, naiveSweeps, saneUpperBound, maxGouge },
  };
};

/**
 * Regression test for the BALL-pass non-termination bug (fixed via STAMP_EPS_MM).
 * The ball footprint's sqrt-based offset (`r - sqrt(r²-d²)`) produces perpetual
 * sub-nanometer (~2e-7 mm) decreases in `remaining` that never reach an exact
 * floating-point fixpoint, so a strict `changed = candidate < remaining` check
 * loops to MAX_SWEEPS_PER_PASS even though every cut pixel is a center
 * (rowStep=1). The flat tool (offset 0) was immune, so multiSweepConvergesWithStepover
 * did NOT catch it. This uses a ball tool over a deep ramp and asserts a bounded,
 * sane sweep count. WOULD have hit sweeps===200 before the STAMP_EPS_MM fix.
 */
window.__tests.ballFinishConverges = function () {
  const width = 30, height = 24;
  const cut = new Uint8Array(width * height).fill(1);
  const heightMap = { width, height, cut };
  const pixelSizeMm = 0.25;
  const stockTopMm = 0;
  const depth = 20; // 20mm deep ramp -> ~10 sweeps at 2mm stepdown

  // A skewed ramp (varies in both axes) so neighboring ball targets differ,
  // exercising the offset-driven cross-pixel stamping that caused the tail.
  const terrain = new Float32Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const t = (x / (width - 1)) * 0.8 + (y / (height - 1)) * 0.2;
      terrain[y * width + x] = -depth * t; // 0 .. -20
    }
  }

  const tool = {
    id: "b1", name: "ball_1mm", shape: "ball", diameterMm: 1, radiusMm: 0.5,
    stepoverMm: 0.2, maxStepdownMm: 2, feedMmMin: 1500, plungeMmMin: 700, spindleRpm: 20000,
  };
  const pass = {
    id: "p1", name: "Finish", toolId: "b1", direction: "xBoth",
    stepoverMm: null, maxStepdownMm: null, allowanceMm: 0, enabled: true,
  };
  const jobSpec = {
    imageName: "ramp.png", widthPx: width, heightPx: height, pixelSizeMm,
    zeroMode: "stockTop", originMode: "center", stockTopMm, safeZMm: stockTopMm + 5,
    passes: [pass],
  };

  const rowStep = Math.max(1, Math.round(tool.stepoverMm / pixelSizeMm)); // 1
  const remaining = initRemaining(heightMap, stockTopMm);
  const safe = computeSafeSurfaceReference(terrain, width, height, pixelSizeMm, tool.radiusMm, "ball");
  const targetSurface = computePassTargetSurface(safe, pass.allowanceMm, stockTopMm);
  const result = generatePassGCode({ pass, tool, targetSurface, remaining, jobSpec, heightMap, passIndex: 1 });

  const naiveSweeps = Math.ceil(depth / tool.maxStepdownMm); // 10
  const saneUpperBound = naiveSweeps + 3; // 13

  const checks = [
    ["converged (sweeps < MAX_SWEEPS_PER_PASS=200)", result.sweeps < MAX_SWEEPS_PER_PASS, result.sweeps],
    [`sweeps in sane range (<= ceil(depth/stepdown)+3 = ${saneUpperBound})`, result.sweeps <= saneUpperBound, result.sweeps],
    ["ball tool (offset>0) — the bug's precondition", tool.shape === "ball", tool.shape],
  ];
  const pass_ = checks.every(([, ok]) => ok);
  return { pass: pass_, detail: { checks, sweeps: result.sweeps, naiveSweeps, saneUpperBound } };
};

// ----------------------------------------------------------------------------
// OUTLINE TOOLPATH TESTS (Phase: outline groove, stage 1). Brute-force the
// no-gouge guarantee: for every returned loop point, min Euclidean distance
// (px) to any cut===1 pixel must be >= tool radius (minus a small discretization
// slack). Fixtures built in-code.
// ----------------------------------------------------------------------------

/** Filled disc mask: cut===1 where distance from center <= rPx. */
function makeDiscFixture(size, rPx) {
  const width = size, height = size;
  const cx = (size - 1) / 2, cy = (size - 1) / 2;
  const cut = new Uint8Array(width * height);
  const r2 = rPx * rPx;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const dx = x - cx, dy = y - cy;
      if (dx * dx + dy * dy <= r2) cut[y * width + x] = 1;
    }
  }
  return { cut, width, height, cx, cy };
}

/** Brute-force min Euclidean distance (px) from (px,py) to any cut===1 pixel. */
function minDistToCut(px, py, cut, width, height) {
  let best = Infinity;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (cut[y * width + x] !== 1) continue;
      const dx = x - px, dy = y - py;
      const d2 = dx * dx + dy * dy;
      if (d2 < best) best = d2;
    }
  }
  return Math.sqrt(best);
}

/**
 * Outline test: no-gouge on a filled disc. Every loop point must stay at least
 * (radiusPx - slack) from the part; innermost-loop points >= radiusPx.
 */
window.__tests.outlineNoGouge = function () {
  const { cut, width, height } = makeDiscFixture(60, 18);
  const pixelSizeMm = 0.25, toolRadiusMm = 0.5, grooveWidthMm = 1, stepoverMm = 0.2;
  const radiusPx = toolRadiusMm / pixelSizeMm; // 2

  const res = computeOutlineLoops(cut, width, height, pixelSizeMm, toolRadiusMm, grooveWidthMm, stepoverMm);
  const checks = [];
  checks.push(["at least one loop", res.loopCount >= 1]);

  let globalMin = Infinity;
  for (const loop of res.loops) {
    for (const pt of loop) {
      const d = minDistToCut(pt.px, pt.py, cut, width, height);
      if (d < globalMin) globalMin = d;
    }
  }
  checks.push(["no point closer than radius - 0.75", globalMin >= radiusPx - 0.75]);

  // Innermost loop (first, smallest level) must be >= radiusPx cleanly.
  let innerMin = Infinity;
  const inner = res.loops[0] || [];
  for (const pt of inner) {
    const d = minDistToCut(pt.px, pt.py, cut, width, height);
    if (d < innerMin) innerMin = d;
  }
  checks.push(["innermost loop >= radiusPx", innerMin >= radiusPx]);

  const pass = checks.every(([, ok]) => ok);
  return {
    pass,
    detail: {
      checks,
      loopCount: res.loopCount,
      levelsPx: res.levelsPx,
      minDistToCut: globalMin,
      innerMinDist: innerMin,
      radiusPx,
    },
  };
};

/**
 * Outline test: fully-cut fixture (no transparency). Loops must trace the
 * rounded rectangle offset OUTWARD; no point inside the cut block.
 */
window.__tests.outlineRectangleFallback = function () {
  const width = 40, height = 30;
  const cut = new Uint8Array(width * height).fill(1);
  const pixelSizeMm = 0.25, toolRadiusMm = 0.5, grooveWidthMm = 1, stepoverMm = 0.2;
  const radiusPx = toolRadiusMm / pixelSizeMm;

  const res = computeOutlineLoops(cut, width, height, pixelSizeMm, toolRadiusMm, grooveWidthMm, stepoverMm);
  const checks = [];
  checks.push(["loops returned", res.loopCount >= 1]);

  let globalMin = Infinity;
  for (const loop of res.loops) {
    for (const pt of loop) {
      const d = minDistToCut(pt.px, pt.py, cut, width, height);
      if (d < globalMin) globalMin = d;
    }
  }
  checks.push(["every point outside block by >= radius - 0.75", globalMin >= radiusPx - 0.75]);

  const pass = checks.every(([, ok]) => ok);
  return { pass, detail: { checks, loopCount: res.loopCount, levelsPx: res.levelsPx, minDistToCut: globalMin, radiusPx } };
};

/**
 * Outline test: a wide groove (5x tool diameter) with stepover < diameter must
 * produce multiple concentric loops, and their levels increase by ~stepoverPx.
 */
window.__tests.outlineConcentricForWidth = function () {
  const { cut, width, height } = makeDiscFixture(60, 18);
  const pixelSizeMm = 0.25, toolRadiusMm = 0.5;
  const toolDiameterMm = 2 * toolRadiusMm;
  const grooveWidthMm = 5 * toolDiameterMm; // 5x diameter
  const stepoverMm = 0.75 * toolDiameterMm; // < diameter
  const stepoverPx = stepoverMm / pixelSizeMm;

  const res = computeOutlineLoops(cut, width, height, pixelSizeMm, toolRadiusMm, grooveWidthMm, stepoverMm);
  const checks = [];
  checks.push(["loopCount >= 2", res.loopCount >= 2]);

  // Levels increase by ~stepoverPx.
  let levelsOk = res.levelsPx.length >= 2;
  for (let i = 1; i < res.levelsPx.length; i++) {
    const delta = res.levelsPx[i] - res.levelsPx[i - 1];
    if (Math.abs(delta - stepoverPx) > 1e-6) levelsOk = false;
  }
  checks.push(["levels increase by ~stepoverPx", levelsOk]);

  const pass = checks.every(([, ok]) => ok);
  return { pass, detail: { checks, loopCount: res.loopCount, levelsPx: res.levelsPx, stepoverPx } };
};

/** Outline test: every returned loop is closed and has >= 4 points. */
window.__tests.outlineLoopsClosed = function () {
  const { cut, width, height } = makeDiscFixture(60, 18);
  const res = computeOutlineLoops(cut, width, height, 0.25, 0.5, 1, 0.2);
  const checks = [];
  checks.push(["loops returned", res.loopCount >= 1]);

  let allClosed = true, allLongEnough = true;
  for (const loop of res.loops) {
    if (loop.length < 4) allLongEnough = false;
    const a = loop[0], b = loop[loop.length - 1];
    if (Math.abs(a.px - b.px) > 1e-3 || Math.abs(a.py - b.py) > 1e-3) allClosed = false;
  }
  checks.push(["every loop closed (<=1e-3 px)", allClosed]);
  checks.push(["every loop >= 4 points", allLongEnough]);

  const pass = checks.every(([, ok]) => ok);
  return { pass, detail: { checks, loopCount: res.loopCount } };
};

/**
 * Stage 2 test: generateOutlinePassGCode end-to-end on a small disc-in-margin
 * fixture. Asserts the GCode preamble, plunges reaching the floor Z, G1 loop
 * moves, a clean M5/M2 ending, no standalone M0, and — the safety check —
 * that every cutting-move XY maps back to a point at least (toolRadius -
 * small slack) away from any cut pixel (never gouges the part).
 */
window.__tests.outlinePassGCode = function () {
  const { cut, width, height } = makeDiscFixture(40, 10);
  const pixelSizeMm = 0.25;

  const tool = {
    id: "t1", name: "outline_tool", shape: "flat",
    diameterMm: 1, radiusMm: 0.5,
    stepoverMm: 0.2, maxStepdownMm: 1,
    feedMmMin: 900, plungeMmMin: 300, spindleRpm: 12000,
  };
  const pass = {
    id: "p1", name: "OutlineGroove", toolId: tool.id, direction: "outline",
    stepoverMm: null, maxStepdownMm: null, allowanceMm: 0,
    outlineWidthMm: 1, outlineDepthMm: -2, enabled: true,
  };
  const jobSpec = {
    imageName: "outline_test.png",
    pixelSizeMm,
    zeroMode: "stockTop",
    originMode: "center",
    stockTopMm: 0,
    safeZMm: 5,
  };

  const lines = [];
  const sink = { push: (l) => lines.push(l) };
  const res = generateOutlinePassGCode({
    pass, tool, cut, width, height, jobSpec, passIndex: 1, imageBase: "outline_test",
    onChunk: (chunk) => {
      for (const l of chunk.split("\n")) if (l.length > 0) sink.push(l);
    },
  });

  const checks = [];
  checks.push(["filename set", typeof res.filename === "string" && res.filename.length > 0]);
  checks.push(["no gcode string when streaming", res.gcode === null]);
  checks.push(["sweeps === depth levels >= 1", res.sweeps >= 1]);
  checks.push(["zMax reaches stockTopMm", Math.abs(res.zMax - jobSpec.stockTopMm) < 1e-6 || res.zMax <= jobSpec.stockTopMm]);
  checks.push(["zMin reaches floorZ", Math.abs(res.zMin - pass.outlineDepthMm) < 1e-6]);

  const hasPreamble = lines.some((l) => l === "G90") &&
    lines.some((l) => l === "G21") &&
    lines.some((l) => l === "G17") &&
    lines.some((l) => /^M3 S\d+$/.test(l));
  checks.push(["preamble present", hasPreamble]);

  const plungeLines = lines.filter((l) => /^G1 Z/.test(l));
  const reachesFloor = plungeLines.some((l) => {
    const m = /Z(-?\d+\.\d+)/.exec(l);
    return m && Math.abs(parseFloat(m[1]) - pass.outlineDepthMm) < 1e-3;
  });
  checks.push(["a plunge reaches the floor Z", reachesFloor]);

  const loopMoves = lines.filter((l) => /^G1 X-?\d/.test(l) || (/^G1/.test(l) && /X/.test(l) && /Y/.test(l)));
  checks.push(["G1 loop moves present", loopMoves.length > 0]);

  checks.push(["ends M5 then M2", lines.length >= 2 && lines[lines.length - 2] === "M5" && lines[lines.length - 1] === "M2"]);
  checks.push(["no standalone M0", !lines.some((l) => l.trim() === "M0")]);

  // Safety check: reconstruct every commanded XY from the emitted G0/G1 lines
  // (tracking modal X/Y) and, for cutting (G1) moves with an XY component,
  // convert back to pixel space and verify it's never inside/too-close to the
  // part (never gouges). Small slack matches the geometry engine's own bias.
  const radiusPx = tool.radiusMm / pixelSizeMm;
  let modalX = null, modalY = null;
  let worstIntrusion = -Infinity; // how far INSIDE radiusPx the closest point got (positive = violation)
  let checkedAny = false;
  for (const line of lines) {
    const isMotion = /^G[01]\b/.test(line);
    if (!isMotion) continue;
    const isCut = /^G1\b/.test(line);
    const mx = /X(-?\d+\.\d+)/.exec(line);
    const my = /Y(-?\d+\.\d+)/.exec(line);
    if (mx) modalX = parseFloat(mx[1]);
    if (my) modalY = parseFloat(my[1]);
    if (isCut && (mx || my) && modalX !== null && modalY !== null) {
      // Invert pixelCenterToMachineXY (center-mode) to get back to px/py.
      const px = modalX / pixelSizeMm + width / 2 - 0.5;
      const py = height / 2 - modalY / pixelSizeMm - 0.5;
      const d = minDistToCut(px, py, cut, width, height);
      const intrusion = radiusPx - d; // positive means the tool center is closer than its own radius -> gouge
      if (intrusion > worstIntrusion) worstIntrusion = intrusion;
      checkedAny = true;
    }
  }
  checks.push(["checked at least one cutting XY move", checkedAny]);
  checks.push(["no cutting move gouges the part (intrusion <= 0.75px slack)", worstIntrusion <= 0.75]);

  const pass_ = checks.every(([, ok]) => ok);
  return {
    pass: pass_,
    detail: { checks, sweeps: res.sweeps, zMin: res.zMin, zMax: res.zMax, lineCount: lines.length, worstIntrusion },
  };
};

window.__tests.outlinePassStampsRemaining = function () {
  const { cut, width, height } = makeDiscFixture(40, 10);
  const pixelSizeMm = 0.25;
  const stockTopMm = 0;
  const checks = [];

  const tool = {
    id: "t1", name: "outline_tool", shape: "flat",
    diameterMm: 1, radiusMm: 0.5,
    stepoverMm: 0.2, maxStepdownMm: 1,
    feedMmMin: 900, plungeMmMin: 300, spindleRpm: 12000,
  };
  const pass = {
    id: "p1", name: "OutlineGroove", toolId: tool.id, direction: "outline",
    stepoverMm: null, maxStepdownMm: null, allowanceMm: 0,
    outlineWidthMm: 1, outlineDepthMm: -2, enabled: true,
  };
  const jobSpec = {
    imageName: "outline_remaining_test.png",
    pixelSizeMm,
    zeroMode: "stockTop",
    originMode: "center",
    stockTopMm,
    safeZMm: 5,
  };
  const heightMap = { width, height, gray: new Float32Array(width * height), cut, bits: 8 };
  const remaining = initRemaining(heightMap, stockTopMm);

  generateOutlinePassGCode({
    pass, tool, cut, width, height, jobSpec, passIndex: 1,
    imageBase: "outline_remaining_test", remaining,
  });

  let loweredOutside = 0;
  let deepestOutside = Infinity;
  for (let i = 0; i < remaining.length; i++) {
    if (cut[i] !== 0) continue;
    if (Number.isFinite(remaining[i]) && remaining[i] < stockTopMm) {
      loweredOutside++;
      if (remaining[i] < deepestOutside) deepestOutside = remaining[i];
    }
  }

  checks.push(["outline lowered at least one non-raster pixel in remaining", loweredOutside > 0, loweredOutside]);
  checks.push(["outline remaining reaches requested floor depth somewhere", deepestOutside <= pass.outlineDepthMm + 1e-6, deepestOutside]);

  const pass_ = checks.every(([, ok]) => ok);
  return { pass: pass_, detail: { checks, loweredOutside, deepestOutside } };
};

/**
 * Outline per-pass override test: confirms generateOutlinePassGCode honors
 * pass.maxStepdownMm and pass.stepoverMm instead of always falling back to
 * the tool's defaults.
 *  - Depth: floor is -3mm from stockTop 0. Tool default maxStepdownMm=1 would
 *    give 3 levels; a pass override of 1.5 should give exactly 2 levels.
 *  - Loop spacing: tool default stepoverMm=0.2 vs a pass override of 0.5
 *    should change loopCount (looser spacing -> fewer loops for the same
 *    outline width).
 */
window.__tests.outlinePassPerPassOverrides = function () {
  const { cut, width, height } = makeDiscFixture(40, 10);
  const pixelSizeMm = 0.25;
  const checks = [];

  const tool = {
    id: "t1", name: "outline_tool", shape: "flat",
    diameterMm: 1, radiusMm: 0.5,
    stepoverMm: 0.2, maxStepdownMm: 1,
    feedMmMin: 900, plungeMmMin: 300, spindleRpm: 12000,
  };
  const jobSpec = {
    imageName: "outline_override_test.png",
    pixelSizeMm,
    zeroMode: "stockTop",
    originMode: "center",
    stockTopMm: 0,
    safeZMm: 5,
  };

  // --- Stepdown override: floor -3mm, pass override 1.5mm -> 2 levels. ----
  const passDefaultStepdown = {
    id: "p1", name: "OutlineDefaultStepdown", toolId: tool.id, direction: "outline",
    stepoverMm: null, maxStepdownMm: null, allowanceMm: 0,
    outlineWidthMm: 1, outlineDepthMm: -3, enabled: true,
  };
  const passOverrideStepdown = {
    id: "p2", name: "OutlineOverrideStepdown", toolId: tool.id, direction: "outline",
    stepoverMm: null, maxStepdownMm: 1.5, allowanceMm: 0,
    outlineWidthMm: 1, outlineDepthMm: -3, enabled: true,
  };

  const resDefaultStepdown = generateOutlinePassGCode({
    pass: passDefaultStepdown, tool, cut, width, height, jobSpec, passIndex: 1,
    imageBase: "outline_override_test",
    onChunk: () => {},
  });
  const resOverrideStepdown = generateOutlinePassGCode({
    pass: passOverrideStepdown, tool, cut, width, height, jobSpec, passIndex: 2,
    imageBase: "outline_override_test",
    onChunk: () => {},
  });

  checks.push(["tool-default stepdown (1mm) over 3mm floor -> 3 levels", resDefaultStepdown.sweeps === 3]);
  checks.push(["pass-override stepdown (1.5mm) over 3mm floor -> 2 levels", resOverrideStepdown.sweeps === 2]);
  checks.push(["pass stepdown override changes level count vs tool default",
    resOverrideStepdown.sweeps !== resDefaultStepdown.sweeps]);

  // --- Stepover override: looser spacing -> fewer/equal loops. ------------
  const passDefaultStepover = {
    id: "p3", name: "OutlineDefaultStepover", toolId: tool.id, direction: "outline",
    stepoverMm: null, maxStepdownMm: null, allowanceMm: 0,
    outlineWidthMm: 3, outlineDepthMm: -1, enabled: true,
  };
  const passOverrideStepover = {
    id: "p4", name: "OutlineOverrideStepover", toolId: tool.id, direction: "outline",
    stepoverMm: 0.9, maxStepdownMm: null, allowanceMm: 0,
    outlineWidthMm: 3, outlineDepthMm: -1, enabled: true,
  };

  const loopsDefault = computeOutlineLoops(
    cut, width, height, pixelSizeMm, tool.radiusMm, passDefaultStepover.outlineWidthMm,
    (passDefaultStepover.stepoverMm != null ? passDefaultStepover.stepoverMm : tool.stepoverMm)
  );
  const loopsOverride = computeOutlineLoops(
    cut, width, height, pixelSizeMm, tool.radiusMm, passOverrideStepover.outlineWidthMm,
    (passOverrideStepover.stepoverMm != null ? passOverrideStepover.stepoverMm : tool.stepoverMm)
  );

  checks.push(["pass stepover override changes loopCount vs tool default",
    loopsOverride.loopCount !== loopsDefault.loopCount]);
  checks.push(["looser stepover override yields fewer-or-equal loops",
    loopsOverride.loopCount <= loopsDefault.loopCount]);

  const pass_ = checks.every(([, ok]) => ok);
  return {
    pass: pass_,
    detail: {
      checks,
      sweepsDefault: resDefaultStepdown.sweeps, sweepsOverride: resOverrideStepdown.sweeps,
      loopCountDefault: loopsDefault.loopCount, loopCountOverride: loopsOverride.loopCount,
    },
  };
};

/**
 * Test: `framing: 'body'` on generatePassGCode produces exactly the same
 * motion (G1 cut moves) as `framing: 'full'` (the default), but omits the
 * units/mode preamble (G90/G21/G17) and spindle control (M3/M5/M2), starts
 * with a one-line `; --- pass ...` section comment, and starts/ends motion
 * with `G0 Z<safeZ>` lines.
 */
window.__tests.singleFileBodyFraming = function () {
  const checks = [];

  const width = 6, height = 4;
  const cut = new Uint8Array(width * height).fill(1);
  const heightMap = { width, height, gray: new Float32Array(width * height), cut, bits: 8 };

  const targetSurface = new Float32Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      targetSurface[y * width + x] = -0.5 - 0.05 * x;
    }
  }

  const tool = {
    id: "t1", name: "BodyTestTool", shape: "flat", diameterMm: 3, radiusMm: 1.5,
    stepoverMm: 1, maxStepdownMm: 1, feedMmMin: 1234, plungeMmMin: 321, spindleRpm: 12000,
  };
  const pass = {
    id: "p1", name: "BodyTestPass", toolId: "t1", direction: "xConventional",
    stepoverMm: null, maxStepdownMm: null, allowanceMm: 0, enabled: true,
  };
  const jobSpec = {
    imageName: "bodytest.png", widthPx: width, heightPx: height, pixelSizeMm: 1,
    zeroMode: "stockTop", originMode: "lowerLeft", stockTopMm: 0, safeZMm: 5,
    passes: [pass],
  };

  const remainingFull = initRemaining(heightMap, jobSpec.stockTopMm);
  const resultFull = generatePassGCode({
    pass, tool, targetSurface, remaining: remainingFull, jobSpec, heightMap, passIndex: 1,
    imageBase: "bodytest", framing: "full",
  });

  const remainingBody = initRemaining(heightMap, jobSpec.stockTopMm);
  const resultBody = generatePassGCode({
    pass, tool, targetSurface, remaining: remainingBody, jobSpec, heightMap, passIndex: 1,
    imageBase: "bodytest", framing: "body",
  });

  checks.push(["both converge in a single sweep", resultFull.sweeps === 1 && resultBody.sweeps === 1,
    [resultFull.sweeps, resultBody.sweeps]]);

  const bodyGcode = resultBody.gcode;
  const bodyLines = bodyGcode.split("\n").filter((l) => l.trim() !== "");

  checks.push(["body has no G90", !/\bG90\b/.test(bodyGcode)]);
  checks.push(["body has no G21", !/\bG21\b/.test(bodyGcode)]);
  checks.push(["body has no G17", !/\bG17\b/.test(bodyGcode)]);
  checks.push(["body has no M3", !/\bM3\b/.test(bodyGcode)]);
  checks.push(["body has no M5", !/\bM5\b/.test(bodyGcode)]);
  checks.push(["body has no M2", !/\bM2\b/.test(bodyGcode)]);

  checks.push(["body starts with '; --- pass' section comment",
    bodyLines[0] != null && bodyLines[0].startsWith("; --- pass"), bodyLines[0]]);

  const expectedRetract = `G0 Z${formatCoord(jobSpec.safeZMm)}`;
  checks.push(["body ends with G0 Z<safeZ> retract",
    bodyLines[bodyLines.length - 1] === expectedRetract, bodyLines[bodyLines.length - 1]]);

  // Extract the motion-line subsequence (G0/G1 lines) from both outputs and
  // compare — body framing must produce the identical toolpath moves.
  function motionLines(text) {
    return text.split("\n").filter((l) => /^(G0|G1)\b/.test(l.trim())).map((l) => l.trim());
  }
  const fullMotion = motionLines(resultFull.gcode);
  const bodyMotion = motionLines(bodyGcode);
  checks.push(["body first motion line explicitly raises to safe Z",
    bodyMotion[0] === expectedRetract, bodyMotion[0]]);

  // Both start "at safe Z" with fresh modal state, so the raw G-code text of
  // each motion line is byte-identical between full and body framing (modal
  // words reset the same way at the start of a pass in both cases).
  checks.push(["motion-line sequences match exactly between full and body",
    fullMotion.length === bodyMotion.length && fullMotion.every((l, i) => l === bodyMotion[i]),
    { fullCount: fullMotion.length, bodyCount: bodyMotion.length }]);

  const pass_ = checks.every(([, ok]) => ok);
  return { pass: pass_, detail: { checks, bodyLineCount: bodyLines.length } };
};

window.runTests = function () {
  const results = {};
  for (const name in window.__tests) {
    try {
      results[name] = window.__tests[name]();
    } catch (e) {
      results[name] = { pass: false, error: String(e) };
    }
  }
  const allPass = Object.values(results).every((r) => r && r.pass);
  console.log("runTests:", allPass ? "ALL PASS" : "FAILURES", results);
  return { allPass, results };
};
