"use strict";
/* ============================================================================
 * Browser GCode Generator — app.js
 *
 * Classic script (no ES modules — file:// blocks module loading in Chrome).
 * This file currently implements PHASE 1 ONLY:
 *   - File picker wired to FileReader.readAsArrayBuffer
 *   - PNG signature validation
 *   - IHDR parsing (width/height/bitDepth/colorType)
 *   - 8-bit Canvas decode path (fallback path from the spec)
 *   - Decoded-image badge (bits + dimensions)
 *   - Grayscale preview with magenta mask overlay
 *
 * Later phases extend the module-level state below (JobSpec, tools, passes,
 * worker orchestration, GCode assembly) — see the "STATE" and "HOOKS" section
 * comments for where that plugs in. Nothing in this file outside of Phase 1's
 * scope is implemented yet.
 * ==========================================================================*/

// ============================================================================
// STATE — module-level, extended by later phases.
// ============================================================================

/** @type {HeightMap|null} Decoded image; produced once per file load (Phase 1/2). */
let currentHeightMap = null;
let isGenerating = false; // true while a generation job is in flight (guards re-entry)

/** Name of the currently loaded image file, without extension (used later for
 *  GCode output filenames — Phase 6). Kept here now since it's known at load time. */
let currentImageBaseName = null;

/**
 * JobSpec — global job settings (see Design.md "Data Model").
 * Phase 1 only needs width/height/imageName populated; the rest (scale,
 * depth, zero/origin, passes) are filled in by Phase 3/4 UI and left as
 * placeholders here so the shape exists for later phases to extend.
 * @type {object}
 */
let currentJobSpec = {
  imageName: null,
  widthPx: 0,
  heightPx: 0,
  pixelSizeMm: null, // Phase 3
  zAtBlackMm: null, // Phase 3
  zAtWhiteMm: null, // Phase 3
  zeroMode: null, // Phase 3 ("stockTop" | "bed")
  originMode: null, // Phase 3 ("center" | "lowerLeft")
  stockTopMm: null, // Phase 3
  safeZMm: null, // Phase 3
  passes: [], // Phase 4 (PassSpec[])
};

/** @type {Array<object>} ToolSpec[] — populated by Phase 4's tool table + default seed. */
let currentTools = [];

/** Incrementing counters for stable, deterministic id generation (Phase 4).
 *  Deliberately not Math.random()/Date.now() — simple and reproducible. */
let toolIdCounter = 0;
let passIdCounter = 0;

/** Gate for auto-save: stays false until startup finishes restoring/seeding,
 *  so the many update calls during init don't thrash localStorage or persist
 *  a half-built state. Set true at the end of module init. */
let settingsReady = false;

/** @returns {string} next stable tool id, e.g. "t1", "t2", ... */
function nextToolId() {
  toolIdCounter += 1;
  return "t" + toolIdCounter;
}

/** @returns {string} next stable pass id, e.g. "p1", "p2", ... */
function nextPassId() {
  passIdCounter += 1;
  return "p" + passIdCounter;
}

/** @type {Float32Array|null} Terrain (machine Z per pixel), recomputed by
 *  recomputeTerrain() whenever the image or scale/depth panels change
 *  (Phase 3). null until an image is loaded. */
let currentTerrain = null;

// ============================================================================
// DOM REFERENCES
// ============================================================================

const fileInput = document.getElementById("file-input");
const decodeBadge = document.getElementById("decode-badge");
const decodeError = document.getElementById("decode-error");
const previewCanvas = document.getElementById("preview-canvas");

// Phase 3: scale panel.
const scaleModeRadios = document.querySelectorAll('input[name="scale-mode"]');
const scaleValueInput = document.getElementById("scale-value");
const scaleValueLabel = document.getElementById("scale-value-label");
const scaleReadout = document.getElementById("scale-readout");

// Phase 3: depth/zero/origin panel.
const zeroModeSelect = document.getElementById("zero-mode");
const blackInputEl = document.getElementById("black-input");
const whiteInputEl = document.getElementById("white-input");
const blackInputLabel = document.getElementById("black-input-label");
const whiteInputLabel = document.getElementById("white-input-label");
const stockTopField = document.getElementById("stock-top-field");
const stockTopInputEl = document.getElementById("stock-top-input");
const safeZInputEl = document.getElementById("safe-z-input");
const originModeSelect = document.getElementById("origin-mode");
const depthReadout = document.getElementById("depth-readout");

// Phase 4: tool/pass panels.
const toolTableBody = document.getElementById("tool-table-body");
const addToolBtn = document.getElementById("add-tool-btn");
const passTableBody = document.getElementById("pass-table-body");
const addPassBtn = document.getElementById("add-pass-btn");
const validationMessagesEl = document.getElementById("validation-messages");
const generateBtn = document.getElementById("generate-btn");
const streamToFilesCheckbox = document.getElementById("stream-to-files-checkbox");
const singleFileCheckbox = document.getElementById("single-file-checkbox");

// ============================================================================
// PNG PARSING — signature + IHDR
// ============================================================================

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/**
 * Validate that an ArrayBuffer begins with the PNG signature.
 * @param {ArrayBuffer} buffer
 * @returns {boolean}
 */
function isPngSignatureValid(buffer) {
  if (!buffer || buffer.byteLength < 8) return false;
  const bytes = new Uint8Array(buffer, 0, 8);
  for (let i = 0; i < 8; i++) {
    if (bytes[i] !== PNG_SIGNATURE[i]) return false;
  }
  return true;
}

/**
 * Parse the IHDR chunk fields per Design.md "Image Decoding" step 2.
 * Assumes the PNG signature has already been validated and IHDR is the first
 * chunk (always true per the PNG spec: length@8, "IHDR"@12, data@16).
 * @param {ArrayBuffer} buffer
 * @returns {{width:number, height:number, bitDepth:number, colorType:number}}
 */
function parseIhdr(buffer) {
  if (buffer.byteLength < 26) {
    throw new Error("Malformed PNG: file too short to contain an IHDR header.");
  }
  const view = new DataView(buffer);
  // Sanity: bytes 12-15 should spell "IHDR".
  const chunkType =
    String.fromCharCode(view.getUint8(12)) +
    String.fromCharCode(view.getUint8(13)) +
    String.fromCharCode(view.getUint8(14)) +
    String.fromCharCode(view.getUint8(15));
  if (chunkType !== "IHDR") {
    throw new Error("Malformed PNG: first chunk is not IHDR.");
  }
  const width = view.getUint32(16, false); // big-endian
  const height = view.getUint32(20, false);
  const bitDepth = view.getUint8(24);
  const colorType = view.getUint8(25);
  if (!(width > 0) || !(height > 0)) {
    throw new Error("Malformed PNG: invalid image dimensions (" + width + "x" + height + ").");
  }
  // Guard against a tiny file declaring enormous dimensions (would drive a
  // multi-GB allocation in unfilterScanlines / canvas before any data check).
  if (width * height > 100000000) {
    throw new Error("PNG too large: " + width + "x" + height + " (" + (width * height) + " px) exceeds the 100-megapixel limit.");
  }
  return { width, height, bitDepth, colorType };
}

// ============================================================================
// IMAGE DECODING
// ============================================================================

// ----------------------------------------------------------------------------
// INFLATE (RFC 1951 DEFLATE decompressor) — tiny-inflate style, public-domain
// algorithm shape (this is the classic "puff"/"tinf" approach reimplemented
// from scratch for this project). Pure function of (Uint8Array, startOffset)
// -> Uint8Array; no DOM, no globals besides this file's own scope. Handles
// all three DEFLATE block types (stored, fixed Huffman, dynamic Huffman) and
// LZ77 length/distance back-references per RFC 1951 §3.2.
// ----------------------------------------------------------------------------

/**
 * Fixed-size lookup tables built once at module load: RFC 1951 length/
 * distance extra-bit counts and base values (§3.2.5), and the canonical
 * fixed Huffman code lengths (§3.2.6).
 */
const INFLATE_LENGTH_BASE = [
  3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67,
  83, 99, 115, 131, 163, 195, 227, 258,
];
const INFLATE_LENGTH_EXTRA_BITS = [
  0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5,
  5, 5, 0,
];
const INFLATE_DIST_BASE = [
  1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513,
  769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577,
];
const INFLATE_DIST_EXTRA_BITS = [
  0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11,
  11, 12, 12, 13, 13,
];
// Order in which code-length code lengths appear in a dynamic-Huffman header.
const INFLATE_CODE_LENGTH_ORDER = [
  16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15,
];

/**
 * Build a canonical Huffman decode table from an array of code lengths
 * (index = symbol, value = code length in bits; 0 = symbol unused), per the
 * canonical-Huffman construction in RFC 1951 §3.2.2.
 *
 * Returns { counts, symbols } where `counts[len]` is the number of codes of
 * that length and `symbols` lists the symbols in canonical order — the
 * representation used by the classic "puff.c" decode loop, which avoids
 * building an explicit bit-reversed table.
 *
 * @param {number[]|Uint8Array} lengths
 * @returns {{counts: Int32Array, symbols: Int32Array}}
 */
function inflateBuildHuffman(lengths) {
  const MAX_BITS = 15;
  const counts = new Int32Array(MAX_BITS + 1);
  for (let i = 0; i < lengths.length; i++) counts[lengths[i]]++;
  counts[0] = 0; // never any codes of length 0

  const offsets = new Int32Array(MAX_BITS + 2);
  for (let len = 1; len <= MAX_BITS; len++) {
    offsets[len + 1] = offsets[len] + counts[len];
  }

  const symbols = new Int32Array(lengths.length);
  for (let sym = 0; sym < lengths.length; sym++) {
    const len = lengths[sym];
    if (len !== 0) {
      symbols[offsets[len]] = sym;
      offsets[len]++;
    }
  }

  return { counts, symbols };
}

/**
 * Bit-level reader over a Uint8Array, LSB-first per DEFLATE's bit packing
 * (RFC 1951 §3.1.1: "packed starting with the least-significant bit").
 */
function InflateBitReader(data, byteOffset) {
  this.data = data;
  this.pos = byteOffset;
  this.bitBuf = 0;
  this.bitCount = 0;
}
InflateBitReader.prototype.getBits = function (n) {
  let buf = this.bitBuf;
  let count = this.bitCount;
  while (count < n) {
    if (this.pos >= this.data.length) {
      throw new Error("Inflate: unexpected end of input while reading bits.");
    }
    buf |= this.data[this.pos++] << count;
    count += 8;
  }
  const value = buf & ((1 << n) - 1);
  this.bitBuf = buf >>> n;
  this.bitCount = count - n;
  return value;
};
InflateBitReader.prototype.alignToByte = function () {
  this.bitBuf = 0;
  this.bitCount = 0;
};
/** Decode one symbol using a canonical Huffman table (puff.c-style loop). */
InflateBitReader.prototype.decodeSymbol = function (table) {
  const { counts, symbols } = table;
  let code = 0;
  let first = 0;
  let index = 0;
  for (let len = 1; len <= 15; len++) {
    code |= this.getBits(1);
    const count = counts[len];
    if (code - first < count) {
      return symbols[index + (code - first)];
    }
    index += count;
    first += count;
    first <<= 1;
    code <<= 1;
  }
  throw new Error("Inflate: invalid Huffman code (no matching symbol).");
};

// Fixed Huffman tables (RFC 1951 §3.2.6), built lazily and cached.
let INFLATE_FIXED_LITERAL_TABLE = null;
let INFLATE_FIXED_DISTANCE_TABLE = null;
function inflateGetFixedTables() {
  if (!INFLATE_FIXED_LITERAL_TABLE) {
    const litLengths = new Uint8Array(288);
    for (let i = 0; i <= 143; i++) litLengths[i] = 8;
    for (let i = 144; i <= 255; i++) litLengths[i] = 9;
    for (let i = 256; i <= 279; i++) litLengths[i] = 7;
    for (let i = 280; i <= 287; i++) litLengths[i] = 8;
    INFLATE_FIXED_LITERAL_TABLE = inflateBuildHuffman(litLengths);

    const distLengths = new Uint8Array(30).fill(5);
    INFLATE_FIXED_DISTANCE_TABLE = inflateBuildHuffman(distLengths);
  }
  return {
    literal: INFLATE_FIXED_LITERAL_TABLE,
    distance: INFLATE_FIXED_DISTANCE_TABLE,
  };
}

/**
 * Growable byte buffer used to collect inflate output without knowing the
 * final size up front (PNG scanline totals are computed by the caller, but
 * keeping this self-contained avoids a second dependency direction).
 */
function InflateOutputBuffer(initialCapacity) {
  this.buf = new Uint8Array(Math.max(initialCapacity || 0, 1024));
  this.len = 0;
}
InflateOutputBuffer.prototype.ensureCapacity = function (extra) {
  if (this.len + extra <= this.buf.length) return;
  let newCap = this.buf.length * 2;
  while (newCap < this.len + extra) newCap *= 2;
  const grown = new Uint8Array(newCap);
  grown.set(this.buf.subarray(0, this.len));
  this.buf = grown;
};
InflateOutputBuffer.prototype.pushByte = function (b) {
  this.ensureCapacity(1);
  this.buf[this.len++] = b;
};
InflateOutputBuffer.prototype.copyBack = function (distance, length) {
  this.ensureCapacity(length);
  let src = this.len - distance;
  if (src < 0) {
    throw new Error("Inflate: back-reference distance exceeds output produced so far.");
  }
  // Byte-by-byte because source and destination ranges can overlap
  // (distance < length is the normal RLE-style repeat case in DEFLATE).
  for (let i = 0; i < length; i++) {
    this.buf[this.len + i] = this.buf[src + i];
  }
  this.len += length;
};
InflateOutputBuffer.prototype.toUint8Array = function () {
  return this.buf.subarray(0, this.len);
};

/**
 * Inflate one Huffman-coded block (fixed or dynamic) given its literal/length
 * and distance decode tables. Shared by both block types per RFC 1951 §3.2.5.
 * Reads symbols until the end-of-block code (256) is decoded.
 */
function inflateDecodeHuffmanBlock(reader, out, literalTable, distanceTable) {
  for (;;) {
    const sym = reader.decodeSymbol(literalTable);
    if (sym < 256) {
      out.pushByte(sym);
    } else if (sym === 256) {
      return; // end of block
    } else {
      const lenIndex = sym - 257;
      if (lenIndex >= INFLATE_LENGTH_BASE.length) {
        throw new Error("Inflate: invalid length symbol " + sym);
      }
      const length =
        INFLATE_LENGTH_BASE[lenIndex] +
        reader.getBits(INFLATE_LENGTH_EXTRA_BITS[lenIndex]);
      const distSym = reader.decodeSymbol(distanceTable);
      if (distSym >= INFLATE_DIST_BASE.length) {
        throw new Error("Inflate: invalid distance symbol " + distSym);
      }
      const distance =
        INFLATE_DIST_BASE[distSym] +
        reader.getBits(INFLATE_DIST_EXTRA_BITS[distSym]);
      out.copyBack(distance, length);
    }
  }
}

/** Parse a dynamic-Huffman block header (RFC 1951 §3.2.7) and decode it. */
function inflateDecodeDynamicBlock(reader, out) {
  const hlit = reader.getBits(5) + 257; // # of literal/length codes
  const hdist = reader.getBits(5) + 1; // # of distance codes
  const hclen = reader.getBits(4) + 4; // # of code-length codes

  const codeLengthLengths = new Uint8Array(19);
  for (let i = 0; i < hclen; i++) {
    codeLengthLengths[INFLATE_CODE_LENGTH_ORDER[i]] = reader.getBits(3);
  }
  const codeLengthTable = inflateBuildHuffman(codeLengthLengths);

  // Decode hlit+hdist code lengths using the code-length Huffman table,
  // with repeat codes 16/17/18 per RFC 1951 §3.2.7.
  const totalLengths = hlit + hdist;
  const lengths = new Uint8Array(totalLengths);
  let i = 0;
  while (i < totalLengths) {
    const sym = reader.decodeSymbol(codeLengthTable);
    if (sym < 16) {
      lengths[i++] = sym;
    } else if (sym === 16) {
      if (i === 0) throw new Error("Inflate: repeat code 16 with no previous length.");
      const repeat = reader.getBits(2) + 3;
      if (i + repeat > totalLengths) throw new Error("Inflate: code-length repeat (16) overruns the table.");
      const prev = lengths[i - 1];
      for (let r = 0; r < repeat; r++) lengths[i++] = prev;
    } else if (sym === 17) {
      const repeat = reader.getBits(3) + 3;
      if (i + repeat > totalLengths) throw new Error("Inflate: code-length repeat (17) overruns the table.");
      for (let r = 0; r < repeat; r++) lengths[i++] = 0;
    } else if (sym === 18) {
      const repeat = reader.getBits(7) + 11;
      if (i + repeat > totalLengths) throw new Error("Inflate: code-length repeat (18) overruns the table.");
      for (let r = 0; r < repeat; r++) lengths[i++] = 0;
    } else {
      throw new Error("Inflate: invalid code-length symbol " + sym);
    }
  }

  const literalLengths = lengths.subarray(0, hlit);
  const distanceLengths = lengths.subarray(hlit, hlit + hdist);
  const literalTable = inflateBuildHuffman(literalLengths);
  const distanceTable = inflateBuildHuffman(distanceLengths);

  inflateDecodeHuffmanBlock(reader, out, literalTable, distanceTable);
}

/** Decode one stored (uncompressed) block (RFC 1951 §3.2.4). */
function inflateDecodeStoredBlock(reader, out) {
  reader.alignToByte(); // stored blocks start on a byte boundary
  const data = reader.data;
  if (reader.pos + 4 > data.length) {
    throw new Error("Inflate: truncated stored-block header.");
  }
  const len = data[reader.pos] | (data[reader.pos + 1] << 8);
  // Next two bytes are ~len (one's complement), not verified — matches the
  // "don't need to verify" leniency the spec allows for the Adler trailer;
  // we apply the same tolerance here since our inputs are trusted PNG IDAT.
  reader.pos += 4;
  if (reader.pos + len > data.length) {
    throw new Error("Inflate: stored-block length exceeds available input.");
  }
  out.ensureCapacity(len);
  for (let i = 0; i < len; i++) {
    out.buf[out.len++] = data[reader.pos + i];
  }
  reader.pos += len;
}

/**
 * Inflate a raw DEFLATE bitstream (RFC 1951) starting at `byteOffset` in
 * `data`. Pure function: no DOM, no globals mutated besides the lazily-
 * cached fixed Huffman tables above.
 * @param {Uint8Array} data
 * @param {number} byteOffset
 * @returns {Uint8Array}
 */
function inflateRaw(data, byteOffset) {
  const reader = new InflateBitReader(data, byteOffset);
  const out = new InflateOutputBuffer(data.length * 4);

  let isFinal = 0;
  do {
    isFinal = reader.getBits(1);
    const blockType = reader.getBits(2);
    if (blockType === 0) {
      inflateDecodeStoredBlock(reader, out);
    } else if (blockType === 1) {
      const { literal, distance } = inflateGetFixedTables();
      inflateDecodeHuffmanBlock(reader, out, literal, distance);
    } else if (blockType === 2) {
      inflateDecodeDynamicBlock(reader, out);
    } else {
      throw new Error("Inflate: invalid DEFLATE block type (11 is reserved/error).");
    }
  } while (!isFinal);

  return out.toUint8Array();
}

/**
 * Inflate a zlib stream (RFC 1950): 2-byte header (CMF/FLG) + raw DEFLATE +
 * 4-byte Adler-32 trailer (not verified — see Design.md step 3). Throws a
 * clear error if the FDICT bit is set, since PNG IDAT never uses a preset
 * dictionary.
 * @param {Uint8Array} zlibBytes
 * @returns {Uint8Array} inflated (decompressed) bytes
 */
function inflateZlib(zlibBytes) {
  if (zlibBytes.length < 2) {
    throw new Error("Inflate: zlib stream too short to contain a header.");
  }
  const cmf = zlibBytes[0];
  const flg = zlibBytes[1];
  if ((cmf & 0x0f) !== 8) {
    throw new Error("Inflate: unsupported zlib compression method (expected CM=8/deflate).");
  }
  if ((cmf * 256 + flg) % 31 !== 0) {
    throw new Error("Inflate: zlib header checksum (FCHECK) failed.");
  }
  if (flg & 0x20) {
    throw new Error(
      "Inflate: zlib stream uses a preset dictionary (FDICT set), which is not supported."
    );
  }
  // Skip the 2-byte zlib header; ignore the trailing 4-byte Adler-32 (the
  // raw DEFLATE decoder stops naturally at the final block's end).
  return inflateRaw(zlibBytes, 2);
}

// ----------------------------------------------------------------------------
// PNG CHUNK WALK + SCANLINE UNFILTER — pure functions (no DOM), used by the
// 16-bit decode path and unit-testable directly from Node.
// ----------------------------------------------------------------------------

/**
 * Walk PNG chunks starting at byte offset 8 (just after the 8-byte
 * signature) and concatenate the payloads of every IDAT chunk, in order,
 * stopping at IEND. Per Design.md step 1: chunk = length(u32 BE) +
 * type(4 bytes) + data(length bytes) + CRC(4 bytes); CRC is not verified.
 * @param {Uint8Array} bytes - full PNG file bytes
 * @returns {Uint8Array} concatenated IDAT payloads
 */
function collectIdatData(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const idatParts = [];
  let totalLength = 0;
  let offset = 8;

  while (offset + 8 <= bytes.length) {
    const length = view.getUint32(offset, false);
    const type =
      String.fromCharCode(bytes[offset + 4]) +
      String.fromCharCode(bytes[offset + 5]) +
      String.fromCharCode(bytes[offset + 6]) +
      String.fromCharCode(bytes[offset + 7]);
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    if (dataEnd + 4 > bytes.length) {
      throw new Error("Malformed PNG: chunk length exceeds file size.");
    }

    if (type === "IDAT") {
      const chunkData = bytes.subarray(dataStart, dataEnd);
      idatParts.push(chunkData);
      totalLength += chunkData.length;
    } else if (type === "IEND") {
      break;
    }

    offset = dataEnd + 4; // skip past CRC to next chunk
  }

  if (idatParts.length === 0) {
    throw new Error("Malformed PNG: no IDAT chunks found.");
  }

  const combined = new Uint8Array(totalLength);
  let pos = 0;
  for (const part of idatParts) {
    combined.set(part, pos);
    pos += part.length;
  }
  return combined;
}

/** Paeth predictor per the PNG spec (§9.4 "Filter type 4: Paeth"). */
function paethPredictor(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

/**
 * Reverse PNG scanline filtering (filters 0-4: None/Sub/Up/Average/Paeth per
 * PNG spec §9.2-9.4). Input is the raw inflated byte stream: `height` rows,
 * each `1 + stride` bytes (filter-type byte + `stride` filtered data bytes).
 * Returns a flat Uint8Array of `height * stride` reconstructed bytes (filter
 * bytes stripped out).
 * @param {Uint8Array} inflated
 * @param {number} height
 * @param {number} stride - bytes per scanline of pixel data (width * bpp)
 * @param {number} bpp - bytes per pixel (for Sub/Average/Paeth left lookback)
 * @returns {Uint8Array}
 */
function unfilterScanlines(inflated, height, stride, bpp) {
  // One filter-type byte per row + `stride` data bytes per row. If the inflated
  // stream is short, the PNG is truncated/corrupt — reject it up front (before
  // allocating `out`) rather than silently zero-filling the remaining rows.
  const expected = height * (stride + 1);
  if (inflated.length < expected) {
    throw new Error("PNG unfilter: inflated data shorter than expected (" + inflated.length + " < " + expected + " bytes) — the PNG may be truncated or corrupt.");
  }
  const out = new Uint8Array(height * stride);
  let priorRowStart = -1; // no prior row for y===0 (treated as all zeros)
  let inPos = 0;

  for (let y = 0; y < height; y++) {
    if (inPos >= inflated.length) {
      throw new Error("PNG unfilter: inflated data shorter than expected (row " + y + ").");
    }
    const filterType = inflated[inPos++];
    const rowStart = y * stride;

    for (let x = 0; x < stride; x++) {
      const rawByte = inflated[inPos++];
      const left = x >= bpp ? out[rowStart + x - bpp] : 0;
      const up = priorRowStart >= 0 ? out[priorRowStart + x] : 0;
      const upLeft = priorRowStart >= 0 && x >= bpp ? out[priorRowStart + x - bpp] : 0;

      let reconstructed;
      switch (filterType) {
        case 0: // None
          reconstructed = rawByte;
          break;
        case 1: // Sub
          reconstructed = rawByte + left;
          break;
        case 2: // Up
          reconstructed = rawByte + up;
          break;
        case 3: // Average
          reconstructed = rawByte + Math.floor((left + up) / 2);
          break;
        case 4: // Paeth
          reconstructed = rawByte + paethPredictor(left, up, upLeft);
          break;
        default:
          throw new Error("PNG unfilter: unknown filter type " + filterType + " at row " + y);
      }
      out[rowStart + x] = reconstructed & 0xff;
    }

    priorRowStart = rowStart;
  }

  return out;
}

/**
 * Extract normalized gray + cut-mask samples from unfiltered 16-bit PNG
 * scanline bytes, per Design.md step 4 ("Extract samples"). Big-endian
 * 16-bit samples: for colorType 4 (grayscale+alpha) each pixel is
 * [gray16, alpha16] (4 bytes); for colorType 0 (grayscale-only) each pixel
 * is [gray16] (2 bytes) with alpha implicitly opaque.
 * @param {Uint8Array} unfiltered - flat, filter bytes already stripped
 * @param {number} width
 * @param {number} height
 * @param {number} colorType - 0 (grayscale) or 4 (grayscale+alpha)
 * @returns {HeightMap}
 */
function extractSamples16(unfiltered, width, height, colorType) {
  const n = width * height;
  const gray = new Float32Array(n);
  const cut = new Uint8Array(n);
  const bpp = colorType === 4 ? 4 : 2;

  for (let i = 0; i < n; i++) {
    const o = i * bpp;
    const gray16 = (unfiltered[o] << 8) | unfiltered[o + 1];
    gray[i] = gray16 / 65535;

    if (colorType === 4) {
      const alpha16 = (unfiltered[o + 2] << 8) | unfiltered[o + 3];
      // Require substantial opacity (>= 50%), not merely alpha > 0. An
      // anti-aliased mask edge has a fringe of near-transparent pixels whose
      // gray is a blend with the background; treating a 1%-opaque pixel as
      // solid material cuts it at that bogus (often raised) height, leaving a
      // lip around the part. 50% coverage is the standard mask contour.
      cut[i] = alpha16 >= 32768 ? 1 : 0;
    } else {
      cut[i] = 1; // colorType 0: no alpha channel, always opaque
    }
  }

  return { width, height, gray, cut, bits: 16 };
}

/**
 * Full-precision 16-bit decode path (Design.md "Image Decoding" step 3).
 * Applies when bitDepth===16 AND colorType is 0 (grayscale) or 4
 * (grayscale+alpha). Pure function of (buffer, ihdr): no DOM, no Canvas, no
 * globals mutated — safe to unit test directly under Node.
 *
 * @param {ArrayBuffer} buffer
 * @param {{width:number, height:number, bitDepth:number, colorType:number}} ihdr
 * @returns {HeightMap}
 */
function decodePng16(buffer, ihdr) {
  const bytes = new Uint8Array(buffer);
  const idatBytes = collectIdatData(bytes);
  const inflated = inflateZlib(idatBytes);

  const bpp = ihdr.colorType === 4 ? 4 : 2; // GA16=4 bytes/px, G16=2 bytes/px
  const stride = ihdr.width * bpp;
  const unfiltered = unfilterScanlines(inflated, ihdr.height, stride, bpp);

  return extractSamples16(unfiltered, ihdr.width, ihdr.height, ihdr.colorType);
}

/**
 * Fallback 8-bit path (Design.md "Image Decoding" step 4). Used for anything
 * that isn't routed to decodePng16: 8-bit grayscale/RGB/palette/RGBA, or any
 * other bit depth. Draws the PNG onto an offscreen canvas and derives gray/cut
 * from getImageData via the Rec. 709 luminance formula.
 *
 * @param {Blob} fileBlob - the raw file, wrapped as a Blob for createObjectURL.
 * @param {{width:number, height:number}} ihdr - for sanity-checking dimensions.
 * @returns {Promise<HeightMap>}
 */
function decodePng8ViaCanvas(fileBlob, ihdr) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(fileBlob);
    const img = new Image();

    img.onload = () => {
      try {
        const width = img.naturalWidth;
        const height = img.naturalHeight;

        const offscreen = document.createElement("canvas");
        offscreen.width = width;
        offscreen.height = height;
        const ctx = offscreen.getContext("2d", { willReadFrequently: true });
        ctx.drawImage(img, 0, 0);

        const imageData = ctx.getImageData(0, 0, width, height);
        const pixels = imageData.data; // Uint8ClampedArray, RGBA RGBA ...

        const n = width * height;
        const gray = new Float32Array(n);
        const cut = new Uint8Array(n);

        for (let i = 0; i < n; i++) {
          const o = i * 4;
          const r = pixels[o];
          const g = pixels[o + 1];
          const b = pixels[o + 2];
          const a = pixels[o + 3];
          // Luminance (Rec. 709 coefficients per spec).
          const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
          gray[i] = lum / 255;
          // Require >= 50% opacity (see extractSamples16): an anti-aliased mask
          // fringe of near-transparent pixels carries blended gray that would
          // otherwise be cut as a raised lip around the part.
          cut[i] = a >= 128 ? 1 : 0;
        }

        /** @type {HeightMap} */
        const heightMap = {
          width,
          height,
          gray,
          cut,
          bits: 8, // Phase 1 always sets bits=8 for this path.
        };

        URL.revokeObjectURL(url);
        resolve(heightMap);
      } catch (err) {
        URL.revokeObjectURL(url);
        reject(err);
      }
    };

    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("Browser could not decode this file as an image."));
    };

    img.src = url;
  });
}

/**
 * Top-level decode entry point: validates the PNG, parses IHDR, and routes to
 * the 16-bit or 8-bit path per Design.md's auto-selection rule.
 * @param {ArrayBuffer} buffer
 * @param {Blob} fileBlob
 * @returns {Promise<HeightMap>}
 */
async function decodePng(buffer, fileBlob) {
  if (!isPngSignatureValid(buffer)) {
    throw new Error(
      "Not a valid PNG file (signature mismatch). Please choose a .png depth map."
    );
  }

  const ihdr = parseIhdr(buffer);

  const wants16BitPath =
    ihdr.bitDepth === 16 && (ihdr.colorType === 0 || ihdr.colorType === 4);

  if (wants16BitPath) {
    // PHASE 2 HOOK — see decodePng16() above.
    return decodePng16(buffer, ihdr);
  }

  return decodePng8ViaCanvas(fileBlob, ihdr);
}

// ============================================================================
// PREVIEW RENDERING
// ============================================================================

/**
 * Render a HeightMap into the preview canvas: grayscale image with cut===0
 * pixels overlaid as magenta at ~40% alpha, per Design.md "UI Spec".
 * @param {HeightMap} heightMap
 * @param {HTMLCanvasElement} canvas
 */
function renderPreview(heightMap, canvas) {
  const { width, height, gray, cut } = heightMap;

  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");

  const imageData = ctx.createImageData(width, height);
  const out = imageData.data;

  // Magenta overlay color + alpha (~40%).
  const MASK_R = 255;
  const MASK_G = 0;
  const MASK_B = 255;
  const MASK_ALPHA = 0.4;

  const n = width * height;
  for (let i = 0; i < n; i++) {
    const g255 = Math.round(clamp01(gray[i]) * 255);
    const o = i * 4;

    if (cut[i] === 0) {
      // Blend grayscale with magenta at MASK_ALPHA.
      out[o] = Math.round(g255 * (1 - MASK_ALPHA) + MASK_R * MASK_ALPHA);
      out[o + 1] = Math.round(g255 * (1 - MASK_ALPHA) + MASK_G * MASK_ALPHA);
      out[o + 2] = Math.round(g255 * (1 - MASK_ALPHA) + MASK_B * MASK_ALPHA);
      out[o + 3] = 255;
    } else {
      out[o] = g255;
      out[o + 1] = g255;
      out[o + 2] = g255;
      out[o + 3] = 255;
    }
  }

  ctx.putImageData(imageData, 0, 0);
}

function clamp01(v) {
  if (v < 0) return 0;
  if (v > 1) return 1;
  return v;
}

// ============================================================================
// PHASE 3 — SCALE CONVERSION, DEPTH MAPPING, ZERO/ORIGIN TRANSFORM
// Pure functions (no DOM) per Design.md "Scale Conversion", "Depth Mapping
// (exact)", and "Zero & Origin — Machine Coordinate Transform". Node-testable.
// ============================================================================

/**
 * Convert a scale-mode input value into mm-per-pixel.
 * @param {"ppm"|"widthMm"|"heightMm"} mode
 * @param {number} value - the user-entered numeric value for that mode.
 * @param {number} widthPx
 * @param {number} heightPx
 * @returns {number} pixelSizeMm
 */
function scaleToPixelSizeMm(mode, value, widthPx, heightPx) {
  if (mode === "ppm") return 1 / value;
  if (mode === "widthMm") return value / widthPx;
  if (mode === "heightMm") return value / heightPx;
  throw new Error("scaleToPixelSizeMm: unknown mode " + mode);
}

/**
 * Depth mapping: normalized gray (0=black,1=white) -> machine Z (mm) per
 * Design.md "Depth Mapping (exact)".
 * @param {number} gray - 0..1
 * @param {number} zAtBlackMm
 * @param {number} zAtWhiteMm
 * @returns {number}
 */
function surfaceZmm(gray, zAtBlackMm, zAtWhiteMm) {
  return zAtBlackMm + gray * (zAtWhiteMm - zAtBlackMm);
}

/**
 * Compute the terrain array (machine Z per pixel) for a HeightMap: surfaceZmm
 * where cut===1, -Infinity ("no material / no constraint") where cut===0.
 * @param {HeightMap} heightMap
 * @param {number} zAtBlackMm
 * @param {number} zAtWhiteMm
 * @returns {Float32Array} length width*height
 */
function computeTerrain(heightMap, zAtBlackMm, zAtWhiteMm) {
  const { width, height, gray, cut } = heightMap;
  const n = width * height;
  const terrain = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    terrain[i] = cut[i] === 1 ? surfaceZmm(gray[i], zAtBlackMm, zAtWhiteMm) : -Infinity;
  }
  return terrain;
}

/**
 * Convert a pixel (image space, origin top-left, integer px/py) to machine
 * (X,Y) mm at the pixel center, per Design.md "Zero & Origin — Machine
 * Coordinate Transform". Y flips between image space (down positive) and
 * machine space (up positive).
 * @param {number} px
 * @param {number} py
 * @param {number} pixelSizeMm
 * @param {number} widthPx
 * @param {number} heightPx
 * @param {"center"|"lowerLeft"} originMode
 * @returns {{x:number, y:number}}
 */
function pixelCenterToMachineXY(px, py, pixelSizeMm, widthPx, heightPx, originMode) {
  if (originMode === "center") {
    return {
      x: (px + 0.5 - widthPx / 2) * pixelSizeMm,
      y: (heightPx / 2 - py - 0.5) * pixelSizeMm,
    };
  }
  if (originMode === "lowerLeft") {
    return {
      x: (px + 0.5) * pixelSizeMm,
      y: (heightPx - py - 0.5) * pixelSizeMm,
    };
  }
  throw new Error("pixelCenterToMachineXY: unknown originMode " + originMode);
}

// ============================================================================
// UI WIRING — badge, errors, file input
// ============================================================================

function setBadge(text, kind) {
  decodeBadge.textContent = text;
  decodeBadge.classList.remove("badge-empty", "badge-ok", "badge-error");
  decodeBadge.classList.add(
    kind === "ok" ? "badge-ok" : kind === "error" ? "badge-error" : "badge-empty"
  );
}

function showError(message) {
  decodeError.textContent = message;
  decodeError.hidden = false;
}

function clearError() {
  decodeError.textContent = "";
  decodeError.hidden = true;
}

/** Strip a filename's extension (used for the badge and later GCode filenames). */
function baseNameWithoutExtension(filename) {
  const idx = filename.lastIndexOf(".");
  return idx === -1 ? filename : filename.slice(0, idx);
}

/**
 * Handle a newly selected file: read as ArrayBuffer, validate + decode,
 * update state, badge, and preview.
 * @param {File} file
 */
function handleFileSelected(file) {
  clearError();
  setBadge("Decoding…", null);

  if (!file) {
    setBadge("No image loaded", null);
    return;
  }

  const reader = new FileReader();

  reader.onerror = () => {
    setBadge("Decode failed", "error");
    showError("Could not read the selected file.");
  };

  reader.onload = async () => {
    const buffer = reader.result; // ArrayBuffer

    try {
      const heightMap = await decodePng(buffer, file);

      currentHeightMap = heightMap;
      currentImageBaseName = baseNameWithoutExtension(file.name);

      // Keep JobSpec's image fields in sync.
      currentJobSpec.imageName = file.name;
      currentJobSpec.widthPx = heightMap.width;
      currentJobSpec.heightPx = heightMap.height;

      setBadge(
        `${heightMap.bits}-bit${heightMap.bits === 8 ? " (Canvas)" : " precision"} — ${heightMap.width}×${heightMap.height}`,
        "ok"
      );

      renderPreview(heightMap, previewCanvas);

      // Phase 3: an image is now available — (re)compute scale/depth derived
      // state and the terrain array.
      updateScalePanel();
      updateDepthPanel();
    } catch (err) {
      currentHeightMap = null;
      setBadge("Decode failed", "error");
      showError(err && err.message ? err.message : String(err));
    }
  };

  reader.readAsArrayBuffer(file);
}

fileInput.addEventListener("change", (event) => {
  const file = event.target.files && event.target.files[0];
  handleFileSelected(file);
});

// ============================================================================
// PHASE 3 — UI WIRING: scale panel, depth/zero/origin panel, terrain recompute
// ============================================================================

/**
 * Read the current scale-mode radio value ("ppm" | "widthMm" | "heightMm").
 * @returns {string}
 */
function getSelectedScaleMode() {
  for (const radio of scaleModeRadios) {
    if (radio.checked) return radio.value;
  }
  return "ppm";
}

/** Relabel the single scale-value input per the selected scale mode. */
function updateScaleValueLabel() {
  const mode = getSelectedScaleMode();
  if (mode === "ppm") {
    scaleValueLabel.textContent = "Pixels per mm";
  } else if (mode === "widthMm") {
    scaleValueLabel.textContent = "Physical width (mm)";
  } else if (mode === "heightMm") {
    scaleValueLabel.textContent = "Physical height (mm)";
  }
}

/**
 * Recompute pixelSizeMm from the scale panel, update currentJobSpec, refresh
 * the readout (derived pixelSizeMm + physical size), and trigger a terrain
 * recompute. Safe to call with no image loaded (readout shows placeholder,
 * pixelSizeMm is still stored on currentJobSpec for when an image arrives).
 */
function updateScalePanel() {
  updateScaleValueLabel();

  const mode = getSelectedScaleMode();
  const value = parseFloat(scaleValueInput.value);
  const widthPx = currentHeightMap ? currentHeightMap.width : currentJobSpec.widthPx;
  const heightPx = currentHeightMap ? currentHeightMap.height : currentJobSpec.heightPx;

  let pixelSizeMm = NaN;
  if (Number.isFinite(value) && value > 0 && widthPx > 0 && heightPx > 0) {
    pixelSizeMm = scaleToPixelSizeMm(mode, value, widthPx, heightPx);
  }

  currentJobSpec.pixelSizeMm = Number.isFinite(pixelSizeMm) ? pixelSizeMm : null;

  if (Number.isFinite(pixelSizeMm) && pixelSizeMm > 0 && widthPx > 0 && heightPx > 0) {
    const physW = widthPx * pixelSizeMm;
    const physH = heightPx * pixelSizeMm;
    scaleReadout.textContent =
      `pixelSizeMm: ${pixelSizeMm.toFixed(5)}  |  physical size: ${physW.toFixed(2)} × ${physH.toFixed(2)} mm`;
  } else {
    scaleReadout.textContent = "pixelSizeMm: — (enter a valid scale value)";
  }

  recomputeTerrain();
}

/**
 * Show/hide the stock-top field and relabel the black/white depth inputs per
 * the selected zero-mode, per Design.md "Zero-mode input semantics":
 *   - "bed": inputs are heights above bed; stock-top field shown.
 *   - "stockTop": inputs are depths below top (positive); stock-top hidden
 *     (stockTopMm is fixed at 0).
 */
function updateZeroModeLabels() {
  const zeroMode = zeroModeSelect.value;
  if (zeroMode === "bed") {
    blackInputLabel.textContent = "Black height (mm)";
    whiteInputLabel.textContent = "White height (mm)";
    stockTopField.hidden = false;
  } else {
    blackInputLabel.textContent = "Black depth (mm)";
    whiteInputLabel.textContent = "White depth (mm)";
    stockTopField.hidden = true;
  }
}

/**
 * Recompute zAtBlackMm/zAtWhiteMm/stockTopMm/safeZMm/zeroMode/originMode from
 * the depth panel, update currentJobSpec, refresh the readout, and trigger a
 * terrain recompute. Safe to call with no image loaded.
 */
function updateDepthPanel() {
  updateZeroModeLabels();

  const zeroMode = zeroModeSelect.value; // "bed" | "stockTop"
  const originMode = originModeSelect.value; // "center" | "lowerLeft"
  const blackInput = parseFloat(blackInputEl.value);
  const whiteInput = parseFloat(whiteInputEl.value);

  let zAtBlackMm = null;
  let zAtWhiteMm = null;
  if (Number.isFinite(blackInput) && Number.isFinite(whiteInput)) {
    if (zeroMode === "bed") {
      zAtBlackMm = blackInput;
      zAtWhiteMm = whiteInput;
    } else {
      zAtBlackMm = -blackInput;
      zAtWhiteMm = -whiteInput;
    }
  }

  let stockTopMm;
  if (zeroMode === "stockTop") {
    stockTopMm = 0;
  } else {
    const stockTopInput = parseFloat(stockTopInputEl.value);
    if (Number.isFinite(stockTopInput)) {
      stockTopMm = stockTopInput;
    } else if (zAtBlackMm !== null && zAtWhiteMm !== null) {
      stockTopMm = Math.max(zAtBlackMm, zAtWhiteMm);
    } else {
      stockTopMm = null;
    }
  }

  const safeZInput = parseFloat(safeZInputEl.value);
  let safeZMm;
  if (Number.isFinite(safeZInput)) {
    safeZMm = safeZInput;
  } else if (stockTopMm !== null) {
    safeZMm = zeroMode === "bed" ? stockTopMm + 5 : 5;
  } else {
    safeZMm = null;
  }

  currentJobSpec.zeroMode = zeroMode;
  currentJobSpec.originMode = originMode;
  currentJobSpec.zAtBlackMm = zAtBlackMm;
  currentJobSpec.zAtWhiteMm = zAtWhiteMm;
  currentJobSpec.stockTopMm = stockTopMm;
  currentJobSpec.safeZMm = safeZMm;

  recomputeTerrain();
}

/**
 * Recompute currentTerrain from currentHeightMap + currentJobSpec, and update
 * the terrain Z-range readout. No-op (skipped) if no image is loaded yet, or
 * if zAtBlackMm/zAtWhiteMm aren't valid numbers yet.
 */
function recomputeTerrain() {
  // Phase 4: re-run validation whenever image/scale/depth state changes
  // (runValidation is a no-op-safe pure-state reader; guarded because Phase 4
  // wiring runs after this function is first defined but before it exists on
  // first module evaluation is not actually a concern — function declarations
  // are hoisted — this guard just protects against future refactors).
  if (typeof runValidation === "function") {
    runValidation();
  }

  if (!currentHeightMap) {
    currentTerrain = null;
    depthReadout.textContent = "Surface Z range: — (no image loaded)";
    return;
  }

  const { zAtBlackMm, zAtWhiteMm } = currentJobSpec;
  if (!Number.isFinite(zAtBlackMm) || !Number.isFinite(zAtWhiteMm)) {
    currentTerrain = null;
    depthReadout.textContent = "Surface Z range: — (enter black/white values)";
    return;
  }

  currentTerrain = computeTerrain(currentHeightMap, zAtBlackMm, zAtWhiteMm);

  let min = Infinity;
  let max = -Infinity;
  const { cut } = currentHeightMap;
  for (let i = 0; i < currentTerrain.length; i++) {
    if (cut[i] !== 1) continue;
    const z = currentTerrain[i];
    if (z < min) min = z;
    if (z > max) max = z;
  }

  if (min === Infinity) {
    depthReadout.textContent = "Surface Z range: — (no cut pixels)";
  } else {
    depthReadout.textContent = `Surface Z range: ${min.toFixed(3)} .. ${max.toFixed(3)} mm`;
  }
}

// Wire up change listeners for the scale panel.
for (const radio of scaleModeRadios) {
  radio.addEventListener("change", updateScalePanel);
}
scaleValueInput.addEventListener("input", updateScalePanel);

// Wire up change listeners for the depth/zero/origin panel.
zeroModeSelect.addEventListener("change", updateDepthPanel);
originModeSelect.addEventListener("change", updateDepthPanel);
blackInputEl.addEventListener("input", updateDepthPanel);
whiteInputEl.addEventListener("input", updateDepthPanel);
stockTopInputEl.addEventListener("input", updateDepthPanel);
safeZInputEl.addEventListener("input", updateDepthPanel);

// Initialize panel labels/readouts at load (defaults are pre-filled in HTML:
// ppm=4, bed mode, black height 3, white height 38, origin center).
updateScalePanel();
updateDepthPanel();

// ============================================================================
// PHASE 4 — TOOL TABLE, PASS TABLE, DEFAULT SEED, VALIDATION
// See Design.md "Data Model", "UI Spec", and "Validation".
// ============================================================================

/**
 * Build a default ToolSpec, per Design.md "Default seed". `radiusMm` is
 * always derived from `diameterMm` — never a separate input.
 * @param {Partial<object>} fields
 * @returns {object} ToolSpec
 */
function makeTool(fields) {
  const diameterMm = fields.diameterMm;
  return {
    id: nextToolId(),
    name: fields.name,
    shape: fields.shape,
    diameterMm: diameterMm,
    radiusMm: diameterMm / 2,
    stepoverMm: fields.stepoverMm,
    maxStepdownMm: fields.maxStepdownMm,
    feedMmMin: fields.feedMmMin,
    plungeMmMin: fields.plungeMmMin,
    spindleRpm: fields.spindleRpm,
    toolNumber: fields.toolNumber === undefined ? null : fields.toolNumber,
  };
}

/**
 * Build a default PassSpec, per Design.md "Default seed".
 * @param {Partial<object>} fields
 * @returns {object} PassSpec
 */
function makePass(fields) {
  return {
    id: nextPassId(),
    name: fields.name,
    toolId: fields.toolId,
    direction: fields.direction,
    stepoverMm: fields.stepoverMm === undefined ? null : fields.stepoverMm,
    maxStepdownMm: fields.maxStepdownMm === undefined ? null : fields.maxStepdownMm,
    allowanceMm: fields.allowanceMm,
    outlineWidthMm: fields.outlineWidthMm === undefined ? 15 : fields.outlineWidthMm,
    outlineDepthMm: fields.outlineDepthMm === undefined ? null : fields.outlineDepthMm,
    enabled: fields.enabled,
  };
}

/**
 * Populate currentTools / currentJobSpec.passes with the Design.md default
 * seed. Called once at startup. All values remain editable afterward.
 */
function seedDefaults() {
  const flatTool = makeTool({
    name: "flat_6_35mm",
    shape: "flat",
    diameterMm: 6.35,
    stepoverMm: 3,
    maxStepdownMm: 3,
    feedMmMin: 1800,
    plungeMmMin: 700,
    spindleRpm: 15000,
    toolNumber: 1,
  });
  const ballTool = makeTool({
    name: "ball_1mm",
    shape: "ball",
    diameterMm: 1,
    stepoverMm: 0.2,
    maxStepdownMm: 2,
    feedMmMin: 1500,
    plungeMmMin: 700,
    spindleRpm: 20000,
    toolNumber: 2,
  });
  currentTools = [flatTool, ballTool];

  currentJobSpec.passes = [
    makePass({
      name: "Rough",
      toolId: flatTool.id,
      direction: "rtl",
      stepoverMm: null,
      maxStepdownMm: null,
      allowanceMm: 0.8,
      enabled: true,
    }),
    makePass({
      name: "Finish",
      toolId: ballTool.id,
      direction: "zigzag",
      stepoverMm: null,
      maxStepdownMm: null,
      allowanceMm: 0,
      enabled: true,
    }),
  ];
}

// ----------------------------------------------------------------------------
// Tool table rendering + editing
// ----------------------------------------------------------------------------

/** Re-render the entire tool table body from currentTools, then re-render the
 *  pass table (its tool dropdowns depend on currentTools) and re-validate. */
function renderToolTable() {
  toolTableBody.innerHTML = "";

  currentTools.forEach((tool, index) => {
    const tr = document.createElement("tr");
    tr.dataset.toolId = tool.id;

    tr.appendChild(makeTableCell(makeNullableNumberInput(tool.toolNumber, (val) => {
      tool.toolNumber = val;
      runValidation();
    }, "auto")));

    tr.appendChild(makeTableCell(makeTextInput(tool.name, (val) => {
      tool.name = val;
      renderPassTable(); // tool names shown in pass dropdowns
      runValidation();
    })));

    tr.appendChild(makeTableCell(makeSelectInput(
      [["flat", "Flat"], ["ball", "Ball"]],
      tool.shape,
      (val) => {
        tool.shape = val;
        runValidation();
      }
    )));

    tr.appendChild(makeTableCell(makeNumberInput(tool.diameterMm, (val) => {
      tool.diameterMm = val;
      tool.radiusMm = val / 2;
      radiusInput.value = Number.isFinite(tool.radiusMm) ? tool.radiusMm : "";
      runValidation();
    })));

    const radiusInput = document.createElement("input");
    radiusInput.type = "number";
    radiusInput.className = "readonly-derived";
    radiusInput.value = Number.isFinite(tool.radiusMm) ? tool.radiusMm : "";
    radiusInput.readOnly = true;
    radiusInput.tabIndex = -1;
    tr.appendChild(makeTableCell(radiusInput));

    tr.appendChild(makeTableCell(makeNumberInput(tool.stepoverMm, (val) => {
      tool.stepoverMm = val;
      runValidation();
    })));

    tr.appendChild(makeTableCell(makeNumberInput(tool.maxStepdownMm, (val) => {
      tool.maxStepdownMm = val;
      runValidation();
    })));

    tr.appendChild(makeTableCell(makeNumberInput(tool.feedMmMin, (val) => {
      tool.feedMmMin = val;
      runValidation();
    })));

    tr.appendChild(makeTableCell(makeNumberInput(tool.plungeMmMin, (val) => {
      tool.plungeMmMin = val;
      runValidation();
    })));

    tr.appendChild(makeTableCell(makeNumberInput(tool.spindleRpm, (val) => {
      tool.spindleRpm = val;
      runValidation();
    })));

    // Reorder buttons (tool IDs stay stable, so pass references remain valid).
    const upBtn = document.createElement("button");
    upBtn.type = "button";
    upBtn.className = "row-btn secondary";
    upBtn.textContent = "↑";
    upBtn.title = "Move up";
    upBtn.disabled = index === 0;
    upBtn.addEventListener("click", () => {
      if (index === 0) return;
      const [moved] = currentTools.splice(index, 1);
      currentTools.splice(index - 1, 0, moved);
      renderToolTable();
      renderPassTable();
      runValidation();
    });

    const downBtn = document.createElement("button");
    downBtn.type = "button";
    downBtn.className = "row-btn secondary";
    downBtn.textContent = "↓";
    downBtn.title = "Move down";
    downBtn.disabled = index === currentTools.length - 1;
    downBtn.addEventListener("click", () => {
      if (index === currentTools.length - 1) return;
      const [moved] = currentTools.splice(index, 1);
      currentTools.splice(index + 1, 0, moved);
      renderToolTable();
      renderPassTable();
      runValidation();
    });

    const reorderCell = document.createElement("td");
    reorderCell.appendChild(upBtn);
    reorderCell.appendChild(downBtn);
    tr.appendChild(reorderCell);

    const removeBtn = document.createElement("button");
    removeBtn.type = "button";
    removeBtn.className = "row-btn secondary";
    removeBtn.textContent = "Remove";
    removeBtn.addEventListener("click", () => {
      const removedId = tool.id;
      currentTools.splice(index, 1);
      // Keep pass.toolId consistent with what the re-rendered dropdowns show:
      // a pass pointing at the just-removed tool would otherwise display the
      // first remaining tool while still holding the stale id in state.
      if (currentTools.length > 0) {
        for (const p of currentJobSpec.passes) {
          if (p.toolId === removedId) p.toolId = currentTools[0].id;
        }
      }
      renderToolTable();
      renderPassTable();
      runValidation();
    });
    tr.appendChild(makeTableCell(removeBtn));

    toolTableBody.appendChild(tr);
  });
}

/** Append a new blank/default tool row to currentTools and re-render. */
function addTool() {
  const nextToolNumber = currentTools.reduce(
    (m, t) => (Number.isInteger(t.toolNumber) && t.toolNumber > m ? t.toolNumber : m), 0) + 1;
  currentTools.push(makeTool({
    name: "tool_" + toolIdCounter,
    shape: "flat",
    diameterMm: 3,
    stepoverMm: 1,
    maxStepdownMm: 1,
    feedMmMin: 1000,
    plungeMmMin: 300,
    spindleRpm: 10000,
    toolNumber: nextToolNumber,
  }));
  renderToolTable();
  renderPassTable();
  runValidation();
}

// ----------------------------------------------------------------------------
// Pass table rendering + editing
// ----------------------------------------------------------------------------

/** Re-render the entire pass table body from currentJobSpec.passes. */
function renderPassTable() {
  const passes = currentJobSpec.passes;
  passTableBody.innerHTML = "";
  const hasOutline = passes.some((p) => p.direction === "outline");

  passes.forEach((pass, index) => {
    const tr = document.createElement("tr");
    tr.dataset.passId = pass.id;

    tr.appendChild(makeTableCell(makeTextInput(pass.name, (val) => {
      pass.name = val;
      runValidation();
    })));

    const toolOptions = currentTools.map((t) => [t.id, t.name]);
    tr.appendChild(makeTableCell(makeSelectInput(toolOptions, pass.toolId, (val) => {
      pass.toolId = val;
      runValidation();
    })));

    tr.appendChild(makeTableCell(makeSelectInput(
      [["ltr", "Left→Right"], ["rtl", "Right→Left"], ["zigzag", "Zigzag"], ["outline", "Outline"]],
      pass.direction,
      (val) => {
        pass.direction = val;
        renderPassTable(); // switches the stepover/stepdown cells <-> width/depth cells
        runValidation();
      }
    )));

    // Stepover and Max-stepdown are dedicated columns used by BOTH raster
    // and outline passes (outline treats them as loop-spacing / depth-per-
    // pass overrides, falling back to tool defaults when null).
    tr.appendChild(makeTableCell(makeNullableNumberInput(pass.stepoverMm, (val) => {
      pass.stepoverMm = val;
      runValidation();
    }, "tool default")));

    tr.appendChild(makeTableCell(makeNullableNumberInput(pass.maxStepdownMm, (val) => {
      pass.maxStepdownMm = val;
      runValidation();
    }, "tool default")));

    if (pass.direction === "outline") {
      // Allowance is unused for outline passes.
      const allowanceCell = document.createElement("td");
      allowanceCell.textContent = "—";
      tr.appendChild(allowanceCell);
    } else {
      tr.appendChild(makeTableCell(makeNumberInput(pass.allowanceMm, (val) => {
        pass.allowanceMm = val;
        runValidation();
      })));
    }

    let outlineWidthCell;
    let outlineDepthCell;
    if (pass.direction === "outline") {
      outlineWidthCell = makeTableCell(makeNumberInput(pass.outlineWidthMm, (val) => {
        pass.outlineWidthMm = val;
        runValidation();
      }));
      outlineDepthCell = makeTableCell(makeNumberInput(pass.outlineDepthMm, (val) => {
        pass.outlineDepthMm = val;
        runValidation();
      }));
    } else {
      outlineWidthCell = document.createElement("td");
      outlineWidthCell.textContent = "—";
      outlineDepthCell = document.createElement("td");
      outlineDepthCell.textContent = "—";
    }
    outlineWidthCell.hidden = !hasOutline;
    outlineDepthCell.hidden = !hasOutline;
    tr.appendChild(outlineWidthCell);
    tr.appendChild(outlineDepthCell);

    const enabledInput = document.createElement("input");
    enabledInput.type = "checkbox";
    enabledInput.checked = !!pass.enabled;
    enabledInput.addEventListener("change", () => {
      pass.enabled = enabledInput.checked;
      runValidation();
    });
    tr.appendChild(makeTableCell(enabledInput));

    // Reorder buttons (order matters — passes run top-to-bottom).
    const upBtn = document.createElement("button");
    upBtn.type = "button";
    upBtn.className = "row-btn secondary";
    upBtn.textContent = "↑";
    upBtn.title = "Move up";
    upBtn.disabled = index === 0;
    upBtn.addEventListener("click", () => {
      if (index === 0) return;
      const [moved] = passes.splice(index, 1);
      passes.splice(index - 1, 0, moved);
      renderPassTable();
      runValidation();
    });

    const downBtn = document.createElement("button");
    downBtn.type = "button";
    downBtn.className = "row-btn secondary";
    downBtn.textContent = "↓";
    downBtn.title = "Move down";
    downBtn.disabled = index === passes.length - 1;
    downBtn.addEventListener("click", () => {
      if (index === passes.length - 1) return;
      const [moved] = passes.splice(index, 1);
      passes.splice(index + 1, 0, moved);
      renderPassTable();
      runValidation();
    });

    const reorderCell = document.createElement("td");
    reorderCell.appendChild(upBtn);
    reorderCell.appendChild(downBtn);
    tr.appendChild(reorderCell);

    const removeBtn = document.createElement("button");
    removeBtn.type = "button";
    removeBtn.className = "row-btn secondary";
    removeBtn.textContent = "Remove";
    removeBtn.addEventListener("click", () => {
      passes.splice(index, 1);
      renderPassTable();
      runValidation();
    });
    tr.appendChild(makeTableCell(removeBtn));

    passTableBody.appendChild(tr);
  });

  const thOutlineWidth = document.getElementById("th-outline-width");
  const thOutlineDepth = document.getElementById("th-outline-depth");
  if (thOutlineWidth) thOutlineWidth.hidden = !hasOutline;
  if (thOutlineDepth) thOutlineDepth.hidden = !hasOutline;
}

/** Append a new blank/default pass row and re-render. */
function addPass() {
  const defaultToolId = currentTools.length > 0 ? currentTools[0].id : null;
  currentJobSpec.passes.push(makePass({
    name: "Pass_" + passIdCounter,
    toolId: defaultToolId,
    direction: "ltr",
    stepoverMm: null,
    maxStepdownMm: null,
    allowanceMm: 0,
    outlineWidthMm: 15,
    outlineDepthMm: null,
    enabled: true,
  }));
  renderPassTable();
  runValidation();
}

// ----------------------------------------------------------------------------
// Small DOM helpers for building table cells/inputs.
// ----------------------------------------------------------------------------

function makeTableCell(child) {
  const td = document.createElement("td");
  td.appendChild(child);
  return td;
}

function makeTextInput(value, onChange) {
  const input = document.createElement("input");
  input.type = "text";
  input.value = value == null ? "" : value;
  input.addEventListener("input", () => onChange(input.value));
  return input;
}

function makeNumberInput(value, onChange) {
  const input = document.createElement("input");
  input.type = "number";
  input.step = "any";
  input.value = Number.isFinite(value) ? value : "";
  input.addEventListener("input", () => {
    const parsed = parseFloat(input.value);
    onChange(Number.isFinite(parsed) ? parsed : NaN);
  });
  return input;
}

/** Number input whose blank state maps to `null` (used by PassSpec's
 *  stepoverMm/maxStepdownMm — null means "use tool default"). */
function makeNullableNumberInput(value, onChange, placeholder) {
  const input = document.createElement("input");
  input.type = "number";
  input.step = "any";
  input.value = value === null || value === undefined || !Number.isFinite(value) ? "" : value;
  if (placeholder) input.placeholder = placeholder;
  input.addEventListener("input", () => {
    if (input.value.trim() === "") {
      onChange(null);
      return;
    }
    const parsed = parseFloat(input.value);
    onChange(Number.isFinite(parsed) ? parsed : null);
  });
  return input;
}

function makeSelectInput(optionPairs, selectedValue, onChange) {
  const select = document.createElement("select");
  for (const [val, label] of optionPairs) {
    const opt = document.createElement("option");
    opt.value = val;
    opt.textContent = label;
    if (val === selectedValue) opt.selected = true;
    select.appendChild(opt);
  }
  select.addEventListener("change", () => onChange(select.value));
  return select;
}

// ----------------------------------------------------------------------------
// Validation — pure function, Node-testable (Design.md "Validation").
// ----------------------------------------------------------------------------

/**
 * Validate a job configuration per Design.md "Validation". Pure function: no
 * DOM access, so it can be unit tested directly under Node.
 * @param {object} jobSpec - JobSpec (see Data Model); uses pixelSizeMm,
 *   zAtBlackMm, zAtWhiteMm, safeZMm, stockTopMm, passes.
 * @param {Array<object>} tools - ToolSpec[]
 * @param {object|null} heightMap - HeightMap (or null if no image loaded);
 *   uses width/height/bits (widthPx/heightPx may also be read from jobSpec).
 * @returns {{errors: string[], warnings: string[]}}
 */
function validateJob(jobSpec, tools, heightMap) {
  const errors = [];
  const warnings = [];

  // --- Hard errors -----------------------------------------------------
  if (!heightMap) {
    errors.push("No image loaded. Load a PNG depth map before generating.");
  }

  if (!Number.isFinite(jobSpec.pixelSizeMm) || jobSpec.pixelSizeMm <= 0) {
    errors.push(
      "Scale is invalid: pixelSizeMm must be a finite number greater than 0."
    );
  }

  const toolsById = new Map();
  for (const tool of tools) {
    toolsById.set(tool.id, tool);

    if (!(tool.diameterMm > 0)) {
      errors.push(`Tool "${tool.name}" has an invalid diameterMm (must be > 0).`);
    }
    if (!(tool.stepoverMm > 0)) {
      errors.push(`Tool "${tool.name}" has an invalid stepoverMm (must be > 0).`);
    }
    if (!(tool.maxStepdownMm > 0)) {
      errors.push(`Tool "${tool.name}" has an invalid maxStepdownMm (must be > 0).`);
    }
    if (!(tool.feedMmMin > 0)) {
      errors.push(`Tool "${tool.name}" has an invalid feedMmMin (must be > 0).`);
    }
    if (!(tool.plungeMmMin > 0)) {
      errors.push(`Tool "${tool.name}" has an invalid plungeMmMin (must be > 0).`);
    }
    if (tool.toolNumber != null && !(Number.isInteger(tool.toolNumber) && tool.toolNumber > 0)) {
      errors.push(`Tool "${tool.name}" has an invalid tool number (must be a positive whole number, or blank for auto).`);
    }
  }

  for (const pass of jobSpec.passes) {
    if (!toolsById.has(pass.toolId)) {
      errors.push(`Pass "${pass.name}" references an undefined tool (toolId "${pass.toolId}").`);
    }
    if (!pass.enabled) continue;

    // Per-pass numeric overrides: null/undefined means "use the tool default";
    // any value that IS set must be a positive finite number. A 0/negative
    // stepdown in particular would make a pass do no work (raster) or spin
    // forever (outline), so reject it up front.
    if (pass.stepoverMm != null && !(pass.stepoverMm > 0)) {
      errors.push(`Pass "${pass.name}" has an invalid stepover override (must be > 0 when set).`);
    }
    if (pass.maxStepdownMm != null && !(pass.maxStepdownMm > 0)) {
      errors.push(`Pass "${pass.name}" has an invalid max stepdown override (must be > 0 when set).`);
    }

    if (pass.direction === "outline") {
      if (!(Number.isFinite(pass.outlineWidthMm) && pass.outlineWidthMm > 0)) {
        errors.push(`Pass "${pass.name}" has an invalid outlineWidthMm (must be a finite number > 0).`);
      }
      if (!Number.isFinite(pass.outlineDepthMm)) {
        errors.push(`Pass "${pass.name}" has an invalid outlineDepthMm (must be a finite number).`);
      } else if (Number.isFinite(jobSpec.stockTopMm) && !(pass.outlineDepthMm < jobSpec.stockTopMm)) {
        errors.push(`Pass "${pass.name}" outline depth (${pass.outlineDepthMm}mm) is at or above stock top (${jobSpec.stockTopMm}mm) — no material would be cut.`);
      }
    } else {
      // Raster passes use allowanceMm; a blank/NaN allowance cell would flow
      // into the target-surface math and emit "Z NaN" moves.
      if (!Number.isFinite(pass.allowanceMm)) {
        errors.push(`Pass "${pass.name}" has an invalid allowance (must be a finite number).`);
      }
    }
  }

  const enabledPasses = jobSpec.passes.filter((p) => p.enabled);
  if (enabledPasses.length === 0) {
    errors.push("No enabled passes. Enable at least one pass to generate GCode.");
  }

  if (jobSpec.zAtBlackMm === jobSpec.zAtWhiteMm) {
    errors.push(
      "zAtBlackMm equals zAtWhiteMm: the depth range is flat, so there is nothing to cut."
    );
  }

  // --- Warnings ----------------------------------------------------------
  const widthPx = heightMap ? heightMap.width : jobSpec.widthPx;
  const heightPx = heightMap ? heightMap.height : jobSpec.heightPx;
  if (widthPx * heightPx > 4000000) {
    warnings.push(
      `Large image (${widthPx}×${heightPx} = ${widthPx * heightPx} px): generation may be slow and memory-intensive.`
    );
  }

  for (const pass of jobSpec.passes) {
    if (!pass.enabled) continue;
    if (pass.direction === "outline") continue; // raster-only checks don't apply
    const tool = toolsById.get(pass.toolId);
    if (!tool) continue; // already a hard error above
    const effectiveStepover = pass.stepoverMm === null || pass.stepoverMm === undefined
      ? tool.stepoverMm
      : pass.stepoverMm;
    if (Number.isFinite(effectiveStepover) && Number.isFinite(tool.diameterMm) &&
        effectiveStepover > tool.diameterMm) {
      warnings.push(
        `Pass "${pass.name}" effective stepover (${effectiveStepover}mm) exceeds tool "${tool.name}" diameter (${tool.diameterMm}mm) — uncut ridges may remain between rows.`
      );
    }
  }

  // Warn on duplicate explicit tool numbers (ambiguous for combined M6 output).
  const seenToolNums = new Map();
  for (const tool of tools) {
    if (Number.isInteger(tool.toolNumber) && tool.toolNumber > 0) {
      if (seenToolNums.has(tool.toolNumber)) {
        warnings.push(`Tools "${seenToolNums.get(tool.toolNumber)}" and "${tool.name}" both use tool number ${tool.toolNumber}; a combined (M6) file can't distinguish them.`);
      } else {
        seenToolNums.set(tool.toolNumber, tool.name);
      }
    }
  }

  // Warn about compute-cost cliffs reachable from ordinary inputs (a fine pixel
  // size combined with a large tool or a wide outline groove).
  if (Number.isFinite(jobSpec.pixelSizeMm) && jobSpec.pixelSizeMm > 0) {
    const psMm = jobSpec.pixelSizeMm;
    for (const tool of tools) {
      if (Number.isFinite(tool.radiusMm) && tool.radiusMm / psMm > 500) {
        warnings.push(`Tool "${tool.name}" radius is ~${Math.round(tool.radiusMm / psMm)}px at this scale; safe-surface and remaining-material stamping may be very slow.`);
      }
    }
    for (const pass of jobSpec.passes) {
      if (!pass.enabled || pass.direction !== "outline") continue;
      const t = toolsById.get(pass.toolId);
      if (!t || !Number.isFinite(t.radiusMm) || !Number.isFinite(pass.outlineWidthMm)) continue;
      const pad = Math.ceil((t.radiusMm + pass.outlineWidthMm) / psMm);
      const paddedPx = (widthPx + 2 * pad) * (heightPx + 2 * pad);
      if (paddedPx > 25000000) {
        warnings.push(`Outline pass "${pass.name}" would allocate a ~${Math.round(paddedPx / 1e6)} megapixel padded buffer; generation may be slow or run out of memory.`);
      }
    }
  }

  if (Number.isFinite(jobSpec.safeZMm) && Number.isFinite(jobSpec.stockTopMm) &&
      jobSpec.safeZMm <= jobSpec.stockTopMm) {
    warnings.push(
      `safeZMm (${jobSpec.safeZMm}mm) is at or below stockTopMm (${jobSpec.stockTopMm}mm): rapid moves may collide with stock.`
    );
  }

  if (heightMap && heightMap.bits === 8) {
    warnings.push(
      "Image was decoded via the 8-bit fallback path (256 levels): depth maps may show visible banding."
    );
  }

  return { errors, warnings };
}

// ----------------------------------------------------------------------------
// Validation UI wiring
// ----------------------------------------------------------------------------

/** Run validateJob against current state, render messages, and toggle the
 *  Generate button's enabled state (enabled only when there are 0 errors). */
function runValidation() {
  const { errors, warnings } = validateJob(currentJobSpec, currentTools, currentHeightMap);

  validationMessagesEl.innerHTML = "";
  for (const msg of errors) {
    const div = document.createElement("div");
    div.className = "msg-error";
    div.textContent = msg;
    validationMessagesEl.appendChild(div);
  }
  for (const msg of warnings) {
    const div = document.createElement("div");
    div.className = "msg-warning";
    div.textContent = msg;
    validationMessagesEl.appendChild(div);
  }

  generateBtn.disabled = errors.length > 0 || isGenerating;

  // Auto-save after any state change (runValidation is the common chokepoint:
  // scale/depth panels reach it via recomputeTerrain, and every tool/pass edit
  // calls it directly). Gated so init-time calls don't persist a partial state.
  if (settingsReady) saveSettingsToLocalStorage();

  return { errors, warnings };
}

addToolBtn.addEventListener("click", addTool);
addPassBtn.addEventListener("click", addPass);

generateBtn.addEventListener("click", () => {
  // PHASE 6 HOOK: handleGenerateClick is defined later in this file (in the
  // "PHASE 6 — RASTER GENERATION" section); function declarations are
  // hoisted, and this callback only runs on a later click event, so the
  // forward reference is safe.
  handleGenerateClick();
});

// ============================================================================
// SETTINGS PERSISTENCE — export/import to a .json file + auto-save to
// localStorage. Persists everything EXCEPT the loaded image (scale/depth/
// zero/origin input values, tools, and passes). Works under file:// in Chrome;
// all storage access is guarded so a blocked/unavailable store degrades
// gracefully to "no auto-save" (Export still works).
// ============================================================================

const SETTINGS_VERSION = 1;
const SETTINGS_STORAGE_KEY = "wbg.gcodeGenerator.settings.v1";

const settingsExportBtn = document.getElementById("settings-export-btn");
const settingsImportBtn = document.getElementById("settings-import-btn");
const settingsImportInput = document.getElementById("settings-import-input");
const settingsResetBtn = document.getElementById("settings-reset-btn");
const settingsStatusEl = document.getElementById("settings-status");

function setSettingsStatus(msg, kind) {
  settingsStatusEl.textContent = msg;
  settingsStatusEl.classList.remove("status-ok", "status-error");
  if (kind === "ok") settingsStatusEl.classList.add("status-ok");
  else if (kind === "error") settingsStatusEl.classList.add("status-error");
}

/** Snapshot persistable UI state: raw input strings (so blanks / "auto"
 *  restore exactly) plus deep copies of tools and passes. */
function collectSettings() {
  return {
    version: SETTINGS_VERSION,
    scale: { mode: getSelectedScaleMode(), value: scaleValueInput.value },
    depth: {
      zeroMode: zeroModeSelect.value,
      originMode: originModeSelect.value,
      blackInput: blackInputEl.value,
      whiteInput: whiteInputEl.value,
      stockTopInput: stockTopInputEl.value,
      safeZInput: safeZInputEl.value,
    },
    tools: currentTools.map((t) => ({ ...t })),
    passes: currentJobSpec.passes.map((p) => ({ ...p })),
  };
}

/** Coerce a restored tool object into a valid ToolSpec (numbers coerced,
 *  radius re-derived from diameter, id preserved or freshly assigned). */
function normalizeTool(t) {
  if (!t || typeof t !== "object") return null;
  const diameterMm = Number(t.diameterMm);
  return {
    id: typeof t.id === "string" && t.id ? t.id : nextToolId(),
    name: t.name == null ? "tool" : String(t.name),
    shape: t.shape === "ball" ? "ball" : "flat",
    diameterMm: diameterMm,
    radiusMm: Number.isFinite(diameterMm) ? diameterMm / 2 : NaN,
    stepoverMm: Number(t.stepoverMm),
    maxStepdownMm: Number(t.maxStepdownMm),
    feedMmMin: Number(t.feedMmMin),
    plungeMmMin: Number(t.plungeMmMin),
    spindleRpm: Number(t.spindleRpm),
    toolNumber: (Number.isFinite(Number(t.toolNumber)) && Number(t.toolNumber) > 0)
      ? Math.round(Number(t.toolNumber)) : null,
  };
}

/** Coerce a restored pass object into a valid PassSpec (null stepover/stepdown
 *  preserved as "use tool default"). */
function normalizePass(p) {
  if (!p || typeof p !== "object") return null;
  const nullableNum = (v) => (v === null || v === undefined || v === "" ? null : Number(v));
  return {
    id: typeof p.id === "string" && p.id ? p.id : nextPassId(),
    name: p.name == null ? "pass" : String(p.name),
    toolId: p.toolId == null ? "" : String(p.toolId),
    direction: p.direction === "rtl" || p.direction === "zigzag" || p.direction === "outline" ? p.direction : "ltr",
    stepoverMm: nullableNum(p.stepoverMm),
    maxStepdownMm: nullableNum(p.maxStepdownMm),
    allowanceMm: Number(p.allowanceMm),
    outlineWidthMm: p.outlineWidthMm === null || p.outlineWidthMm === undefined || p.outlineWidthMm === ""
      ? 15 : Number(p.outlineWidthMm),
    outlineDepthMm: nullableNum(p.outlineDepthMm),
    enabled: p.enabled !== false,
  };
}

/** Bump the id counters past any restored ids so new rows don't collide. */
function bumpIdCounters(tools, passes) {
  for (const t of tools) {
    const m = /^t(\d+)$/.exec(t.id || "");
    if (m) toolIdCounter = Math.max(toolIdCounter, Number(m[1]));
  }
  for (const p of passes) {
    const m = /^p(\d+)$/.exec(p.id || "");
    if (m) passIdCounter = Math.max(passIdCounter, Number(m[1]));
  }
}

/** Apply a settings object to the UI + state. Returns true on success. Robust
 *  to partial/invalid input (unknown fields ignored; bad values fall back). */
function applySettings(s) {
  if (!s || typeof s !== "object") return false;
  try {
    if (s.scale && typeof s.scale === "object") {
      if (s.scale.value !== undefined && s.scale.value !== null) scaleValueInput.value = s.scale.value;
      let matched = false;
      for (const radio of scaleModeRadios) {
        radio.checked = radio.value === s.scale.mode;
        if (radio.checked) matched = true;
      }
      if (!matched) for (const radio of scaleModeRadios) if (radio.value === "ppm") radio.checked = true;
    }
    if (s.depth && typeof s.depth === "object") {
      const d = s.depth;
      if (d.zeroMode === "bed" || d.zeroMode === "stockTop") zeroModeSelect.value = d.zeroMode;
      if (d.originMode === "center" || d.originMode === "lowerLeft") originModeSelect.value = d.originMode;
      if (d.blackInput !== undefined && d.blackInput !== null) blackInputEl.value = d.blackInput;
      if (d.whiteInput !== undefined && d.whiteInput !== null) whiteInputEl.value = d.whiteInput;
      if (d.stockTopInput !== undefined && d.stockTopInput !== null) stockTopInputEl.value = d.stockTopInput;
      if (d.safeZInput !== undefined && d.safeZInput !== null) safeZInputEl.value = d.safeZInput;
    }
    if (Array.isArray(s.tools)) currentTools = s.tools.map(normalizeTool).filter(Boolean);
    if (Array.isArray(s.passes)) currentJobSpec.passes = s.passes.map(normalizePass).filter(Boolean);
    bumpIdCounters(currentTools, currentJobSpec.passes);

    updateScalePanel();
    updateDepthPanel();
    renderToolTable();
    renderPassTable();
    runValidation();
    return true;
  } catch (e) {
    console.warn("applySettings failed:", e);
    return false;
  }
}

/** Save current settings to localStorage. Silent no-op if storage is
 *  unavailable (blocked under file://, private mode, quota exceeded). */
function saveSettingsToLocalStorage() {
  try {
    localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(collectSettings()));
  } catch (e) {
    /* storage blocked/unavailable — degrade to no auto-save without nagging */
  }
}

/** Load settings from localStorage, or null if absent/unavailable/corrupt. */
function loadSettingsFromLocalStorage() {
  try {
    const raw = localStorage.getItem(SETTINGS_STORAGE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch (e) {
    return null;
  }
}

/** Export current settings as a downloaded .json file. */
function exportSettings() {
  const json = JSON.stringify(collectSettings(), null, 2);
  const blob = new Blob([json], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  const base = currentImageBaseName ? currentImageBaseName + "_" : "";
  a.download = base + "gcode-settings.json";
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  setSettingsStatus("Exported " + a.download, "ok");
}

/** Import settings from a chosen .json file, apply, and persist. */
function importSettingsFromFile(file) {
  if (!file) return;
  const reader = new FileReader();
  reader.onerror = () => setSettingsStatus("Could not read the settings file.", "error");
  reader.onload = () => {
    let parsed;
    try {
      parsed = JSON.parse(reader.result);
    } catch (e) {
      setSettingsStatus("Invalid settings file (not valid JSON).", "error");
      return;
    }
    if (applySettings(parsed)) {
      saveSettingsToLocalStorage();
      setSettingsStatus("Imported settings from " + file.name, "ok");
    } else {
      setSettingsStatus("Settings file could not be applied.", "error");
    }
  };
  reader.readAsText(file);
}

/** Reset all settings to the built-in defaults (and persist the reset). */
function resetToDefaults() {
  scaleValueInput.value = "4";
  for (const radio of scaleModeRadios) radio.checked = radio.value === "ppm";
  zeroModeSelect.value = "bed";
  originModeSelect.value = "center";
  blackInputEl.value = "3";
  whiteInputEl.value = "38";
  stockTopInputEl.value = "";
  safeZInputEl.value = "";
  seedDefaults();
  updateScalePanel();
  updateDepthPanel();
  renderToolTable();
  renderPassTable();
  runValidation();
  saveSettingsToLocalStorage();
  setSettingsStatus("Reset to defaults.", "ok");
}

settingsExportBtn.addEventListener("click", exportSettings);
settingsImportBtn.addEventListener("click", () => settingsImportInput.click());
settingsImportInput.addEventListener("change", (e) => {
  const file = e.target.files && e.target.files[0];
  importSettingsFromFile(file);
  settingsImportInput.value = ""; // allow re-importing the same file
});
settingsResetBtn.addEventListener("click", resetToDefaults);

// ----------------------------------------------------------------------------
// Startup: restore saved settings if present, otherwise seed built-in defaults.
// ----------------------------------------------------------------------------
const _restoredSettings = loadSettingsFromLocalStorage();
if (_restoredSettings && applySettings(_restoredSettings)) {
  setSettingsStatus("Restored saved settings from this browser.", "ok");
} else {
  seedDefaults();
  renderToolTable();
  renderPassTable();
  runValidation();
  // Probe whether localStorage is actually usable (it may be blocked at file://).
  let storageOk = false;
  try {
    const probe = SETTINGS_STORAGE_KEY + ".probe";
    localStorage.setItem(probe, "1");
    localStorage.removeItem(probe);
    storageOk = true;
  } catch (e) {
    storageOk = false;
  }
  setSettingsStatus(
    storageOk ? "Auto-save: on (this browser)." : "Auto-save unavailable here — use Export to save.",
    storageOk ? null : "error"
  );
}

// From here on, state changes auto-persist (runValidation calls
// saveSettingsToLocalStorage when settingsReady). Do one initial save so a
// fresh (seeded) config is remembered for next load.
settingsReady = true;
saveSettingsToLocalStorage();

// ============================================================================
// RESIZABLE SPLIT — draggable divider between .controls and .preview.
// Drives the split via the --controls-basis CSS custom property on
// .app-layout (a percentage of the row's content width). Persisted to
// localStorage under a separate key from the settings above, guarded the
// same way (silent no-op if storage is unavailable/corrupt). Only meaningful
// at >=900px (desktop row layout); harmless to apply below that since the
// media query ignores --controls-basis while stacked.
// ============================================================================

const SPLIT_STORAGE_KEY = "wbg.gcodeGenerator.split.v1";
const SPLIT_MIN_PX = 280;
const SPLIT_DEFAULT_PERCENT = 50;
const SPLIT_DESKTOP_QUERY = "(min-width: 900.02px)";

const appLayoutEl = document.querySelector(".app-layout");
const splitterEl = document.getElementById("app-splitter");
const controlsEl = document.querySelector(".controls");

/** Save the controls-column split (percent of row width) to localStorage.
 *  Silent no-op if storage is unavailable, matching the settings persistence
 *  pattern above. */
function saveSplitToLocalStorage(percent) {
  try {
    localStorage.setItem(SPLIT_STORAGE_KEY, JSON.stringify({ version: 1, controlsPercent: percent }));
  } catch (e) {
    /* storage blocked/unavailable — degrade to no persistence */
  }
}

/** Load the saved split percent from localStorage. Returns null if
 *  absent/unavailable/corrupt/out of range so the caller can fall back to
 *  the default. */
function loadSplitFromLocalStorage() {
  try {
    const raw = localStorage.getItem(SPLIT_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    const percent = parsed && Number(parsed.controlsPercent);
    if (!Number.isFinite(percent) || percent <= 0 || percent >= 100) return null;
    return percent;
  } catch (e) {
    return null;
  }
}

/** Apply a controls-column percent to the layout via the CSS custom
 *  property. No-ops cleanly if the layout root isn't present. */
function applySplitPercent(percent) {
  if (!appLayoutEl) return;
  appLayoutEl.style.setProperty("--controls-basis", percent + "%");
}

if (appLayoutEl && splitterEl && controlsEl) {
  const savedPercent = loadSplitFromLocalStorage();
  applySplitPercent(Number.isFinite(savedPercent) ? savedPercent : SPLIT_DEFAULT_PERCENT);

  let dragState = null; // { pointerId, containerLeft, containerWidth }

  const isDesktopLayout = () =>
    typeof window.matchMedia === "function" ? window.matchMedia(SPLIT_DESKTOP_QUERY).matches : true;

  function onSplitterPointerDown(e) {
    if (!isDesktopLayout()) return;
    const rect = appLayoutEl.getBoundingClientRect();
    dragState = { pointerId: e.pointerId, containerLeft: rect.left, containerWidth: rect.width };
    splitterEl.setPointerCapture(e.pointerId);
    splitterEl.classList.add("is-dragging");
    document.body.classList.add("is-resizing-split");
    e.preventDefault();
  }

  function onSplitterPointerMove(e) {
    if (!dragState || dragState.pointerId !== e.pointerId) return;
    const splitterWidth = splitterEl.getBoundingClientRect().width;
    const maxControlsPx = Math.max(SPLIT_MIN_PX, dragState.containerWidth - SPLIT_MIN_PX - splitterWidth);
    let controlsPx = e.clientX - dragState.containerLeft;
    controlsPx = Math.min(Math.max(controlsPx, SPLIT_MIN_PX), maxControlsPx);
    const percent = (controlsPx / dragState.containerWidth) * 100;
    applySplitPercent(percent);
  }

  function endSplitterDrag(e) {
    if (!dragState || dragState.pointerId !== e.pointerId) return;
    try {
      splitterEl.releasePointerCapture(e.pointerId);
    } catch (err) {
      /* pointer capture already released/lost — ignore */
    }
    dragState = null;
    splitterEl.classList.remove("is-dragging");
    document.body.classList.remove("is-resizing-split");
    // Persist the final percent read back from the live custom property.
    const raw = getComputedStyle(appLayoutEl).getPropertyValue("--controls-basis");
    const percent = parseFloat(raw);
    if (Number.isFinite(percent)) saveSplitToLocalStorage(percent);
  }

  // pointerdown starts the drag on the handle itself; move/up/cancel live on
  // `window` so the drag tracks the cursor and the release is always caught even
  // when the pointer leaves the 8px handle (relying on setPointerCapture alone
  // proved unreliable — the drag stalled off-handle and the release was missed,
  // leaving it "stuck"). The handlers guard on `dragState`, so these are no-ops
  // except during an active drag.
  splitterEl.addEventListener("pointerdown", onSplitterPointerDown);
  window.addEventListener("pointermove", onSplitterPointerMove);
  window.addEventListener("pointerup", endSplitterDrag);
  window.addEventListener("pointercancel", endSplitterDrag);
}

// ============================================================================
// PHASE 5 — SAFE-SURFACE ALGORITHM (pure, no DOM) + INLINE-BLOB WORKER
// See Design.md "Safe-Surface Algorithm (exact)" and "File-URL Architecture".
//
// Both computeSafeSurfaceReference and computeSafeSurface are self-contained
// pure functions (no references to any outer module-scope state) because
// their source text is serialized via .toString() into the worker Blob below
// — see buildWorkerSource(). They are also called directly here on the main
// thread by the window.__tests.safeSurface* tests (Node/console-testable
// without a Worker).
// ============================================================================

/**
 * Ground-truth O(N*r^2) safe-surface reference implementation, per Design.md
 * "Safe-Surface Algorithm (exact)": for each output pixel, take the max over
 * every (dx,dy) within radiusMm (in mm, via hypot*pixelSizeMm) of
 * terrain[x+dx,y+dy] - delta(dx,dy). Out-of-bounds and non-cut (-Infinity)
 * neighbors are skipped (they can never raise a max). `radiusMm <= 0` returns
 * a copy of terrain (point tool / no dilation).
 *
 * MUST remain fully self-contained: no closures over anything outside its own
 * parameters (it is serialized via .toString() into the worker).
 *
 * @param {Float32Array} terrain - row-major, index y*width+x, -Infinity = no material.
 * @param {number} width
 * @param {number} height
 * @param {number} pixelSizeMm
 * @param {number} radiusMm
 * @param {"flat"|"ball"} shape
 * @returns {Float32Array}
 */
function computeSafeSurfaceReference(terrain, width, height, pixelSizeMm, radiusMm, shape) {
  const n = width * height;
  const safe = new Float32Array(n);

  if (!(radiusMm > 0)) {
    safe.set(terrain);
    return safe;
  }

  const radiusPx = radiusMm / pixelSizeMm;
  const R = Math.ceil(radiusPx);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let best = -Infinity;
      for (let dy = -R; dy <= R; dy++) {
        const ny = y + dy;
        if (ny < 0 || ny >= height) continue;
        for (let dx = -R; dx <= R; dx++) {
          const nx = x + dx;
          if (nx < 0 || nx >= width) continue;
          const d = Math.hypot(dx, dy) * pixelSizeMm;
          if (d > radiusMm) continue;
          const t = terrain[ny * width + nx];
          if (t === -Infinity) continue;
          let delta = 0;
          if (shape === "ball") {
            delta = radiusMm - Math.sqrt(Math.max(0, radiusMm * radiusMm - d * d));
          }
          const val = t - delta;
          if (val > best) best = val;
        }
      }
      safe[y * width + x] = best;
    }
  }

  return safe;
}

/**
 * Faster O(N*r) row-decomposition safe-surface implementation, per Design.md
 * "Safe-Surface Algorithm (exact)" performance decomposition: for each `dy`
 * in [-R..R], compute a per-row horizontal contribution (a max-filter for
 * flat, or a 1-D grayscale dilation by the ball's delta(dx) profile), then
 * merge it into `safe` shifted by `dy` via elementwise max.
 *
 * Performance note (Phase 8 measurement + optimization — see Design.md "Main
 * Risk & Mitigation"): the outer loop is still O(r) iterations of `dy`, each
 * doing O(width) work per source row for the FLAT shape — true O(N*r)
 * overall — via a monotonic-deque sliding-window maximum (see the "flat"
 * branch below), replacing an earlier O(width*xRadius) naive per-row scan
 * that measured ~800ms at 600x600/r=12.7px in Node (see scratchpad perf
 * timings in the Phase 8 report). The BALL shape's per-row cost remains
 * O(width*xRadius) (an O(N*r^2) grayscale dilation is comparatively cheap in
 * practice — measured ~1.3s at 600x600 — and its 1-D structuring element
 * isn't a simple max, so it isn't a drop-in fit for a monotonic-deque
 * max-filter without extra work; left as-is per the spec's "unless trivially
 * improvable" guidance).
 *
 * MUST produce results identical to computeSafeSurfaceReference (verified by
 * window.__tests.safeSurfaceFastMatchesReference). The intermediate per-row
 * buffer is deliberately double precision (Float64Array), NOT Float32Array,
 * so this decomposition doesn't introduce an extra float32-rounding step that
 * the reference's plain-number accumulator doesn't have — only the final
 * `safe` output (like the reference) is stored as Float32Array. With that,
 * the two algorithms are bit-exact (maxDiff 0 in testing), not just within a
 * tolerance.
 *
 * MUST remain fully self-contained: no closures over anything outside its own
 * parameters (it is serialized via .toString() into the worker).
 *
 * @param {Float32Array} terrain - row-major, index y*width+x, -Infinity = no material.
 * @param {number} width
 * @param {number} height
 * @param {number} pixelSizeMm
 * @param {number} radiusMm
 * @param {"flat"|"ball"} shape
 * @param {(fraction:number)=>void} [onProgress] - optional, called periodically with 0..1.
 * @returns {Float32Array}
 */
function computeSafeSurface(terrain, width, height, pixelSizeMm, radiusMm, shape, onProgress) {
  const n = width * height;
  const safe = new Float32Array(n);

  if (!(radiusMm > 0)) {
    safe.set(terrain);
    if (onProgress) onProgress(1);
    return safe;
  }

  safe.fill(-Infinity);

  const radiusPx = radiusMm / pixelSizeMm;
  const R = Math.ceil(radiusPx);
  const radiusPxSq = radiusPx * radiusPx;

  // Scratch row buffer reused across dy iterations (double precision — see
  // the doc comment above for why this must not be a Float32Array).
  const rowContribution = new Float64Array(width);

  // Scratch deque (index buffer) reused across dy/srcY iterations for the
  // flat shape's monotonic sliding-window maximum (see the "flat" branch
  // below). Sized to the maximum possible window width; a plain Int32Array
  // used as a ring-free deque via head/tail indices (values only ever pushed
  // at the tail and popped from either end, and the window only grows by one
  // and shrinks by one per step, so a simple array with head/tail pointers
  // never needs to wrap).
  const dequeIdx = new Int32Array(width);

  for (let dy = -R; dy <= R; dy++) {
    const remainingSq = radiusPxSq - dy * dy;
    if (remainingSq < 0) {
      if (onProgress) onProgress((dy + R + 1) / (2 * R + 1));
      continue;
    }
    const xRadius = Math.floor(Math.sqrt(remainingSq));

    // Precompute the 1-D delta(dx) profile for the ball shape, dx in
    // [-xRadius..xRadius]; Infinity marks a dx excluded by the true radius
    // (the (dx,dy) box can include corners slightly outside the round
    // radius at this dy — checked exactly, like the reference's `d > radiusMm`).
    let deltaProfile = null;
    if (shape === "ball") {
      deltaProfile = new Float64Array(2 * xRadius + 1);
      for (let dx = -xRadius; dx <= xRadius; dx++) {
        const d = Math.hypot(dx, dy) * pixelSizeMm;
        if (d > radiusMm) {
          deltaProfile[dx + xRadius] = Infinity; // excluded
        } else {
          deltaProfile[dx + xRadius] = radiusMm - Math.sqrt(Math.max(0, radiusMm * radiusMm - d * d));
        }
      }
    }

    for (let srcY = 0; srcY < height; srcY++) {
      const dstY = srcY + dy;
      if (dstY < 0 || dstY >= height) continue;

      const srcRowStart = srcY * width;
      const dstRowStart = dstY * width;

      if (shape === "flat") {
        // Horizontal max-filter of window 2*xRadius+1 over terrain[srcY, :],
        // via a monotonic-deque sliding-window maximum: O(width) instead of
        // O(width*xRadius) for the naive per-row window scan. `dequeIdx`
        // holds source-column indices (into terrain, relative to
        // srcRowStart) with strictly decreasing terrain values from head to
        // tail, so the max of the current window is always at the head.
        // -Infinity values are pushed like any other value (they can never
        // be popped-as-larger and never win the max unless the whole window
        // is -Infinity, matching the reference's "skip -Infinity" behavior
        // by construction: -Infinity can only be the head/answer when no
        // finite value exists in the window, in which case the reference
        // would also report -Infinity).
        let dqHead = 0;
        let dqTail = 0; // half-open [dqHead, dqTail)
        let nextIn = 0; // next source column not yet pushed into the deque

        for (let x = 0; x < width; x++) {
          const loDx = Math.max(-xRadius, -x);
          const hiDx = Math.min(xRadius, width - 1 - x);
          const windowLo = x + loDx;
          const windowHi = x + hiDx;

          // Push every new column entering the window (windows only grow
          // monotonically in their right edge as x increases).
          while (nextIn <= windowHi) {
            const v = terrain[srcRowStart + nextIn];
            while (dqTail > dqHead && terrain[srcRowStart + dequeIdx[dqTail - 1]] <= v) {
              dqTail--;
            }
            dequeIdx[dqTail++] = nextIn;
            nextIn++;
          }

          // Pop any front entries that have fallen out of the window on the left.
          while (dqHead < dqTail && dequeIdx[dqHead] < windowLo) {
            dqHead++;
          }

          rowContribution[x] = dqHead < dqTail ? terrain[srcRowStart + dequeIdx[dqHead]] : -Infinity;
        }
      } else {
        // Ball: per-output-x max of terrain[x-dx] - delta(dx) — grayscale
        // dilation of the src row by the 1-D structuring element delta(dx).
        for (let x = 0; x < width; x++) {
          let best = -Infinity;
          const loDx = Math.max(-xRadius, -x);
          const hiDx = Math.min(xRadius, width - 1 - x);
          for (let dx = loDx; dx <= hiDx; dx++) {
            const delta = deltaProfile[dx + xRadius];
            if (delta === Infinity) continue;
            const t = terrain[srcRowStart + x + dx];
            if (t === -Infinity) continue;
            const val = t - delta;
            if (val > best) best = val;
          }
          rowContribution[x] = best;
        }
      }

      // Merge rowContribution into safe[dstY,:] via elementwise max.
      for (let x = 0; x < width; x++) {
        const val = rowContribution[x];
        if (val > safe[dstRowStart + x]) safe[dstRowStart + x] = val;
      }
    }

    if (onProgress) onProgress((dy + R + 1) / (2 * R + 1));
  }

  return safe;
}

// ============================================================================
// OUTLINE TOOLPATH — PURE GEOMETRY ENGINE (Phase: outline groove, stage 1).
//
// Given a keep-out mask (`cut===1` = part), produce concentric closed loops
// that a round tool's CENTER follows to cut a groove OUTSIDE the part, without
// ever letting the tool edge enter the part (no-gouge by construction).
//
// Pipeline: pad mask -> exact Euclidean distance transform (Felzenszwalb) ->
// pick concentric iso-levels (>= radius, biased outward) -> marching squares
// per level -> stitch segments into closed loops -> Douglas-Peucker simplify
// -> map padded-pixel coords back to original-image fractional pixel coords.
//
// All functions here are PURE and self-contained (no DOM, no module state):
// they are serialized into the worker via .toString() in stage 2, like
// computeSafeSurface.
// ----------------------------------------------------------------------------

/**
 * Exact 1-D squared distance transform of a sampled function (Felzenszwalb &
 * Huttenlocher 2012, "Distance Transforms of Sampled Functions"). Given f[q]
 * (0 for seed points, +Infinity elsewhere, or any lower-envelope samples),
 * returns d[q] = min over p of ((q-p)^2 + f[p]). O(n).
 * @param {Float64Array|number[]} f
 * @returns {Float64Array}
 */
function edt1d(f) {
  const n = f.length;
  const d = new Float64Array(n);
  if (n === 0) return d;
  const v = new Int32Array(n); // locations of parabolas in lower envelope
  const z = new Float64Array(n + 1); // boundaries between parabolas
  let k = -1; // no parabolas yet (all sources may be +Infinity)
  for (let q = 0; q < n; q++) {
    // A source at +Infinity can never be the nearest; skip it entirely. This
    // also avoids Infinity-Infinity=NaN in the intersection when two infinite
    // sources are compared.
    if (f[q] === Infinity) continue;
    if (k === -1) {
      k = 0;
      v[0] = q;
      z[0] = -Infinity;
      z[1] = Infinity;
      continue;
    }
    // Intersection of parabola from q with the current rightmost parabola.
    let s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    while (k > 0 && s <= z[k]) {
      k--;
      s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    }
    k++;
    v[k] = q;
    z[k] = s;
    z[k + 1] = Infinity;
  }
  if (k === -1) {
    // No finite source in this line: distance is +Infinity everywhere.
    for (let q = 0; q < n; q++) d[q] = Infinity;
    return d;
  }
  let j = 0;
  for (let q = 0; q < n; q++) {
    while (z[j + 1] < q) j++;
    const dq = q - v[j];
    d[q] = dq * dq + f[v[j]];
  }
  return d;
}

/**
 * Exact 2-D squared Euclidean distance transform. `mask[i]` (row-major,
 * y*width+x) is truthy (===1) for seed pixels. Returns Float64Array of squared
 * Euclidean distance (px^2) from each pixel to the nearest seed pixel. Runs
 * edt1d over rows then columns. If there are no seed pixels, every entry is
 * +Infinity.
 * @param {Uint8Array|number[]} mask
 * @param {number} width
 * @param {number} height
 * @returns {Float64Array}
 */
function edt2d(mask, width, height) {
  const n = width * height;
  const g = new Float64Array(n);
  for (let i = 0; i < n; i++) g[i] = mask[i] === 1 ? 0 : Infinity;

  // Pass 1: transform along rows (x).
  const rowBuf = new Float64Array(width);
  for (let y = 0; y < height; y++) {
    const base = y * width;
    for (let x = 0; x < width; x++) rowBuf[x] = g[base + x];
    const d = edt1d(rowBuf);
    for (let x = 0; x < width; x++) g[base + x] = d[x];
  }

  // Pass 2: transform along columns (y), using row results as f.
  const colBuf = new Float64Array(height);
  for (let x = 0; x < width; x++) {
    for (let y = 0; y < height; y++) colBuf[y] = g[y * width + x];
    const d = edt1d(colBuf);
    for (let y = 0; y < height; y++) g[y * width + x] = d[y];
  }
  return g;
}

/**
 * Marching squares on a scalar field. Extracts iso-contour line SEGMENTS at
 * `level` from `field` (row-major, size width*height). Corner is "inside" when
 * its value >= level. Edge crossings are linearly interpolated for sub-pixel
 * accuracy. Returns a flat array of segments [{x1,y1,x2,y2}, ...] in field
 * (pixel-grid) coordinates. Standard 16-case table; saddle cases (5 and 10)
 * resolved consistently (asymptotic decider not needed for our closed offset
 * curves — a fixed resolution keeps loops well-formed).
 * @param {Float64Array|number[]} field
 * @param {number} width
 * @param {number} height
 * @param {number} level
 * @returns {Array<{x1:number,y1:number,x2:number,y2:number}>}
 */
function marchingSquares(field, width, height, level) {
  const segs = [];
  // Linear interpolation of the crossing point along an edge between corners
  // a (value va, at position pa) and b (value vb, at position pb).
  const interp = function (pa, va, pb, vb) {
    const denom = vb - va;
    if (denom === 0) return pa;
    let t = (level - va) / denom;
    if (t < 0) t = 0;
    else if (t > 1) t = 1;
    return pa + t * (pb - pa);
  };

  for (let y = 0; y < height - 1; y++) {
    for (let x = 0; x < width - 1; x++) {
      // Corners: TL(x,y) TR(x+1,y) BR(x+1,y+1) BL(x,y+1).
      const tl = field[y * width + x];
      const tr = field[y * width + (x + 1)];
      const br = field[(y + 1) * width + (x + 1)];
      const bl = field[(y + 1) * width + x];

      let code = 0;
      if (tl >= level) code |= 8;
      if (tr >= level) code |= 4;
      if (br >= level) code |= 2;
      if (bl >= level) code |= 1;
      if (code === 0 || code === 15) continue;

      // Edge crossing midpoints (interpolated):
      //   top    : between TL and TR
      //   right  : between TR and BR
      //   bottom : between BL and BR
      //   left   : between TL and BL
      const top = { x: interp(x, tl, x + 1, tr), y: y };
      const right = { x: x + 1, y: interp(y, tr, y + 1, br) };
      const bottom = { x: interp(x, bl, x + 1, br), y: y + 1 };
      const left = { x: x, y: interp(y, tl, y + 1, bl) };

      const push = function (a, b) {
        segs.push({ x1: a.x, y1: a.y, x2: b.x, y2: b.y });
      };

      switch (code) {
        case 1: push(left, bottom); break;
        case 2: push(bottom, right); break;
        case 3: push(left, right); break;
        case 4: push(top, right); break;
        case 5: // saddle: TL & BR inside — resolve as two segments.
          push(left, top);
          push(bottom, right);
          break;
        case 6: push(top, bottom); break;
        case 7: push(left, top); break;
        case 8: push(top, left); break;
        case 9: push(top, bottom); break;
        case 10: // saddle: TR & BL inside.
          push(top, right);
          push(left, bottom);
          break;
        case 11: push(top, right); break;
        case 12: push(right, left); break;
        case 13: push(bottom, right); break;
        case 14: push(left, bottom); break;
        default: break;
      }
    }
  }
  return segs;
}

/**
 * Stitch a bag of line segments into closed polylines. Segments sharing an
 * endpoint (within `eps` px) are joined; each resulting polyline is closed
 * (first point == last point appended). Handles multiple disjoint loops (holes
 * / disconnected regions) — returns one polyline per loop.
 * @param {Array<{x1:number,y1:number,x2:number,y2:number}>} segs
 * @param {number} [eps]
 * @returns {Array<Array<{px:number,py:number}>>}
 */
function assembleLoops(segs, eps) {
  const e = eps === undefined ? 1e-6 : eps;
  // Quantize endpoints to a grid of size `e` so shared points hash together.
  const inv = 1 / e;
  const key = function (x, y) {
    return Math.round(x * inv) + "," + Math.round(y * inv);
  };

  // Build adjacency: map endpoint-key -> list of {seg index, which end}.
  const nodes = new Map();
  const used = new Uint8Array(segs.length);
  const addNode = function (k, segIdx, end) {
    let arr = nodes.get(k);
    if (!arr) { arr = []; nodes.set(k, arr); }
    arr.push({ segIdx, end });
  };
  for (let i = 0; i < segs.length; i++) {
    addNode(key(segs[i].x1, segs[i].y1), i, 0);
    addNode(key(segs[i].x2, segs[i].y2), i, 1);
  }

  const loops = [];
  for (let start = 0; start < segs.length; start++) {
    if (used[start]) continue;
    // Walk a chain starting from this segment.
    const poly = [];
    let curIdx = start;
    let cx = segs[start].x1, cy = segs[start].y1;
    poly.push({ px: cx, py: cy });
    // Advance to the other end.
    let ex = segs[start].x2, ey = segs[start].y2;
    used[start] = 1;
    poly.push({ px: ex, py: ey });
    let guard = 0;
    const maxGuard = segs.length + 5;
    while (guard++ < maxGuard) {
      const k = key(ex, ey);
      const arr = nodes.get(k);
      if (!arr) break;
      let nextIdx = -1, nextEnd = -1;
      for (let j = 0; j < arr.length; j++) {
        const cand = arr[j];
        if (used[cand.segIdx]) continue;
        nextIdx = cand.segIdx;
        nextEnd = cand.end;
        break;
      }
      if (nextIdx === -1) break;
      used[nextIdx] = 1;
      const seg = segs[nextIdx];
      // Move to the far end of the chosen segment.
      if (nextEnd === 0) { ex = seg.x2; ey = seg.y2; }
      else { ex = seg.x1; ey = seg.y1; }
      poly.push({ px: ex, py: ey });
      curIdx = nextIdx;
    }
    // Ensure closed: append first point if not already coincident.
    const first = poly[0];
    const last = poly[poly.length - 1];
    // Defense-in-depth: a well-formed marching-squares contour closes with a
    // final segment ~1px long, so the walk's start and end are adjacent. A
    // large gap means the chain is open/broken (e.g. a saddle mis-stitch, or a
    // contour clipped at the array edge). Force-closing it would append a long
    // chord straight across the keep-out region — exactly the gouge the outline
    // pass must never emit. Drop such a chain instead of cutting through it.
    const closeGap = Math.hypot(first.px - last.px, first.py - last.py);
    if (closeGap > 2.0) continue;
    if (Math.abs(first.px - last.px) > e || Math.abs(first.py - last.py) > e) {
      poly.push({ px: first.px, py: first.py });
    }
    if (poly.length >= 4) loops.push(poly);
  }
  return loops;
}

/**
 * Douglas-Peucker polyline simplification ("lines only") for a CLOSED loop.
 * Keeps endpoints; reduces marching-squares staircase to clean segments within
 * `tol` px. Input/output loops are closed (first point == last point). Returns
 * a closed loop with >= 4 points where possible.
 * @param {Array<{px:number,py:number}>} pts - closed loop (first ~= last).
 * @param {number} tol
 * @returns {Array<{px:number,py:number}>}
 */
function douglasPeucker(pts, tol) {
  if (pts.length <= 2) return pts.slice();
  const closed = Math.abs(pts[0].px - pts[pts.length - 1].px) < 1e-9 &&
    Math.abs(pts[0].py - pts[pts.length - 1].py) < 1e-9;

  const perpDistSq = function (p, a, b) {
    const dx = b.px - a.px, dy = b.py - a.py;
    const len2 = dx * dx + dy * dy;
    if (len2 === 0) {
      const ex = p.px - a.px, ey = p.py - a.py;
      return ex * ex + ey * ey;
    }
    const t = ((p.px - a.px) * dx + (p.py - a.py) * dy) / len2;
    const projx = a.px + t * dx, projy = a.py + t * dy;
    const ex = p.px - projx, ey = p.py - projy;
    return ex * ex + ey * ey;
  };

  const tol2 = tol * tol;
  const simplifyRange = function (arr, first, last, out) {
    let maxD = -1, idx = -1;
    for (let i = first + 1; i < last; i++) {
      const d = perpDistSq(arr[i], arr[first], arr[last]);
      if (d > maxD) { maxD = d; idx = i; }
    }
    if (maxD > tol2 && idx !== -1) {
      simplifyRange(arr, first, idx, out);
      out.push(arr[idx]);
      simplifyRange(arr, idx, last, out);
    }
  };

  if (closed) {
    // For a closed ring, split into two halves so DP doesn't collapse the loop
    // (endpoints are identical). Anchor on point 0 and the farthest point.
    const ring = pts.slice(0, pts.length - 1); // drop duplicate closing point
    if (ring.length <= 3) {
      const r = ring.slice();
      r.push({ px: r[0].px, py: r[0].py });
      return r;
    }
    let farI = 0, farD = -1;
    for (let i = 1; i < ring.length; i++) {
      const dx = ring[i].px - ring[0].px, dy = ring[i].py - ring[0].py;
      const d = dx * dx + dy * dy;
      if (d > farD) { farD = d; farI = i; }
    }
    const half1 = ring.slice(0, farI + 1);
    const half2 = ring.slice(farI).concat([ring[0]]);
    const out1 = [half1[0]];
    simplifyRange(half1, 0, half1.length - 1, out1);
    out1.push(half1[half1.length - 1]);
    const out2 = [half2[0]];
    simplifyRange(half2, 0, half2.length - 1, out2);
    out2.push(half2[half2.length - 1]);
    // out1 ends at ring[farI] which == out2[0]; out2 ends at ring[0].
    const merged = out1.concat(out2.slice(1));
    // merged last point == ring[0] == merged[0] -> already closed.
    if (Math.abs(merged[0].px - merged[merged.length - 1].px) > 1e-9 ||
      Math.abs(merged[0].py - merged[merged.length - 1].py) > 1e-9) {
      merged.push({ px: merged[0].px, py: merged[0].py });
    }
    return merged;
  }

  const out = [pts[0]];
  simplifyRange(pts, 0, pts.length - 1, out);
  out.push(pts[pts.length - 1]);
  return out;
}

/**
 * PURE geometry engine for the outline groove toolpath. Returns concentric
 * closed loops (round-tool CENTER paths) that cut a groove OUTSIDE the part
 * without the tool edge ever entering the part.
 *
 * MUST remain fully self-contained (serialized via .toString() into the worker
 * in stage 2). No DOM, no module-scope state.
 *
 * @param {Uint8Array|number[]} cut - keep-out mask, row-major y*width+x, 1 = part.
 * @param {number} width
 * @param {number} height
 * @param {number} pixelSizeMm
 * @param {number} toolRadiusMm
 * @param {number} grooveWidthMm - radial width of cleared band (outside part).
 * @param {number} stepoverMm - radial spacing between concentric loops.
 * @returns {{loops:Array<Array<{px:number,py:number}>>, levelsPx:number[], loopCount:number}}
 */
function computeOutlineLoops(cut, width, height, pixelSizeMm, toolRadiusMm, grooveWidthMm, stepoverMm) {
  // Edge case: nothing to outline.
  let anyCut = false;
  for (let i = 0; i < width * height; i++) { if (cut[i] === 1) { anyCut = true; break; } }
  if (!anyCut) return { loops: [], levelsPx: [], loopCount: 0, truncated: false };

  const radiusPx = toolRadiusMm / pixelSizeMm;
  const grooveWidthPx = grooveWidthMm / pixelSizeMm;
  const stepoverPx = stepoverMm / pixelSizeMm;

  // Concentric loop levels (outward bias so we never gouge). Computed BEFORE
  // padding so the pad can be sized to fully enclose the OUTERMOST loop level.
  // If padding is smaller than the outer level, that contour runs off the
  // padded-array edge, opens, and assembleLoops closes it with a huge chord
  // straight across the part (a gouge). See levels detail at step 3 below.
  // Douglas-Peucker tolerance (also used below). The outward bias MUST cover
  // it: DP can chord a smoothed loop inward by up to simplifyTolPx, so unless
  // bias >= tol the innermost loop's straight segments can dip inside the tool
  // radius and nick the part. bias = safety margin + tol keeps a real border.
  const simplifyTolPx = Math.max(0.25, 0.2 / pixelSizeMm);
  const biasPx = Math.max(0.5, 0.05 / pixelSizeMm) + simplifyTolPx;
  const levelsPx = [];
  const MAX_LOOPS = 5000;
  for (let k = 0; k < MAX_LOOPS; k++) {
    const level = radiusPx + biasPx + k * stepoverPx;
    levelsPx.push(level);
    // Stop when the last loop's inner edge has reached grooveWidthPx.
    if (!((level - radiusPx) - biasPx < grooveWidthPx)) break;
    if (!(stepoverPx > 0)) break; // guard: degenerate stepover -> single loop
  }
  // We hit the loop cap (rather than reaching the requested groove width) if
  // we stopped at MAX_LOOPS with the last level's inner edge still inside the
  // groove — the emitted groove would be narrower than requested.
  const outlineTruncated = levelsPx.length >= MAX_LOOPS &&
    ((levelsPx[levelsPx.length - 1] - radiusPx) - biasPx < grooveWidthPx);
  const maxLevelPx = levelsPx[levelsPx.length - 1];

  // 1. Pad the mask so the part is fully surrounded by "outside" out to at
  // least the outermost loop level, plus a few cells so marching squares can
  // close the outer contour cleanly instead of clipping it at the array edge.
  const P = Math.ceil(maxLevelPx) + 4;
  const pw = width + 2 * P;
  const ph = height + 2 * P;
  const paddedCut = new Uint8Array(pw * ph); // zero-filled = outside
  for (let y = 0; y < height; y++) {
    const src = y * width;
    const dst = (y + P) * pw + P;
    for (let x = 0; x < width; x++) paddedCut[dst + x] = cut[src + x];
  }

  // 2. Exact Euclidean distance transform -> distPx scalar field.
  const distSq = edt2d(paddedCut, pw, ph);
  const distPx = new Float64Array(pw * ph);
  for (let i = 0; i < distPx.length; i++) distPx[i] = Math.sqrt(distSq[i]);

  // 3. Concentric loop levels + simplifyTolPx were computed above (before
  // padding) so the pad could be sized to enclose maxLevelPx and the bias
  // could cover the DP tolerance; reuse them here.

  // 4-6. Per level: marching squares -> assemble loops -> simplify.
  const loops = [];
  for (let li = 0; li < levelsPx.length; li++) {
    const level = levelsPx[li];
    const segs = marchingSquares(distPx, pw, ph, level);
    const levelLoops = assembleLoops(segs, 1e-6);
    for (let j = 0; j < levelLoops.length; j++) {
      const simplified = douglasPeucker(levelLoops[j], simplifyTolPx);
      // 7. Convert padded-pixel coords -> original-image fractional coords.
      const converted = new Array(simplified.length);
      for (let p = 0; p < simplified.length; p++) {
        converted[p] = { px: simplified[p].px - P, py: simplified[p].py - P };
      }
      loops.push(converted);
    }
  }

  return { loops, levelsPx, loopCount: loops.length, truncated: outlineTruncated };
}

/**
 * Generate GCode for one "outline" pass: a groove cut OUTSIDE the part
 * (cut===1 region), never into it, using concentric loops from
 * computeOutlineLoops. Self-contained (no DOM) so it can be serialized into
 * the worker via .toString(). Mirrors generatePassGCode's header/preamble/
 * footer + modal-word + streaming conventions exactly, but with loop moves
 * (no raster rows, no remaining-material tracking — outline passes are
 * independent grooves).
 *
 * @param {object} params
 * @param {object} params.pass - PassSpec (uses name, outlineWidthMm, outlineDepthMm).
 * @param {object} params.tool - ToolSpec (uses name, radiusMm, stepoverMm, maxStepdownMm, feedMmMin, plungeMmMin, spindleRpm).
 * @param {Uint8Array} params.cut - HeightMap.cut, row-major, length width*height.
 * @param {number} params.width
 * @param {number} params.height
 * @param {object} params.jobSpec - JobSpec (uses imageName, pixelSizeMm, zeroMode, originMode, stockTopMm, safeZMm).
 * @param {string} [params.imageBase]
 * @param {number} params.passIndex - 1-based index among enabled passes.
 * @param {(chunk:string)=>void} [params.onChunk] - if set, emits GCode chunks and returns `gcode:null`.
 * @param {number} [params.chunkLimitChars]
 * @returns {{filename:string, gcode:string|null, zMin:number, zMax:number, sweeps:number, hitCap:boolean, lineCount:number, byteCount:number}}
 */
/**
 * Shared GCode line-stream buffer used by both pass generators. In streaming
 * mode (onChunk set) it batches lines and flushes ~chunkLimitChars at a time;
 * otherwise it accumulates them in `lines`. Tracks lineCount/byteCount. Kept
 * self-contained (no DOM / module-scope refs) so it serializes into the worker.
 * @param {((chunk:string)=>void)|null|undefined} onChunk
 * @param {number} [chunkLimitChars]
 */
function createGcodeStream(onChunk, chunkLimitChars) {
  const stream = typeof onChunk === "function";
  const limit = Math.max(1024, chunkLimitChars || 1024 * 1024);
  const lines = stream ? null : [];
  const chunkLines = [];
  let chunkChars = 0;
  const gs = {
    streamOutput: stream,
    lines: lines,
    lineCount: 0,
    byteCount: 0,
  };
  gs.emitLine = function (line) {
    const text = String(line);
    gs.lineCount += 1;
    gs.byteCount += text.length + 1; // GCode is ASCII; include trailing newline.
    if (!stream) {
      lines.push(text);
      return;
    }
    chunkLines.push(text);
    chunkChars += text.length + 1;
    if (chunkChars >= limit) gs.flushChunk();
  };
  gs.flushChunk = function () {
    if (!stream || chunkLines.length === 0) return;
    onChunk(chunkLines.join("\n") + "\n");
    chunkLines.length = 0;
    chunkChars = 0;
  };
  return gs;
}

/**
 * Build one GCode motion line ("G0"/"G1" + only the changed X/Y/Z/F words),
 * applying modal-word omission: a word is emitted only when its formatted value
 * differs from `modal`, which is mutated in place with the new formatted values.
 * Returns the line string, or null when every word was unchanged (a no-op move
 * the caller should not emit). Shared by the raster and outline emitters so the
 * omission/format rules live in exactly one place. Self-contained (only
 * formatCoord/formatFeed, both worker-serialized) so it serializes too.
 * @param {string} code - "G0" or "G1"
 * @param {{x?:number,y?:number,z?:number,f?:number}} words
 * @param {{x:?string,y:?string,z:?string,f:?string}} modal - mutated in place
 * @returns {string|null}
 */
function buildMotionLine(code, words, modal) {
  const parts = [code];
  if (Object.prototype.hasOwnProperty.call(words, "x")) {
    const x = formatCoord(words.x);
    if (x !== modal.x) { parts.push(`X${x}`); modal.x = x; }
  }
  if (Object.prototype.hasOwnProperty.call(words, "y")) {
    const y = formatCoord(words.y);
    if (y !== modal.y) { parts.push(`Y${y}`); modal.y = y; }
  }
  if (Object.prototype.hasOwnProperty.call(words, "z")) {
    const z = formatCoord(words.z);
    if (z !== modal.z) { parts.push(`Z${z}`); modal.z = z; }
  }
  if (Object.prototype.hasOwnProperty.call(words, "f")) {
    const f = formatFeed(words.f);
    if (f !== modal.f) { parts.push(`F${f}`); modal.f = f; }
  }
  return parts.length > 1 ? parts.join(" ") : null;
}

function generateOutlinePassGCode(params) {
  const { pass, tool, cut, width, height, jobSpec, passIndex } = params;
  const framing = params.framing || "full";
  const bodyOnly = framing === "body";
  const pixelSizeMm = jobSpec.pixelSizeMm;
  const originMode = jobSpec.originMode;
  const safeZMm = jobSpec.safeZMm;

  const loopsResult = computeOutlineLoops(
    cut, width, height, pixelSizeMm, tool.radiusMm, pass.outlineWidthMm,
    (pass.stepoverMm != null ? pass.stepoverMm : tool.stepoverMm)
  );
  const loops = loopsResult.loops;
  const outlineHitCap = !!loopsResult.truncated;

  // Depth levels: from stockTopMm DOWN to floorZ, stepping by maxStepdownMm
  // (pass override takes precedence over the tool default).
  const floorZ = pass.outlineDepthMm;
  const maxStepdown = (pass.maxStepdownMm != null ? pass.maxStepdownMm : tool.maxStepdownMm);
  const levels = [];
  if (jobSpec.stockTopMm <= floorZ) {
    levels.push(floorZ);
  } else {
    let z = jobSpec.stockTopMm;
    while (z > floorZ) {
      const next = Math.max(floorZ, z - maxStepdown);
      if (next >= z) break; // non-positive stepdown: stop instead of looping forever
      z = next;
      levels.push(z);
    }
    if (levels.length === 0 || levels[levels.length - 1] !== floorZ) levels.push(floorZ);
  }

  const sanitizedToolName = sanitizeToolName(tool.name);
  const imageBase = params.imageBase != null
    ? params.imageBase
    : ((typeof currentImageBaseName !== "undefined" && currentImageBaseName)
        ? currentImageBaseName
        : baseNameWithoutExtension(jobSpec.imageName || "job"));
  const filename = `${imageBase}_${passIndex}_${sanitizedToolName}.nc`;

  const physW = width * pixelSizeMm;
  const physH = height * pixelSizeMm;
  const preamble = ["G90", "G21", "G17", `M3 S${formatFeed(tool.spindleRpm)}`];
  const footer = [`G0 Z${formatCoord(safeZMm)}`, "M5", "M2"];

  const gcodeStream = createGcodeStream(params.onChunk, params.chunkLimitChars);
  const streamOutput = gcodeStream.streamOutput;
  const lines = gcodeStream.lines;
  const emitLine = gcodeStream.emitLine;
  const flushChunk = gcodeStream.flushChunk;

  let atSafeZ = true; // start of pass: assume already clear
  const modal = { x: null, y: null, z: null, f: null };
  let zMin = Infinity;
  let zMax = -Infinity;

  function emitMotionLine(code, words) {
    const line = buildMotionLine(code, words, modal);
    if (line !== null) emitLine(line);
  }

  function ensureSafeZ() {
    if (!atSafeZ) {
      emitMotionLine("G0", { z: safeZMm });
      atSafeZ = true;
    }
  }

  const headerLines = [
    `; image: ${jobSpec.imageName}`,
    `; dimensions: ${width}x${height} px`,
    `; pixelSizeMm: ${pixelSizeMm}  physical size: ${physW.toFixed(3)} x ${physH.toFixed(3)} mm`,
    `; zeroMode: ${jobSpec.zeroMode}`,
    `; originMode: ${jobSpec.originMode}`,
    `; stockTopMm: ${jobSpec.stockTopMm}`,
    `; safeZMm: ${jobSpec.safeZMm}`,
    `; tool: ${tool.name}  shape: ${tool.shape}  diameterMm: ${tool.diameterMm}`,
    `; pass: ${pass.name}  direction: outline  outlineWidthMm: ${pass.outlineWidthMm}  outlineDepthMm: ${pass.outlineDepthMm}`,
    `; spindleRpm: ${tool.spindleRpm}`,
    `; loopCount: ${loops.length}  depthLevels: ${levels.length}`,
  ];

  if (bodyOnly) {
    emitLine(`; --- pass ${passIndex}: ${pass.name} (${tool.name}) ---`);
  } else if (streamOutput) {
    headerLines.concat(preamble).forEach(emitLine);
  }

  for (let li = 0; li < levels.length; li++) {
    const z = levels[li];
    for (let lo = 0; lo < loops.length; lo++) {
      const loop = loops[lo];
      if (loop.length < 2) continue;

      const first = pixelCenterToMachineXY(loop[0].px, loop[0].py, pixelSizeMm, width, height, originMode);

      ensureSafeZ();
      emitMotionLine("G0", { x: first.x, y: first.y });
      emitMotionLine("G1", { z: z, f: tool.plungeMmMin });
      atSafeZ = false;
      if (z < zMin) zMin = z;
      if (z > zMax) zMax = z;

      for (let p = 1; p < loop.length; p++) {
        const pt = pixelCenterToMachineXY(loop[p].px, loop[p].py, pixelSizeMm, width, height, originMode);
        emitMotionLine("G1", { x: pt.x, y: pt.y, f: tool.feedMmMin });
      }
      // Close back to the first vertex.
      emitMotionLine("G1", { x: first.x, y: first.y, f: tool.feedMmMin });

      emitMotionLine("G0", { z: safeZMm });
      atSafeZ = true;
    }
  }

  if (!Number.isFinite(zMin)) zMin = safeZMm;
  if (!Number.isFinite(zMax)) zMax = safeZMm;

  if (bodyOnly) {
    emitLine(`G0 Z${formatCoord(safeZMm)}`);
    flushChunk();
    if (streamOutput) {
      return { filename, gcode: null, zMin, zMax, sweeps: levels.length, hitCap: outlineHitCap, lineCount: gcodeStream.lineCount, byteCount: gcodeStream.byteCount };
}
    const gcode = lines.join("\n") + "\n";
    return { filename, gcode, zMin, zMax, sweeps: levels.length, hitCap: outlineHitCap, lineCount: lines.length, byteCount: gcode.length };
  }

  if (streamOutput) {
    [
      `; streamed summary: commanded Z range ${zMin.toFixed(2)} to ${zMax.toFixed(2)} mm`,
      `; streamed summary: depth levels ${levels.length}`,
    ].forEach(emitLine);
    footer.forEach(emitLine);
    flushChunk();
    return { filename, gcode: null, zMin, zMax, sweeps: levels.length, hitCap: outlineHitCap, lineCount: gcodeStream.lineCount, byteCount: gcodeStream.byteCount };
  }

  const header = headerLines.concat([
    `; commanded Z range: ${zMin.toFixed(2)} to ${zMax.toFixed(2)} mm`,
    `; depth levels: ${levels.length}`,
  ]);

  const allLines = header.concat(preamble, lines, footer);
  const gcode = allLines.join("\n") + "\n";

  return { filename, gcode, zMin, zMax, sweeps: levels.length, hitCap: outlineHitCap, lineCount: allLines.length, byteCount: gcode.length };
}

// ----------------------------------------------------------------------------
// Inline-Blob Web Worker — hosts heavy compute (safe-surface now; Phase 6/7
// will add raster generation + remaining-material commands to the same
// dispatch switch). Per Design.md "File-URL Architecture", the worker MUST be
// built from an inline Blob (new Worker('worker.js') is blocked under
// file://). We avoid duplicating the compute code by serializing the pure
// functions above via .toString() directly into the worker source string.
// ----------------------------------------------------------------------------

/**
 * Build the worker source text by serializing the pure compute functions
 * (via .toString()) into a template string, then appending the worker's
 * onmessage dispatcher. Keeping this as a function (rather than a top-level
 * constant) means it re-reads the current function bodies if this file is
 * ever hot-reloaded, and keeps the string-building logic in one place for
 * Phase 6/7 to extend (add more serialized functions + more `cmd` cases).
 * @returns {string}
 */
function buildWorkerSource() {
  return [
    "'use strict';",
    "var MAX_SWEEPS_PER_PASS = " + MAX_SWEEPS_PER_PASS + ";",
    "var REMAINING_TARGET_TOL = " + REMAINING_TARGET_TOL + ";",
    "var STAMP_EPS_MM = " + STAMP_EPS_MM + ";",
    computeSafeSurfaceReference.toString(),
    computeSafeSurface.toString(),
    computePassTargetSurface.toString(),
    initRemaining.toString(),
    stampToolFootprint.toString(),
    findRowSpans.toString(),
    pixelCenterToMachineXY.toString(),
    formatCoord.toString(),
    formatFeed.toString(),
    sanitizeToolName.toString(),
    baseNameWithoutExtension.toString(),
    createGcodeStream.toString(),
    buildMotionLine.toString(),
    emitRasterSweepMoves.toString(),
    generatePassGCode.toString(),
    edt1d.toString(),
    edt2d.toString(),
    marchingSquares.toString(),
    assembleLoops.toString(),
    douglasPeucker.toString(),
    computeOutlineLoops.toString(),
    generateOutlinePassGCode.toString(),
    `
self.onmessage = function (e) {
  var m = e.data;
  try {
    if (m.cmd === 'safeSurface') {
      var safe = computeSafeSurface(
        m.terrain, m.width, m.height, m.pixelSizeMm, m.radiusMm, m.shape,
        function (frac) {
          self.postMessage({ type: 'progress', reqId: m.reqId, fraction: frac });
        }
      );
      self.postMessage({ type: 'result', reqId: m.reqId, safe: safe }, [safe.buffer]);
    } else if (m.cmd === 'safeSurfaceReference') {
      // Not used by the app UI; exposed for potential future debugging/tests
      // that want the ground-truth path run off the main thread too.
      var safeRef = computeSafeSurfaceReference(
        m.terrain, m.width, m.height, m.pixelSizeMm, m.radiusMm, m.shape
      );
      self.postMessage({ type: 'result', reqId: m.reqId, safe: safeRef }, [safeRef.buffer]);
    } else if (m.cmd === 'generateJob' && !m.singleFile) {
      var heightMap = { width: m.width, height: m.height, cut: m.cut };
      var remaining = initRemaining(heightMap, m.stockTopMm);
      var results = [];
      for (var i = 0; i < m.passes.length; i++) {
        var p = m.passes[i]; // { pass, tool, passIndex }
        if (p.pass.direction === 'outline') {
          var outFilename = m.imageBase + '_' + p.passIndex + '_' + sanitizeToolName(p.tool.name) + '.nc';
          self.postMessage({ type: 'progress', reqId: m.reqId, phase: 'toolpath',
            passIndex: p.passIndex, passCount: m.passes.length, passName: p.pass.name });
          self.postMessage({ type: 'gcodeStart', reqId: m.reqId, passIndex: p.passIndex, filename: outFilename });
          var outRes = generateOutlinePassGCode({ pass: p.pass, tool: p.tool, cut: m.cut, width: m.width, height: m.height,
            jobSpec: m.jobSpec, passIndex: p.passIndex, imageBase: m.imageBase,
            chunkLimitChars: m.chunkLimitChars,
            onChunk: (function (pp, fn) { return function (chunk) {
              self.postMessage({ type: 'gcodeChunk', reqId: m.reqId, passIndex: pp.passIndex, filename: fn, chunk: chunk });
            }; })(p, outFilename)
          });
          var outSummary = { passIndex: p.passIndex, filename: outRes.filename, zMin: outRes.zMin, zMax: outRes.zMax,
            sweeps: outRes.sweeps, hitCap: outRes.hitCap, lineCount: outRes.lineCount, byteCount: outRes.byteCount };
          results.push(outSummary);
          self.postMessage({ type: 'gcodeEnd', reqId: m.reqId, summary: outSummary });
          continue;
        }
        self.postMessage({ type: 'progress', reqId: m.reqId, phase: 'safeSurface',
          passIndex: p.passIndex, passCount: m.passes.length, passName: p.pass.name, toolName: p.tool.name, fraction: 0 });
        var safe2 = computeSafeSurface(m.terrain, m.width, m.height, m.pixelSizeMm, p.tool.radiusMm, p.tool.shape,
          (function (pp) { return function (frac) {
            self.postMessage({ type: 'progress', reqId: m.reqId, phase: 'safeSurface',
              passIndex: pp.passIndex, passCount: m.passes.length, passName: pp.pass.name, fraction: frac });
          }; })(p));
        var target = computePassTargetSurface(safe2, p.pass.allowanceMm, m.stockTopMm);
        self.postMessage({ type: 'progress', reqId: m.reqId, phase: 'toolpath',
          passIndex: p.passIndex, passCount: m.passes.length, passName: p.pass.name });
        var filename = m.imageBase + '_' + p.passIndex + '_' + sanitizeToolName(p.tool.name) + '.nc';
        self.postMessage({ type: 'gcodeStart', reqId: m.reqId, passIndex: p.passIndex, filename: filename });
        var res = generatePassGCode({ pass: p.pass, tool: p.tool, targetSurface: target,
          remaining: remaining, jobSpec: m.jobSpec, heightMap: heightMap, passIndex: p.passIndex, imageBase: m.imageBase,
          chunkLimitChars: m.chunkLimitChars,
          onChunk: (function (pp, fn) { return function (chunk) {
            self.postMessage({ type: 'gcodeChunk', reqId: m.reqId, passIndex: pp.passIndex, filename: fn, chunk: chunk });
          }; })(p, filename)
        });
        var summary = { passIndex: p.passIndex, filename: res.filename, zMin: res.zMin, zMax: res.zMax,
          sweeps: res.sweeps, hitCap: res.hitCap, lineCount: res.lineCount, byteCount: res.byteCount };
        results.push(summary);
        self.postMessage({ type: 'gcodeEnd', reqId: m.reqId, summary: summary });
      }
      self.postMessage({ type: 'result', reqId: m.reqId, results: results });
    } else if (m.cmd === 'generateJob' && m.singleFile) {
      var heightMapC = { width: m.width, height: m.height, cut: m.cut };
      var remainingC = initRemaining(heightMapC, m.stockTopMm);
      var combinedFilename = m.imageBase + '_combined.nc';
      var combinedLineCount = 0;
      var combinedByteCount = 0;
      var combinedZMin = Infinity;
      var combinedZMax = -Infinity;
      var combinedSweeps = 0;
      var combinedHitCap = false;

      function emitCombined(chunk) {
        combinedByteCount += chunk.length;
        self.postMessage({ type: 'gcodeChunk', reqId: m.reqId, passIndex: 0, filename: combinedFilename, chunk: chunk });
      }
      function emitCombinedLine(line) {
        var text = String(line);
        combinedLineCount += 1;
        emitCombined(text + '\\n');
      }

      self.postMessage({ type: 'gcodeStart', reqId: m.reqId, passIndex: 0, filename: combinedFilename });

      var passNamesDesc = m.passes.map(function (pp) { return pp.pass.name + '(' + pp.tool.name + ')'; }).join(', ');
      [
        '; combined GCode: ' + m.passes.length + ' pass(es) with tool changes',
        '; image: ' + m.jobSpec.imageName,
        '; dimensions: ' + m.width + 'x' + m.height + ' px',
        '; pixelSizeMm: ' + m.jobSpec.pixelSizeMm,
        '; zeroMode: ' + m.jobSpec.zeroMode,
        '; originMode: ' + m.jobSpec.originMode,
        '; stockTopMm: ' + m.jobSpec.stockTopMm,
        '; safeZMm: ' + m.jobSpec.safeZMm,
        '; passes: ' + passNamesDesc,
      ].forEach(emitCombinedLine);
      ['G90', 'G21', 'G17'].forEach(emitCombinedLine);

      var prevToolId = null;
      for (var ci = 0; ci < m.passes.length; ci++) {
        var cp = m.passes[ci]; // { pass, tool, passIndex, toolNumber }
        self.postMessage({ type: 'progress', reqId: m.reqId, phase: 'toolpath',
          passIndex: cp.passIndex, passCount: m.passes.length, passName: cp.pass.name });

        if (ci === 0) {
          emitCombinedLine('G0 Z' + formatCoord(m.jobSpec.safeZMm));
          emitCombinedLine('M6 T' + cp.toolNumber + ' (tool: ' + cp.tool.name + ' Ø' + cp.tool.diameterMm + 'mm)');
          emitCombinedLine('M3 S' + formatFeed(cp.tool.spindleRpm));
        } else if (cp.pass.toolId !== prevToolId) {
          emitCombinedLine('M5');
          emitCombinedLine('G0 Z' + formatCoord(m.jobSpec.safeZMm));
          emitCombinedLine('M6 T' + cp.toolNumber + ' (tool change: ' + cp.tool.name + ' Ø' + cp.tool.diameterMm + 'mm)');
          emitCombinedLine('M3 S' + formatFeed(cp.tool.spindleRpm));
        }

        var cres;
        if (cp.pass.direction === 'outline') {
          cres = generateOutlinePassGCode({ pass: cp.pass, tool: cp.tool, cut: m.cut, width: m.width, height: m.height,
            jobSpec: m.jobSpec, passIndex: cp.passIndex, imageBase: m.imageBase, framing: 'body',
            chunkLimitChars: m.chunkLimitChars,
            onChunk: emitCombined
          });
        } else {
          self.postMessage({ type: 'progress', reqId: m.reqId, phase: 'safeSurface',
            passIndex: cp.passIndex, passCount: m.passes.length, passName: cp.pass.name, toolName: cp.tool.name, fraction: 0 });
          var safeC = computeSafeSurface(m.terrain, m.width, m.height, m.pixelSizeMm, cp.tool.radiusMm, cp.tool.shape,
            (function (ppp) { return function (frac) {
              self.postMessage({ type: 'progress', reqId: m.reqId, phase: 'safeSurface',
                passIndex: ppp.passIndex, passCount: m.passes.length, passName: ppp.pass.name, fraction: frac });
            }; })(cp));
          var targetC = computePassTargetSurface(safeC, cp.pass.allowanceMm, m.stockTopMm);
          self.postMessage({ type: 'progress', reqId: m.reqId, phase: 'toolpath',
            passIndex: cp.passIndex, passCount: m.passes.length, passName: cp.pass.name });
          cres = generatePassGCode({ pass: cp.pass, tool: cp.tool, targetSurface: targetC,
            remaining: remainingC, jobSpec: m.jobSpec, heightMap: heightMapC, passIndex: cp.passIndex, imageBase: m.imageBase,
            framing: 'body',
            chunkLimitChars: m.chunkLimitChars,
            onChunk: emitCombined
          });
        }

        combinedLineCount += cres.lineCount;
        if (cres.zMin < combinedZMin) combinedZMin = cres.zMin;
        if (cres.zMax > combinedZMax) combinedZMax = cres.zMax;
        combinedSweeps += cres.sweeps;
        if (cres.hitCap) combinedHitCap = true;

        prevToolId = cp.pass.toolId;
      }

      ['M5', 'M2'].forEach(emitCombinedLine);

      if (!isFinite(combinedZMin)) combinedZMin = m.jobSpec.safeZMm;
      if (!isFinite(combinedZMax)) combinedZMax = m.jobSpec.safeZMm;

      var combinedSummary = { passIndex: 0, filename: combinedFilename, lineCount: combinedLineCount,
        byteCount: combinedByteCount, zMin: combinedZMin, zMax: combinedZMax, sweeps: combinedSweeps, hitCap: combinedHitCap };
      self.postMessage({ type: 'gcodeEnd', reqId: m.reqId, summary: combinedSummary });
      self.postMessage({ type: 'result', reqId: m.reqId, results: [combinedSummary] });
    } else {
      self.postMessage({ type: 'error', reqId: m.reqId, message: 'Unknown worker cmd: ' + m.cmd });
    }
  } catch (err) {
    self.postMessage({ type: 'error', reqId: m.reqId, message: String(err && err.message || err) });
  }
};
`,
  ].join("\n");
}

/** @type {Worker|null} Lazily created, reused across calls. */
let safeSurfaceWorker = null;

/** @type {Map<number, {resolve:Function, reject:Function, onProgress:Function|null, onStream:Function|null}>}
 *  reqId -> pending-call bookkeeping, so concurrent/sequential worker calls
 *  are safe (each response is routed back to the right Promise). */
const workerPendingRequests = new Map();

/** Monotonically increasing request id counter (not Math.random()/Date.now()
 *  — simple, deterministic, and guaranteed unique within a page session). */
let workerReqIdCounter = 0;

/**
 * Lazily create (or return the existing) worker, wiring up a single
 * onmessage/onerror handler that routes responses to the pending request map
 * by reqId. Per Design.md "File-URL Architecture": built from an inline Blob
 * so it works under file://.
 * @returns {Worker}
 */
function getOrCreateSafeSurfaceWorker() {
  if (safeSurfaceWorker) return safeSurfaceWorker;

  const workerSource = buildWorkerSource();
  const blob = new Blob([workerSource], { type: "application/javascript" });
  const worker = new Worker(URL.createObjectURL(blob));

  worker.onmessage = function (e) {
    const msg = e.data;
    const pending = workerPendingRequests.get(msg.reqId);
    if (!pending) return; // stale/unknown reqId — ignore

    if (msg.type === "progress") {
      if (pending.onProgress) pending.onProgress(msg);
      return; // progress messages don't resolve/reject; keep waiting
    }

    if (msg.type === "gcodeStart" || msg.type === "gcodeChunk" || msg.type === "gcodeEnd") {
      if (pending.onStream) {
        try {
          pending.onStream(msg);
        } catch (err) {
          workerPendingRequests.delete(msg.reqId);
          pending.reject(err);
        }
      }
      return; // streamed output messages don't resolve/reject; keep waiting
    }

    workerPendingRequests.delete(msg.reqId);
    if (msg.type === "result") {
      pending.resolve(msg.results !== undefined ? msg.results : msg.safe);
    } else if (msg.type === "error") {
      pending.reject(new Error(msg.message));
    }
  };

  worker.onerror = function (err) {
    // A worker-level error (e.g. a syntax error in the serialized source)
    // isn't tied to a reqId — reject every currently pending request so
    // callers don't hang forever, then clear the map.
    const message = (err && (err.message || String(err))) || "Worker error";
    for (const pending of workerPendingRequests.values()) {
      pending.reject(new Error(message));
    }
    workerPendingRequests.clear();
    // Drop the crashed worker. Reusing a dead instance is a permanent hang:
    // its postMessage silently no-ops and no onmessage/onerror ever fires
    // again, so every future request's promise would never settle.
    try { worker.terminate(); } catch (e) { /* ignore */ }
    safeSurfaceWorker = null;
  };

  safeSurfaceWorker = worker;
  return worker;
}

/**
 * Main-thread helper: run the safe-surface computation in the worker and
 * resolve with the resulting Float32Array. Creates/reuses a single worker,
 * generates a unique reqId per call, transfers `terrain.buffer` (so the
 * large typed array isn't copied), and routes progress messages to
 * `onProgress` if provided. Safe to call multiple times concurrently or in
 * sequence — each call gets its own reqId and its own resolve/reject.
 *
 * NOTE: because `terrain.buffer` is transferred (not copied), the caller's
 * `terrain` typed array is detached (neutered) after this call — pass a copy
 * if the caller still needs the original array afterward.
 *
 * @param {{terrain:Float32Array, width:number, height:number, pixelSizeMm:number, radiusMm:number, shape:"flat"|"ball"}} params
 * @param {(fraction:number)=>void} [onProgress]
 * @returns {Promise<Float32Array>}
 */
function runSafeSurfaceInWorker(params, onProgress) {
  return new Promise((resolve, reject) => {
    let worker;
    try {
      worker = getOrCreateSafeSurfaceWorker();
    } catch (err) {
      reject(err);
      return;
    }

    workerReqIdCounter += 1;
    const reqId = workerReqIdCounter;
    workerPendingRequests.set(reqId, {
      resolve,
      reject,
      onProgress: onProgress ? (msg) => onProgress(msg.fraction) : null,
      onStream: null,
    });

    worker.postMessage(
      {
        cmd: "safeSurface",
        reqId,
        terrain: params.terrain,
        width: params.width,
        height: params.height,
        pixelSizeMm: params.pixelSizeMm,
        radiusMm: params.radiusMm,
        shape: params.shape,
      },
      [params.terrain.buffer]
    );
  });
}

/**
 * Runs the ENTIRE Generate job (all enabled passes: safe-surface, target
 * surface, and multi-sweep GCode assembly) inside the shared worker. GCode
 * leaves the worker as streamed chunks, with final per-pass summaries resolved
 * at the end, so the main thread never receives one giant GCode string.
 * Mirrors runSafeSurfaceInWorker's get-or-create-worker + reqId +
 * pending-map pattern.
 *
 * @param {object} params
 * @param {Float32Array} params.terrain - transferred (detached) into the worker; pass a COPY if the caller needs it afterward.
 * @param {Uint8Array} params.cut - transferred (detached) into the worker; pass a COPY if the caller needs it afterward.
 * @param {number} params.width
 * @param {number} params.height
 * @param {number} params.pixelSizeMm
 * @param {string} params.originMode
 * @param {string} params.zeroMode
 * @param {number} params.stockTopMm
 * @param {number} params.safeZMm
 * @param {string} params.imageName
 * @param {string} params.imageBase
 * @param {object} params.jobSpec - plain object with the fields generatePassGCode reads from jobSpec.
 * @param {Array<{pass:object, tool:object, passIndex:number, toolNumber:number}>} params.passes
 * @param {number} [params.chunkLimitChars] - approximate streamed GCode chunk size.
 * @param {boolean} [params.singleFile] - if true, emit ONE combined .nc with tool-change (M6) blocks instead of one file per pass.
 * @param {(msg:object)=>void} [onProgress] - receives the full progress message ({phase, passIndex, passCount, passName, toolName, fraction}).
 * @param {(msg:object)=>void} [onStream] - receives gcodeStart/gcodeChunk/gcodeEnd worker messages.
 * @returns {Promise<Array<{passIndex:number, filename:string, zMin:number, zMax:number, sweeps:number, hitCap:boolean, lineCount:number, byteCount:number}>>}
 */
function runGenerateJobInWorker(params, onProgress, onStream) {
  return new Promise((resolve, reject) => {
    let worker;
    try {
      worker = getOrCreateSafeSurfaceWorker();
    } catch (err) {
      reject(err);
      return;
    }

    workerReqIdCounter += 1;
    const reqId = workerReqIdCounter;
    workerPendingRequests.set(reqId, {
      resolve,
      reject,
      onProgress: onProgress || null,
      onStream: onStream || null,
    });

    worker.postMessage(
      {
        cmd: "generateJob",
        reqId,
        terrain: params.terrain,
        cut: params.cut,
        width: params.width,
        height: params.height,
        pixelSizeMm: params.pixelSizeMm,
        originMode: params.originMode,
        zeroMode: params.zeroMode,
        stockTopMm: params.stockTopMm,
        safeZMm: params.safeZMm,
        imageName: params.imageName,
        imageBase: params.imageBase,
        jobSpec: params.jobSpec,
        passes: params.passes,
        chunkLimitChars: params.chunkLimitChars,
        singleFile: !!params.singleFile,
      },
      [params.terrain.buffer, params.cut.buffer]
    );
  });
}

// ============================================================================
// PHASE 6 — RASTER GENERATION + GCODE OUTPUT + DOWNLOADS (single pass, no
// remaining-material tracking — that's Phase 7). See Design.md "Raster
// Generation (exact)", "GCode Output (exact)".
//
// This is deliberately structured so Phase 7 can wrap the row/span/sweep
// emission in a multi-sweep loop: emitRasterSweepMoves() below takes a
// `zAtFn(px, py)` callback for the commanded cut Z at a pixel, rather than
// reading a single target surface directly. Phase 6 calls it once per pass
// with `zAtFn = (px,py) => targetSurface[py*width+px]` (single sweep, cuts
// straight to target). Phase 7 can call it multiple times per pass with a
// zAtFn derived from `max(target, remaining - stepdown)`, updating
// `remaining` (footprint stamping) between calls, without changing this
// function's contract.
// ============================================================================

/**
 * Compute the per-pass target surface: the tool-safe surface raised by the
 * pass's allowance, clamped so it never sits above the stock top. Per
 * Design.md "Remaining-Material Model (exact)" (target-surface formula) —
 * used here without the remaining-material simulation (Phase 7 scope).
 * @param {Float32Array} safeSurface - tool-safe dilation of terrain.
 * @param {number} allowanceMm - stock left above final terrain (>=0).
 * @param {number} stockTopMm - machine Z of top of stock; target is clamped <= this.
 * @returns {Float32Array}
 */
function computePassTargetSurface(safeSurface, allowanceMm, stockTopMm) {
  const n = safeSurface.length;
  const target = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const s = safeSurface[i];
    if (s === -Infinity) {
      target[i] = -Infinity;
      continue;
    }
    const raised = s + allowanceMm;
    target[i] = raised <= stockTopMm ? raised : stockTopMm;
  }
  return target;
}

// ============================================================================
// PHASE 7 — REMAINING-MATERIAL MODEL (pure, no DOM). See Design.md
// "Remaining-Material Model (exact)". `remaining[i]` tracks the current
// top-of-material machine Z, simulated across all passes so later passes know
// what's actually left (e.g. a ball-finish pass sees the stock a flat-rough
// pass left behind, not the raw terrain).
// ============================================================================

/**
 * Initialize the `remaining` (current top-of-material) array for a fresh job
 * run, per Design.md "Remaining-Material Model (exact)": `stockTopMm` for
 * every cut pixel (material starts at the stock top everywhere it exists),
 * `+Infinity` ("never cut here") for non-cut pixels.
 * @param {{width:number, height:number, cut:Uint8Array}} heightMap
 * @param {number} stockTopMm
 * @returns {Float32Array} length width*height
 */
function initRemaining(heightMap, stockTopMm) {
  const { width, height, cut } = heightMap;
  const n = width * height;
  const remaining = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    remaining[i] = cut[i] === 1 ? stockTopMm : Infinity;
  }
  return remaining;
}

/**
 * Stamp a tool's cutting footprint into `remaining` at a single cut position,
 * per Design.md "Remaining-Material Model (exact)" step 3. The tool center is
 * at pixel (px,py) commanded to center-Z `zc`; every pixel (px+dx,py+dy)
 * within `radiusMm` of the center has its `remaining` value lowered (never
 * raised — `Math.min`) to the tool's bottom profile at that offset:
 * `zc + 0` for flat, `zc + (radiusMm - sqrt(radiusMm^2 - d^2))` for ball,
 * where `d = hypot(dx,dy) * pixelSizeMm`.
 *
 * Mutates `remaining` in place; does not return anything.
 *
 * MUST remain fully self-contained (no closures over outer state) — mirrors
 * the safe-surface functions' constraint so it can be reused/serialized the
 * same way if this work is ever moved into the worker.
 *
 * @param {Float32Array} remaining - length width*height, mutated in place.
 * @param {number} width
 * @param {number} height
 * @param {number} px - tool center pixel x (image space).
 * @param {number} py - tool center pixel y (image space).
 * @param {number} zc - commanded center Z for this cut position.
 * @param {number} radiusMm - tool radius in mm.
 * @param {number} pixelSizeMm
 * @param {"flat"|"ball"} shape
 * @returns {boolean} true if this stamp actually lowered at least one
 *   `remaining` value (i.e. removed material). Used by the multi-sweep loop
 *   for fixpoint / convergence detection: a sweep that lowers nothing means
 *   the pass is done (see generatePassGCode).
 */
function stampToolFootprint(remaining, width, height, px, py, zc, radiusMm, pixelSizeMm, shape) {
  let changed = false;

  if (!(radiusMm > 0)) {
    const idx = py * width + px;
    if (px >= 0 && px < width && py >= 0 && py < height) {
      if (zc < remaining[idx]) {
        if (remaining[idx] - zc > STAMP_EPS_MM) changed = true;
        remaining[idx] = zc;
      }
    }
    return changed;
  }

  // Cached "structuring element": the in-radius (dx, dy) offsets and their
  // per-pixel Z profile, precomputed ONCE per (radiusMm, pixelSizeMm, shape)
  // and reused across every stamp — the previous inner loop recomputed
  // Math.hypot + Math.sqrt for every pixel of every stamp (an O(N * r^2)
  // transcendental cost). Memoized on a function property so it also works in
  // the .toString()-serialized worker copy (a module-scope var would not).
  // Byte-identical to the per-pixel computation: same in-disk set, same offset.
  const fpKey = radiusMm + "|" + pixelSizeMm + "|" + shape;
  let fp = stampToolFootprint._fp;
  if (!fp || fp.key !== fpKey) {
    const R = Math.ceil(radiusMm / pixelSizeMm);
    const dxList = [];
    const dyList = [];
    const offList = [];
    for (let dy = -R; dy <= R; dy++) {
      for (let dx = -R; dx <= R; dx++) {
        const d = Math.hypot(dx, dy) * pixelSizeMm;
        if (d > radiusMm) continue;
        let offset = 0;
        if (shape === "ball") {
          offset = radiusMm - Math.sqrt(Math.max(0, radiusMm * radiusMm - d * d));
        }
        dxList.push(dx);
        dyList.push(dy);
        offList.push(offset);
      }
    }
    fp = {
      key: fpKey,
      dxs: Int32Array.from(dxList),
      dys: Int32Array.from(dyList),
      offs: Float64Array.from(offList),
      n: offList.length,
    };
    stampToolFootprint._fp = fp;
  }

  const dxs = fp.dxs;
  const dys = fp.dys;
  const offs = fp.offs;
  const n = fp.n;
  for (let k = 0; k < n; k++) {
    const nx = px + dxs[k];
    if (nx < 0 || nx >= width) continue;
    const ny = py + dys[k];
    if (ny < 0 || ny >= height) continue;
    const idx = ny * width + nx;
    const candidate = zc + offs[k];
    if (candidate < remaining[idx]) {
      if (remaining[idx] - candidate > STAMP_EPS_MM) changed = true;
      remaining[idx] = candidate;
    }
  }

  return changed;
}

/**
 * Format a machine coordinate value to 3 decimal places, per Design.md
 * "GCode Output (exact)" ("Number format": X/Y/Z to 3 decimals).
 * @param {number} v
 * @returns {string}
 */
function formatCoord(v) {
  if (!Number.isFinite(v)) {
    throw new Error("formatCoord: non-finite coordinate (" + v + ") — check depth/allowance inputs.");
  }
  const s = v.toFixed(3);
  return s === "-0.000" ? "0.000" : s; // normalize negative-zero
}

/**
 * Format a feed/spindle rate as an integer (rounded), per Design.md ("feeds
 * as integers").
 * @param {number} v
 * @returns {string}
 */
function formatFeed(v) {
  if (!Number.isFinite(v)) {
    throw new Error("formatFeed: non-finite feed/spindle value (" + v + ").");
  }
  return String(Math.round(v));
}

/**
 * Find maximal runs ("spans") of cut===1 pixels within a single image row.
 * Pure helper, no DOM. Returns spans as [startPx, endPx] inclusive, in
 * ascending px order (left to right); callers reverse for rtl/zigzag.
 * @param {Uint8Array} cut - full HeightMap.cut array, row-major.
 * @param {number} width
 * @param {number} py - row index (image space).
 * @returns {Array<[number, number]>}
 */
function findRowSpans(cut, width, py) {
  const spans = [];
  const rowStart = py * width;
  let spanStart = -1;
  for (let px = 0; px < width; px++) {
    const isCut = cut[rowStart + px] === 1;
    if (isCut && spanStart === -1) {
      spanStart = px;
    } else if (!isCut && spanStart !== -1) {
      spans.push([spanStart, px - 1]);
      spanStart = -1;
    }
  }
  if (spanStart !== -1) spans.push([spanStart, width - 1]);
  return spans;
}

/**
 * Emit the GCode move lines (as an array of strings, appended to `lines`) for
 * one full raster sweep over a pass's enabled rows, per Design.md "Raster
 * Generation (exact)" — rows, spans, direction, move sequence. This is the
 * reusable "sweep" helper: Phase 7 can call it multiple times per pass (once
 * per depth-stepping sweep) with a different `zAtFn`; Phase 6 calls it once.
 *
 * Tracks and returns the min/max commanded cut Z it emitted, and whether the
 * tool is currently at safeZ (so the caller/next sweep can avoid a redundant
 * `G0 Z<safeZ>`).
 *
 * @param {object} params
 * @param {string[]} params.lines - output array; move lines are pushed here.
 * @param {Uint8Array} params.cut - HeightMap.cut, row-major.
 * @param {number} params.width
 * @param {number} params.height
 * @param {number} params.pixelSizeMm
 * @param {"center"|"lowerLeft"} params.originMode
 * @param {number} params.rowStep - pixel stride between rows (>=1).
 * @param {"ltr"|"rtl"|"zigzag"} params.direction
 * @param {(px:number, py:number)=>number} params.zAtFn - commanded cut Z at a pixel.
 * @param {number} params.safeZMm
 * @param {number} params.feedMmMin
 * @param {number} params.plungeMmMin
 * @param {boolean} params.atSafeZ - whether the tool is already at safeZ before this sweep.
 * @param {{x:?string,y:?string,z:?string,f:?string}} [params.modalState] -
 *   last emitted modal X/Y/Z/F words, stored as formatted strings. Per
 *   Design.md "GCode Output" ("Omit a word if the axis value is unchanged
 *   from the previous move"), X/Y/Z/F words are only written when they differ
 *   from this state.
 * @param {(cutPositions: Array<{px:number, py:number, zc:number}>)=>void} [params.afterRow] -
 *   optional (Phase 7): called once per row, immediately after that row's
 *   moves are emitted (and BEFORE the next row's zAtFn calls), with every cut
 *   position visited in that row (across all its spans) in emission order.
 *   Lets a caller "stamp" a remaining-material simulation between rows
 *   without this function needing to know anything about remaining/stamping.
 *   Backward-compatible: omitting it changes nothing about emitted GCode.
 * @returns {{zMin:number, zMax:number, atSafeZ:boolean, modalState:{x:?string,y:?string,z:?string,f:?string}}}
 */
function emitRasterSweepMoves(params) {
  const {
    lines, cut, width, height, pixelSizeMm, originMode, rowStep,
    direction, zAtFn, safeZMm, feedMmMin, plungeMmMin, afterRow,
  } = params;

  let atSafeZ = params.atSafeZ;
  const modalIn = params.modalState || {};
  const modal = {
    x: modalIn.x != null ? modalIn.x : null,
    y: modalIn.y != null ? modalIn.y : null,
    z: modalIn.z != null ? modalIn.z : null,
    f: modalIn.f != null ? modalIn.f : null,
  };
  let zMin = Infinity;
  let zMax = -Infinity;

  const isZigzag = direction === "zigzag";
  let lastCutZnum = null; // numeric Z of the last emitted cut position (for zig-zag transitions)

  function emitMotionLine(code, words) {
    // Skip no-op lines where every modal word was already at the requested
    // value (buildMotionLine returns null then).
    const line = buildMotionLine(code, words, modal);
    if (line !== null) lines.push(line);
  }

  function ensureSafeZ() {
    if (!atSafeZ) {
      emitMotionLine("G0", { z: safeZMm });
      atSafeZ = true;
    }
  }

  // rowOrder: iterate py from bottom of image upward (largest py first), so
  // machine Y goes low->high, stepping by rowStep pixels.
  let rowIndex = 0;
  for (let py = height - 1; py >= 0; py -= rowStep) {
    let spans = findRowSpans(cut, width, py);
    if (spans.length === 0) {
      rowIndex++;
      continue;
    }

    // Determine this row's left-to-right-ness per `direction`.
    let rowLtr;
    if (direction === "ltr") {
      rowLtr = true;
    } else if (direction === "rtl") {
      rowLtr = false;
    } else {
      // zigzag: alternate, starting ltr on the first cut row.
      rowLtr = rowIndex % 2 === 0;
    }

    // Order spans left->right for ltr rows, right->left for rtl/zigzag-odd
    // rows (both the span order and the direction sampled within each span).
    const orderedSpans = rowLtr ? spans : spans.slice().reverse();

    const { y } = pixelCenterToMachineXY(0, py, pixelSizeMm, width, height, originMode);

    // Collects every cut position visited in THIS row (across all its
    // spans), in emission order, so afterRow can be called once per row —
    // all of a row's zc values are computed here (from zAtFn) before any of
    // them are stamped (that happens after the row, in afterRow).
    const rowCutPositions = afterRow ? [] : null;

    for (const span of orderedSpans) {
      const [spanStartPx, spanEndPx] = span;
      // Build the ordered list of px positions to sample across this span,
      // 1 pixel at a time (per spec), in the row's direction.
      const pxList = [];
      if (rowLtr) {
        for (let px = spanStartPx; px <= spanEndPx; px++) pxList.push(px);
      } else {
        for (let px = spanEndPx; px >= spanStartPx; px--) pxList.push(px);
      }

      const x0px = pxList[0];
      const { x: x0 } = pixelCenterToMachineXY(x0px, py, pixelSizeMm, width, height, originMode);
      const zc0 = zAtFn(x0px, py);

      if (isZigzag && !atSafeZ && lastCutZnum != null) {
        // Zig-zag inter-segment transition WITHOUT retracting to safe Z:
        // travel XY at the higher of (current Z, next-start Z) so both
        // endpoints clear, then step to the start Z. Avoids the wasteful
        // move-to-safe-height on every row.
        if (zc0 > lastCutZnum) {
          emitMotionLine("G0", { z: zc0 });                 // raise first (rapid up is safe)
          if (pxList.length === 1) {
            // Single-pixel span: the run loop below starts at index 1, so no
            // feed move would ever engage this lone pixel. Reach it with a
            // controlled feed move instead of a rapid, otherwise it would be
            // "cut" at rapid speed with no feed word at all.
            emitMotionLine("G1", { x: x0, y, f: feedMmMin });
          } else {
            emitMotionLine("G0", { x: x0, y });             // then rapid across; the feed run cuts from x0
          }
        } else {
          emitMotionLine("G0", { x: x0, y });               // rapid across at current (higher) Z
          emitMotionLine("G1", { z: zc0, f: plungeMmMin });  // then controlled plunge down
        }
      } else {
        ensureSafeZ();
        emitMotionLine("G0", { x: x0, y });
        emitMotionLine("G1", { z: zc0, f: plungeMmMin });
      }
      atSafeZ = false;
      lastCutZnum = zc0;
      if (zc0 < zMin) zMin = zc0;
      if (zc0 > zMax) zMax = zc0;
      if (rowCutPositions) rowCutPositions.push({ px: x0px, py, zc: zc0 });

      let runFirst = null;
      let runLast = null;
      let runZ = null;

      // Keep per-pixel z/stamping below, but emit only endpoints for
      // consecutive samples whose formatted Z is unchanged.
      function flushCutRun() {
        if (!runFirst) return;
        const firstChangesZ = runFirst.zStr !== modal.z;
        if (firstChangesZ) {
          emitMotionLine("G1", { x: runFirst.x, z: runFirst.zc, f: feedMmMin });
        }
        if (runLast !== runFirst || !firstChangesZ) {
          emitMotionLine("G1", { x: runLast.x, z: runLast.zc, f: feedMmMin });
        }
      }

      for (let k = 1; k < pxList.length; k++) {
        const px = pxList[k];
        const { x } = pixelCenterToMachineXY(px, py, pixelSizeMm, width, height, originMode);
        const zc = zAtFn(px, py);
        if (zc < zMin) zMin = zc;
        if (zc > zMax) zMax = zc;
        lastCutZnum = zc;
        if (rowCutPositions) rowCutPositions.push({ px, py, zc });

        const sample = { x, zc, zStr: formatCoord(zc) };
        if (!runFirst) {
          runFirst = sample;
          runLast = sample;
          runZ = sample.zStr;
        } else if (sample.zStr === runZ) {
          runLast = sample;
        } else {
          flushCutRun();
          runFirst = sample;
          runLast = sample;
          runZ = sample.zStr;
        }
      }
      flushCutRun();

      // Retract at span end — EXCEPT zig-zag, which keeps the tool down and
      // handles Z at the next segment's start (see the transition above).
      if (!isZigzag) {
        emitMotionLine("G0", { z: safeZMm });
        atSafeZ = true;
      }
    }

    if (afterRow) afterRow(rowCutPositions);

    rowIndex++;
  }

  // Zig-zag leaves the tool down between segments; ensure the sweep ends at
  // safe Z so the next sweep / pass footer starts clean. (No-op for ltr/rtl,
  // which already retracted at each span end.)
  if (!atSafeZ) {
    emitMotionLine("G0", { z: safeZMm });
    atSafeZ = true;
  }

  return { zMin, zMax, atSafeZ, modalState: { x: modal.x, y: modal.y, z: modal.z, f: modal.f } };
}

/**
 * Sanitize a tool name for use in a filename: keep only [A-Za-z0-9_].
 * @param {string} name
 * @returns {string}
 */
function sanitizeToolName(name) {
  return String(name).replace(/[^A-Za-z0-9_]/g, "_");
}

/** Safety cap on the number of full-surface sweeps a single pass may run,
 *  per Design.md "Remaining-Material Model (exact)" step 4 ("bounded by a
 *  safety cap, e.g. 200, log if hit"). Guards against an infinite loop if a
 *  pass can never reach its target (e.g. a misconfigured stepdown of 0). */
const MAX_SWEEPS_PER_PASS = 200;

/** Tolerance for "has this pixel reached its target" comparisons in the
 *  multi-sweep loop, per Design.md "Remaining-Material Model (exact)" step 1. */
const REMAINING_TARGET_TOL = 1e-4;

/** Minimum material-removal depth (mm) for a stamp to count as "changed" for
 *  fixpoint termination. The ball footprint's sqrt-based offset produces
 *  perpetual sub-nanometer (~2e-7 mm) decreases that never reach an exact
 *  floating-point fixpoint, so a strict `<` check loops to MAX_SWEEPS_PER_PASS.
 *  1e-6 mm (1 nm) is far below GCode's 3-decimal (1 µm) output precision, so
 *  ignoring changes smaller than this is machining-irrelevant and guarantees
 *  termination. (The flat tool has offset 0 and is unaffected either way.) */
const STAMP_EPS_MM = 1e-6;

/**
 * Generate GCode for one enabled pass, either as a full text string (default,
 * used by tests/small compatibility paths) or streamed chunks (`onChunk`,
 * used by worker exports), per Design.md "Raster Generation (exact)", "GCode
 * Output (exact)", and "Remaining-Material Model (exact)" (multi-sweep depth
 * stepping). `remaining` is REQUIRED and is MUTATED IN PLACE: the pass
 * repeats full-surface sweeps, each removing at most `effectiveStepdown` of
 * material, until every cut pixel's `remaining` value is within tolerance of
 * `targetSurface`. Later passes (called with the same `remaining` array) see
 * exactly what earlier passes left behind — that's the whole point of the
 * shared array.
 *
 * Per-row ordering guarantee ("compute zc before stamping", per Design.md
 * step 2/3): `emitRasterSweepMoves` calls `zAtFn` for every pixel of a row
 * (across all its spans) before this function's `afterRow` callback stamps
 * any of them into `remaining` — see emitRasterSweepMoves's afterRow contract
 * above. So a row's commanded Z values are always computed from `remaining`
 * as it stood immediately before that row was cut, never mid-row-feedback.
 *
 * @param {object} params
 * @param {object} params.pass - PassSpec (uses name, direction, stepoverMm, maxStepdownMm, allowanceMm).
 * @param {object} params.tool - ToolSpec (uses name, shape, diameterMm, radiusMm, stepoverMm, maxStepdownMm, feedMmMin, plungeMmMin, spindleRpm).
 * @param {Float32Array} params.targetSurface - length width*height, machine Z per pixel (-Infinity = no cut).
 * @param {Float32Array} params.remaining - length width*height, current top-of-material Z; REQUIRED, MUTATED IN PLACE.
 * @param {object} params.jobSpec - JobSpec (uses imageName, widthPx/heightPx, pixelSizeMm, zeroMode, originMode, stockTopMm, safeZMm).
 * @param {object} params.heightMap - HeightMap (uses width, height, cut).
 * @param {number} params.passIndex - 1-based index among enabled passes.
 * @param {(chunk:string)=>void} [params.onChunk] - if set, emits GCode chunks and returns `gcode:null`.
 * @param {number} [params.chunkLimitChars] - approximate streamed chunk size.
 * @returns {{filename:string, gcode:string|null, zMin:number, zMax:number, sweeps:number, hitCap:boolean, lineCount:number, byteCount:number}}
 */
function generatePassGCode(params) {
  const { pass, tool, targetSurface, remaining, jobSpec, heightMap, passIndex } = params;
  if (!remaining) {
    throw new Error("generatePassGCode: `remaining` is required (Phase 7).");
  }
  const framing = params.framing || "full";
  const bodyOnly = framing === "body";
  const { width, height, cut } = heightMap;
  const pixelSizeMm = jobSpec.pixelSizeMm;
  const originMode = jobSpec.originMode;
  const safeZMm = jobSpec.safeZMm;
  const radiusMm = tool.radiusMm;
  const shape = tool.shape;

  const effectiveStepover = pass.stepoverMm === null || pass.stepoverMm === undefined
    ? tool.stepoverMm
    : pass.stepoverMm;
  const effectiveStepdown = pass.maxStepdownMm === null || pass.maxStepdownMm === undefined
    ? tool.maxStepdownMm
    : pass.maxStepdownMm;

  const rowStep = Math.max(1, Math.round(effectiveStepover / pixelSizeMm));

  const sanitizedToolName = sanitizeToolName(tool.name);
  const imageBase = params.imageBase != null
    ? params.imageBase
    : ((typeof currentImageBaseName !== "undefined" && currentImageBaseName)
        ? currentImageBaseName
        : baseNameWithoutExtension(jobSpec.imageName || "job"));
  const filename = `${imageBase}_${passIndex}_${sanitizedToolName}.nc`;

  const physW = width * pixelSizeMm;
  const physH = height * pixelSizeMm;
  const preamble = ["G90", "G21", "G17", `M3 S${formatFeed(tool.spindleRpm)}`];
  const footer = [`G0 Z${formatCoord(safeZMm)}`, "M5", "M2"];

  const gcodeStream = createGcodeStream(params.onChunk, params.chunkLimitChars);
  const streamOutput = gcodeStream.streamOutput;
  const lines = gcodeStream.lines;
  const emitLine = gcodeStream.emitLine;
  const flushChunk = gcodeStream.flushChunk;

  const lineSink = streamOutput ? { push: emitLine } : lines;

  let atSafeZ = true; // start of pass: assume already clear (footer of previous pass ends at safeZ)
  let modalState = { x: null, y: null, z: null, f: null };
  let zMin = Infinity;
  let zMax = -Infinity;
  let sweeps = 0;
  let hitCap = false;

  /**
   * Is any cut pixel still more than tol above its target? Used ONLY as the
   * initial gate: if the surface is already at/below target everywhere cut,
   * the pass has nothing to do and emits zero sweeps. It must NOT be used as
   * the loop-continuation condition — with stepover > 1px, between-row pixels
   * are never cut centers (they're only lowered by neighbors' footprint
   * spillover) and can permanently plateau above their own target[i], so this
   * check can stay true forever even after material stops being removed.
   * Loop continuation is governed by fixpoint detection instead (see below).
   */
  function anyCutPixelAboveTarget() {
    const n = width * height;
    for (let i = 0; i < n; i++) {
      if (cut[i] !== 1) continue;
      if (remaining[i] - targetSurface[i] > REMAINING_TARGET_TOL) return true;
    }
    return false;
  }

  function stampWouldChangeAt(px, py, zc) {
    if (!(radiusMm > 0)) {
      if (px < 0 || px >= width || py < 0 || py >= height) return false;
      const idx = py * width + px;
      return zc < remaining[idx] && remaining[idx] - zc > STAMP_EPS_MM;
    }

    const radiusPx = radiusMm / pixelSizeMm;
    const R = Math.ceil(radiusPx);
    const loDy = Math.max(-R, -py);
    const hiDy = Math.min(R, height - 1 - py);
    const loDx = Math.max(-R, -px);
    const hiDx = Math.min(R, width - 1 - px);

    for (let dy = loDy; dy <= hiDy; dy++) {
      const ny = py + dy;
      const rowStart = ny * width;
      for (let dx = loDx; dx <= hiDx; dx++) {
        const d = Math.hypot(dx, dy) * pixelSizeMm;
        if (d > radiusMm) continue;
        let offset = 0;
        if (shape === "ball") {
          offset = radiusMm - Math.sqrt(Math.max(0, radiusMm * radiusMm - d * d));
        }
        const idx = rowStart + px + dx;
        const candidate = zc + offset;
        if (candidate < remaining[idx] && remaining[idx] - candidate > STAMP_EPS_MM) {
          return true;
        }
      }
    }

    return false;
  }

  function wouldNextSweepChange() {
    for (let py = height - 1; py >= 0; py -= rowStep) {
      const spans = findRowSpans(cut, width, py);
      for (let s = 0; s < spans.length; s++) {
        const span = spans[s];
        for (let px = span[0]; px <= span[1]; px++) {
          const i = py * width + px;
          const zc = Math.max(targetSurface[i], remaining[i] - effectiveStepdown);
          if (stampWouldChangeAt(px, py, zc)) return true;
        }
      }
    }
    return false;
  }

  if (bodyOnly) {
    emitLine(`; --- pass ${passIndex}: ${pass.name} (${tool.name}) ---`);
  } else if (streamOutput) {
    [
      `; image: ${jobSpec.imageName}`,
      `; dimensions: ${width}x${height} px`,
      `; pixelSizeMm: ${pixelSizeMm}  physical size: ${physW.toFixed(3)} x ${physH.toFixed(3)} mm`,
      `; zeroMode: ${jobSpec.zeroMode}`,
      `; originMode: ${jobSpec.originMode}`,
      `; stockTopMm: ${jobSpec.stockTopMm}`,
      `; safeZMm: ${jobSpec.safeZMm}`,
      `; tool: ${tool.name}  shape: ${tool.shape}  diameterMm: ${tool.diameterMm}`,
      `; pass: ${pass.name}  direction: ${pass.direction}  stepoverMm: ${effectiveStepover}  stepdownMm: ${effectiveStepdown}  allowanceMm: ${pass.allowanceMm}`,
      `; spindleRpm: ${tool.spindleRpm}`,
      `; commanded Z range: written in footer after streamed generation`,
      `; sweeps: written in footer after streamed generation`,
    ].concat(preamble).forEach(emitLine);
  }

  // Non-streaming preserves the original rollback-based fixpoint loop.
  // Streaming checks each next sweep before writing it, because emitted chunks
  // cannot be rolled back once sent to the main thread/file writer.
  let keepSweeping = streamOutput ? true : anyCutPixelAboveTarget();

  while (keepSweeping) {
    if (streamOutput && !wouldNextSweepChange()) {
      keepSweeping = false;
      break;
    }

    if (sweeps >= MAX_SWEEPS_PER_PASS) {
      const msg = `Pass "${pass.name}": reached the safety cap of ${MAX_SWEEPS_PER_PASS} sweeps without converging on the target surface — stopping early.`;
      if (typeof logGenerate === "function") logGenerate("WARNING: " + msg);
      console.warn(msg);
      hitCap = true;
      break;
    }

    // Snapshot state so an unproductive terminating sweep (see fixpoint note
    // below) can be rolled back without leaving behind redundant GCode moves.
    const linesLenBefore = streamOutput ? 0 : lines.length;
    const atSafeZBefore = atSafeZ;
    const modalStateBefore = { ...modalState };

    // Step 2: commanded zc per pixel, computed from `remaining` as it stands
    // BEFORE this row is stamped (emitRasterSweepMoves guarantees zAtFn for
    // every pixel of a row runs before that row's afterRow stamping call).
    const zAtFn = (px, py) => {
      const i = py * width + px;
      return Math.max(targetSurface[i], remaining[i] - effectiveStepdown);
    };

    // Step 3: after a row's moves are emitted, stamp that row's cut positions
    // into `remaining` using each position's own commanded zc. Track whether
    // ANY stamp in this sweep actually lowered `remaining` (removed material)
    // — that's the fixpoint / convergence signal for the loop below.
    let sweepChanged = false;
    const afterRow = (cutPositions) => {
      for (let k = 0; k < cutPositions.length; k++) {
        const { px, py, zc } = cutPositions[k];
        const changed = stampToolFootprint(remaining, width, height, px, py, zc, radiusMm, pixelSizeMm, shape);
        if (changed) sweepChanged = true;
      }
    };

    const sweepResult = emitRasterSweepMoves({
      lines: lineSink,
      cut,
      width,
      height,
      pixelSizeMm,
      originMode,
      rowStep,
      direction: pass.direction,
      zAtFn,
      safeZMm,
      feedMmMin: tool.feedMmMin,
      plungeMmMin: tool.plungeMmMin,
      atSafeZ,
      modalState,
      afterRow,
    });

    // Fixpoint termination: a pass is done when a full sweep removes NO
    // material. `remaining` is only ever lowered by stamps and is bounded
    // below by target/terrain, so this is a monotone-decreasing, bounded
    // process — once a sweep changes nothing, no future sweep ever will. This
    // is the ONLY sound convergence test: with stepover > 1px, between-row
    // pixels are never cut centers and can permanently plateau above their
    // own target[i], so a "some cut pixel still above target" test would loop
    // forever (the bug this fixes). It's also unsound to check only visited
    // cut-centers-above-target, because an at-target flat cut center can still
    // lower a higher neighbor within its footprint.
    if (sweepChanged) {
      // Productive sweep — keep its moves and account for it.
      atSafeZ = sweepResult.atSafeZ;
      modalState = sweepResult.modalState;
      if (sweepResult.zMin < zMin) zMin = sweepResult.zMin;
      if (sweepResult.zMax > zMax) zMax = sweepResult.zMax;
      sweeps += 1;
    } else {
      // Unproductive terminating sweep: it re-traversed the surface at (or
      // above) already-reached material and removed nothing, so its GCode is
      // pure redundant re-cutting. Roll it back — don't emit it and don't
      // count it. (`remaining` is unchanged by definition, so no rollback of
      // it is needed.) Then stop.
      if (!streamOutput) lines.length = linesLenBefore;
      atSafeZ = atSafeZBefore;
      modalState = modalStateBefore;
      keepSweeping = false;
    }
  }

  if (!Number.isFinite(zMin)) zMin = safeZMm;
  if (!Number.isFinite(zMax)) zMax = safeZMm;

  if (bodyOnly) {
    emitLine(`G0 Z${formatCoord(safeZMm)}`);
    flushChunk();
    if (streamOutput) {
      return { filename, gcode: null, zMin, zMax, sweeps, hitCap, lineCount: gcodeStream.lineCount, byteCount: gcodeStream.byteCount };
    }
    const gcode = lines.join("\n") + "\n";
    return { filename, gcode, zMin, zMax, sweeps, hitCap, lineCount: lines.length, byteCount: gcode.length };
  }

  if (streamOutput) {
    [
      `; streamed summary: commanded Z range ${zMin.toFixed(2)} to ${zMax.toFixed(2)} mm`,
      `; streamed summary: sweeps ${sweeps}`,
    ].forEach(emitLine);
    if (hitCap) {
      emitLine(`; WARNING: reached ${MAX_SWEEPS_PER_PASS}-sweep cap before convergence`);
    }
    footer.forEach(emitLine);
    flushChunk();
    return { filename, gcode: null, zMin, zMax, sweeps, hitCap, lineCount: gcodeStream.lineCount, byteCount: gcodeStream.byteCount };
  }

  const header = [
    `; image: ${jobSpec.imageName}`,
    `; dimensions: ${width}x${height} px`,
    `; pixelSizeMm: ${pixelSizeMm}  physical size: ${physW.toFixed(3)} x ${physH.toFixed(3)} mm`,
    `; zeroMode: ${jobSpec.zeroMode}`,
    `; originMode: ${jobSpec.originMode}`,
    `; stockTopMm: ${jobSpec.stockTopMm}`,
    `; safeZMm: ${jobSpec.safeZMm}`,
    `; tool: ${tool.name}  shape: ${tool.shape}  diameterMm: ${tool.diameterMm}`,
    `; pass: ${pass.name}  direction: ${pass.direction}  stepoverMm: ${effectiveStepover}  stepdownMm: ${effectiveStepdown}  allowanceMm: ${pass.allowanceMm}`,
    `; spindleRpm: ${tool.spindleRpm}`,
    `; commanded Z range: ${zMin.toFixed(2)} to ${zMax.toFixed(2)} mm`,
    `; sweeps: ${sweeps}`,
  ].map((l) => l); // (comment lines already `; `-prefixed above)

  const allLines = header.concat(preamble, lines, footer);
  const gcode = allLines.join("\n") + "\n";

  return { filename, gcode, zMin, zMax, sweeps, hitCap, lineCount: allLines.length, byteCount: gcode.length };
}

// ----------------------------------------------------------------------------
// Generate button wiring — runs each enabled pass in the worker and streams
// per-pass .nc output either directly to disk (Chrome File System Access API)
// or to chunked Blob download links as a fallback. See Design.md "GCode
// Output (exact)" ("One .nc per enabled pass").
// ----------------------------------------------------------------------------

const downloadAreaEl = document.getElementById("download-area");
const generateLogEl = document.getElementById("generate-log");

/** Append one line to the #generate-log <pre>. */
function logGenerate(line) {
  generateLogEl.textContent += (generateLogEl.textContent ? "\n" : "") + line;
}

/** Clear the download area and log at the start of a Generate run. */
function resetGenerateOutputs() {
  downloadAreaEl.innerHTML = "";
  generateLogEl.textContent = "";
}

const GCODE_STREAM_CHUNK_LIMIT_CHARS = 1024 * 1024;

function supportsDirectFileStreaming(passCount) {
  if (typeof window === "undefined") return false;
  if (passCount > 1 && typeof window.showDirectoryPicker === "function") return true;
  return typeof window.showSaveFilePicker === "function" || typeof window.showDirectoryPicker === "function";
}

function expectedPassFilename(imageBase, passIndex, toolName) {
  return `${imageBase}_${passIndex}_${sanitizeToolName(toolName)}.nc`;
}

function formatBytes(bytes) {
  if (!(bytes > 0)) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value.toFixed(unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`;
}

function addDownloadLinkForParts(filename, parts) {
  const blob = new Blob(parts, { type: "text/plain" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.textContent = `Download ${filename}`;
  link.className = "download-link";
  const wrapper = document.createElement("div");
  wrapper.appendChild(link);
  downloadAreaEl.appendChild(wrapper);
}

function addSavedFileNotice(filename, bytes) {
  const wrapper = document.createElement("div");
  wrapper.className = "download-link";
  wrapper.textContent = `Saved ${filename} (${formatBytes(bytes)})`;
  downloadAreaEl.appendChild(wrapper);
}

function createWritableOutputSink(filename, writable) {
  return {
    mode: "file",
    filename,
    bytes: 0,
    chunkCount: 0,
    writeQueue: Promise.resolve(),
    write(chunk) {
      this.bytes += chunk.length;
      this.chunkCount += 1;
      this.writeQueue = this.writeQueue.then(() => writable.write(chunk));
      // onStream calls write() without awaiting the returned promise, so a
      // failed disk write would otherwise surface as an unhandled-promise
      // rejection. Attach a no-op catch to consume it here; the error is still
      // propagated to the caller because close()/finalizeOutputSinks await this
      // same writeQueue (and close() therefore never reaches its "Saved" notice
      // on failure).
      this.writeQueue.catch(() => {});
      return this.writeQueue;
    },
    async close() {
      await this.writeQueue;
      await writable.close();
      addSavedFileNotice(this.filename, this.bytes);
    },
    async abort() {
      try {
        await writable.abort();
      } catch (err) {
        // Best effort only; the original generation error is more useful.
      }
    },
  };
}

async function createFileOutputSink(filename) {
  const handle = await window.showSaveFilePicker({
    suggestedName: filename,
    types: [
      {
        description: "GCode",
        accept: { "text/plain": [".nc", ".gcode", ".tap", ".txt"] },
      },
    ],
  });
  const writable = await handle.createWritable();
  return createWritableOutputSink(filename, writable);
}

async function prepareDirectoryOutputSinks(workerPasses, imageBase) {
  const sinks = new Map();
  try {
    const directoryHandle = await window.showDirectoryPicker({ mode: "readwrite" });
    for (const p of workerPasses) {
      const filename = expectedPassFilename(imageBase, p.passIndex, p.tool.name);
      const fileHandle = await directoryHandle.getFileHandle(filename, { create: true });
      const writable = await fileHandle.createWritable();
      sinks.set(p.passIndex, createWritableOutputSink(filename, writable));
    }
  } catch (err) {
    await abortOutputSinks(sinks);
    throw err;
  }
  return sinks;
}

function createBlobOutputSink(filename) {
  return {
    mode: "blob",
    filename,
    chunks: [],
    bytes: 0,
    chunkCount: 0,
    write(chunk) {
      this.chunks.push(chunk);
      this.bytes += chunk.length;
      this.chunkCount += 1;
    },
    async close() {
      addDownloadLinkForParts(this.filename, this.chunks);
    },
    async abort() {
      this.chunks.length = 0;
    },
  };
}

async function prepareOutputSinks(workerPasses, imageBase, singleFile) {
  const sinks = new Map();

  if (singleFile) {
    const wantsDirectStreaming = streamToFilesCheckbox ? streamToFilesCheckbox.checked : false;
    const canDirectStream = wantsDirectStreaming && typeof window.showSaveFilePicker === "function";
    if (wantsDirectStreaming && !canDirectStream) {
      logGenerate("Direct file streaming is not available in this browser/context; falling back to an in-memory download link.");
    }
    const filename = `${imageBase}_combined.nc`;
    try {
      const sink = canDirectStream
        ? await createFileOutputSink(filename)
        : createBlobOutputSink(filename);
      sinks.set(0, sink);
    } catch (err) {
      for (const sink of sinks.values()) {
        if (sink.abort) await sink.abort();
      }
      if (err && err.name === "AbortError") {
        throw new Error("File selection cancelled; GCode export was not started.");
      }
      throw err;
    }
    return { sinks, directToFiles: canDirectStream };
  }

  const wantsDirectStreaming = streamToFilesCheckbox ? streamToFilesCheckbox.checked : false;
  const canDirectStream = wantsDirectStreaming && supportsDirectFileStreaming(workerPasses.length);

  if (wantsDirectStreaming && !canDirectStream) {
    logGenerate("Direct file streaming is not available in this browser/context; falling back to in-memory download links.");
  }

  try {
    if (
      canDirectStream &&
      typeof window.showDirectoryPicker === "function" &&
      (workerPasses.length > 1 || typeof window.showSaveFilePicker !== "function")
    ) {
      return { sinks: await prepareDirectoryOutputSinks(workerPasses, imageBase), directToFiles: true };
    }

    for (const p of workerPasses) {
      const filename = expectedPassFilename(imageBase, p.passIndex, p.tool.name);
      const sink = canDirectStream
        ? await createFileOutputSink(filename)
        : createBlobOutputSink(filename);
      sinks.set(p.passIndex, sink);
    }
  } catch (err) {
    for (const sink of sinks.values()) {
      if (sink.abort) await sink.abort();
    }
    if (err && err.name === "AbortError") {
      throw new Error("File selection cancelled; GCode export was not started.");
    }
    throw err;
  }

  return { sinks, directToFiles: canDirectStream };
}

async function finalizeOutputSinks(sinks, results) {
  for (const result of results) {
    const sink = sinks.get(result.passIndex);
    if (!sink) continue;
    await sink.close();
  }
}

async function abortOutputSinks(sinks) {
  if (!sinks) return;
  for (const sink of sinks.values()) {
    if (sink.abort) await sink.abort();
  }
}

/**
 * Generate-button click handler: recompute terrain if needed, run the
 * safe-surface worker for each enabled pass's tool (on a COPY of the
 * terrain, since the worker transfers/detaches the buffer), compute the
 * pass's target surface, then generate its (possibly multi-sweep) GCode
 * against a SINGLE shared `remaining` array initialized once per Generate run
 * (Phase 7 — Design.md "Remaining-Material Model (exact)"): passes run in
 * order and mutate `remaining` in place, so a later pass (e.g. ball finish)
 * sees exactly what an earlier pass (e.g. flat rough) left behind. Progress
 * (including sweep counts) is logged per pass. Disables the button while
 * running.
 */
async function handleGenerateClick() {
  if (isGenerating) return; // a generation job is already in flight
  const { errors } = runValidation();
  if (errors.length > 0) return; // button should already be disabled, but guard anyway

  if (!currentTerrain) {
    recomputeTerrain();
  }
  if (!currentTerrain) {
    logGenerate("ERROR: surface is not available (check image + depth settings).");
    return;
  }

  resetGenerateOutputs();

  const enabledPasses = currentJobSpec.passes.filter((p) => p.enabled);
  const toolsById = new Map(currentTools.map((t) => [t.id, t]));
  const toolNumbersById = new Map(currentTools.map((t, i) =>
    [t.id, (Number.isInteger(t.toolNumber) && t.toolNumber > 0) ? t.toolNumber : i + 1]));
  const singleFile = singleFileCheckbox ? singleFileCheckbox.checked : false;

  isGenerating = true;
  generateBtn.disabled = true;
  const originalLabel = generateBtn.textContent;
  generateBtn.textContent = "Generating…";
  let outputSinks = null;
  let outputFinalized = false;

  try {
    const workerPasses = enabledPasses.map((pass, i) => {
      const tool = toolsById.get(pass.toolId);
      if (!tool) {
        throw new Error(`Pass "${pass.name}" references an unknown tool.`);
      }
      const toolNumber = toolNumbersById.get(pass.toolId) || 1;
      return { pass, tool, passIndex: i + 1, toolNumber };
    });

    const imageBase = currentImageBaseName || baseNameWithoutExtension(currentJobSpec.imageName || "job");
    const preparedOutputs = await prepareOutputSinks(workerPasses, imageBase, singleFile);
    outputSinks = preparedOutputs.sinks;
    logGenerate(preparedOutputs.directToFiles
      ? `Writing streamed GCode directly to ${outputSinks.size} selected file(s).`
      : `Building streamed GCode download link(s) in memory for ${outputSinks.size} file(s).`);

    // Minimal jobSpec payload: only the fields generatePassGCode reads.
    const jobSpec = {
      imageName: currentJobSpec.imageName,
      widthPx: currentJobSpec.widthPx,
      heightPx: currentJobSpec.heightPx,
      pixelSizeMm: currentJobSpec.pixelSizeMm,
      zeroMode: currentJobSpec.zeroMode,
      originMode: currentJobSpec.originMode,
      stockTopMm: currentJobSpec.stockTopMm,
      safeZMm: currentJobSpec.safeZMm,
    };

    let lastPassIndex = -1;
    const onProgress = (msg) => {
      if (msg.phase === "safeSurface") {
        if (msg.passIndex !== lastPassIndex) {
          lastPassIndex = msg.passIndex;
          logGenerate(`[${msg.passIndex}/${msg.passCount}] ${msg.passName}: computing safe surface…`);
        }
        logGenerate(`  safe-surface progress: ${Math.round(msg.fraction * 100)}%`);
      } else if (msg.phase === "toolpath") {
        logGenerate(`  computing toolpath (multi-sweep depth stepping)…`);
      }
    };

    const onStream = (msg) => {
      if (msg.type === "gcodeStart") {
        logGenerate(`  writing ${msg.filename}…`);
        return;
      }
      if (msg.type === "gcodeChunk") {
        const sink = outputSinks && outputSinks.get(msg.passIndex);
        if (!sink) {
          throw new Error(`No output sink is available for pass ${msg.passIndex}.`);
        }
        sink.write(msg.chunk);
        return;
      }
      if (msg.type === "gcodeEnd" && msg.summary) {
        const sink = outputSinks && outputSinks.get(msg.summary.passIndex);
        const bytes = sink ? sink.bytes : msg.summary.byteCount;
        logGenerate(`  streamed ${msg.summary.filename}: ${formatBytes(bytes)}`);
      }
    };

    // IMPORTANT: pass COPIES of currentTerrain / currentHeightMap.cut — the
    // worker call transfers (detaches) these buffers, and the originals must
    // survive for future Generate runs and the preview.
    const results = await runGenerateJobInWorker(
      {
        terrain: currentTerrain.slice(),
        cut: currentHeightMap.cut.slice(),
        width: currentHeightMap.width,
        height: currentHeightMap.height,
        pixelSizeMm: currentJobSpec.pixelSizeMm,
        originMode: currentJobSpec.originMode,
        zeroMode: currentJobSpec.zeroMode,
        stockTopMm: currentJobSpec.stockTopMm,
        safeZMm: currentJobSpec.safeZMm,
        imageName: currentJobSpec.imageName,
        imageBase,
        jobSpec,
        passes: workerPasses,
        chunkLimitChars: GCODE_STREAM_CHUNK_LIMIT_CHARS,
        singleFile,
      },
      onProgress,
      onStream
    );

    await finalizeOutputSinks(outputSinks, results);
    outputFinalized = true;

    for (const result of results) {
      logGenerate(
        `  done: ${result.filename} — ${result.lineCount} lines, ${result.sweeps} sweep(s), Z range ${result.zMin.toFixed(3)}..${result.zMax.toFixed(3)} mm`
      );
      if (result.hitCap) {
        logGenerate(
          `WARNING: Pass produced ${result.filename} but reached the ${MAX_SWEEPS_PER_PASS}-sweep cap without converging on the target surface.`
        );
      }
    }

    window.__lastGenerated = results;
    logGenerate(`Generated ${results.length} file(s).`);
  } catch (err) {
    if (!outputFinalized) {
      await abortOutputSinks(outputSinks);
    }
    logGenerate("ERROR: " + (err && err.message ? err.message : String(err)));
  } finally {
    isGenerating = false;
    generateBtn.disabled = false;
    generateBtn.textContent = originalLabel;
    // Re-validate in case disabling/enabling raced with a state change.
    runValidation();
  }
}

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
 * (c) zAtBlackMm===zAtWhiteMm, (d) valid seed config -> zero errors,
 * (e) stepover > diameter -> warning.
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
          { id: "p1", name: "Rough", toolId: "t1", direction: "rtl", stepoverMm: null, maxStepdownMm: null, allowanceMm: 0.8, enabled: true },
          { id: "p2", name: "Finish", toolId: "t2", direction: "zigzag", stepoverMm: null, maxStepdownMm: null, allowanceMm: 0, enabled: true },
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

  // (d) valid seed config with an image -> zero errors.
  {
    const { errors } = validateJob(makeJobSpec(), makeTools(), makeHeightMap());
    checks.push(["valid config -> zero errors", errors.length === 0]);
  }

  // (e) stepover > diameter -> warning present.
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
    const { errors } = validateJob(job([{ id: "p1", name: "R", toolId: "t1", direction: "rtl", stepoverMm: null, maxStepdownMm: 0, allowanceMm: 0, enabled: true }]), tools, hm);
    checks.push(["pass maxStepdown=0 -> error", errors.some((e) => /max stepdown/i.test(e))]);
  }
  {
    const { errors } = validateJob(job([{ id: "p1", name: "R", toolId: "t1", direction: "rtl", stepoverMm: -1, maxStepdownMm: null, allowanceMm: 0, enabled: true }]), tools, hm);
    checks.push(["pass stepover=-1 -> error", errors.some((e) => /stepover override/i.test(e))]);
  }
  {
    const { errors } = validateJob(job([{ id: "p1", name: "R", toolId: "t1", direction: "rtl", stepoverMm: null, maxStepdownMm: null, allowanceMm: NaN, enabled: true }]), tools, hm);
    checks.push(["raster NaN allowance -> error", errors.some((e) => /allowance/i.test(e))]);
  }
  {
    const { errors } = validateJob(job([{ id: "p1", name: "O", toolId: "t1", direction: "outline", stepoverMm: null, maxStepdownMm: null, allowanceMm: 0, outlineWidthMm: 10, outlineDepthMm: 38, enabled: true }]), tools, hm);
    checks.push(["outline depth>=stockTop -> error", errors.some((e) => /stock top/i.test(e))]);
  }
  {
    const { errors } = validateJob(job([{ id: "p1", name: "R", toolId: "t1", direction: "rtl", stepoverMm: null, maxStepdownMm: null, allowanceMm: 0.5, enabled: true }]), tools, hm);
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
  const passes = [{ id: "p1", name: "R", toolId: "t1", direction: "rtl", stepoverMm: null, maxStepdownMm: null, allowanceMm: 0, enabled: true }];
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

window.__tests.zigzagSinglePixelSpanUsesFeed = function () {
  const checks = [];
  const width = 6, height = 2;
  const cut = new Uint8Array(width * height);
  // Bottom row (py=1, cut first, ltr): pixels 0,1,2 (left half).
  cut[1 * width + 0] = 1; cut[1 * width + 1] = 1; cut[1 * width + 2] = 1;
  // Top row (py=0, cut second): a single isolated pixel at px=5 (far right).
  cut[0 * width + 5] = 1;
  const lines = [];
  // py=1 cuts at Z=-2; the lone py=0 pixel is shallower (Z=-1) => a RISING
  // zig-zag transition, which is the branch that used to rapid-cut it.
  const zAtFn = (px, py) => (py === 1 ? -2 : -1);
  emitRasterSweepMoves({
    lines: lines, cut: cut, width: width, height: height, pixelSizeMm: 1,
    originMode: "center", rowStep: 1, direction: "zigzag", zAtFn: zAtFn,
    safeZMm: 5, feedMmMin: 1000, plungeMmMin: 300, atSafeZ: true,
  });
  // Machine X of the isolated pixel px=5: (5 + 0.5 - 6/2) * 1 = 2.5. This X
  // appears nowhere in the bottom row (px 0,1,2 -> X -2.5,-1.5,-0.5).
  const isoX = "X2.500";
  // The pixel must be reached by a G1 cutting move, not a G0 rapid. (The F word
  // is legitimately omitted as modal when the feed is unchanged, so assert the
  // move code rather than requiring an F word.)
  const cutByFeed = lines.some((l) => l.indexOf("G1") === 0 && l.indexOf(isoX) !== -1);
  const notRapidReached = !lines.some((l) => l.indexOf("G0") === 0 && l.indexOf(isoX) !== -1);
  checks.push(["isolated single-pixel span engaged by a G1 cutting move", cutByFeed]);
  checks.push(["isolated single-pixel span not reached only by a G0 rapid", notRapidReached]);
  const pass = checks.every(([, ok]) => ok);
  return { pass, detail: { checks: checks, lines: lines } };
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
  const rpass = { id: "p1", name: "TestPass", toolId: "t1", direction: "ltr", stepoverMm: null, maxStepdownMm: null, allowanceMm: 0, enabled: true };
  const rjob = { imageName: "myimage.png", widthPx: W, heightPx: H, pixelSizeMm: 1, zeroMode: "stockTop", originMode: "lowerLeft", stockTopMm: 0, safeZMm: 5, passes: [rpass] };
  const remaining = initRemaining(heightMap, rjob.stockTopMm);
  const rasterGcode = generatePassGCode({ pass: rpass, tool: rtool, targetSurface: targetSurface, remaining: remaining, jobSpec: rjob, heightMap: heightMap, passIndex: 1, imageBase: "gold" }).gcode;
  const EXPECTED_RASTER = "; image: myimage.png\n; dimensions: 6x4 px\n; pixelSizeMm: 1  physical size: 6.000 x 4.000 mm\n; zeroMode: stockTop\n; originMode: lowerLeft\n; stockTopMm: 0\n; safeZMm: 5\n; tool: Test Tool!  shape: flat  diameterMm: 3\n; pass: TestPass  direction: ltr  stepoverMm: 1  stepdownMm: 1  allowanceMm: 0\n; spindleRpm: 12000\n; commanded Z range: -0.75 to -0.50 mm\n; sweeps: 1\nG90\nG21\nG17\nM3 S12000\nG0 X0.500 Y0.500\nG1 Z-0.500 F321\nG1 X1.500 Z-0.550 F1234\nG1 X2.500 Z-0.600\nG1 X3.500 Z-0.650\nG1 X4.500 Z-0.700\nG1 X5.500 Z-0.750\nG0 Z5.000\nG0 X0.500 Y1.500\nG1 Z-0.500 F321\nG1 X1.500 Z-0.550 F1234\nG1 X2.500 Z-0.600\nG1 X3.500 Z-0.650\nG1 X4.500 Z-0.700\nG1 X5.500 Z-0.750\nG0 Z5.000\nG0 X0.500 Y2.500\nG1 Z-0.500 F321\nG1 X1.500 Z-0.550 F1234\nG1 X2.500 Z-0.600\nG1 X3.500 Z-0.650\nG1 X4.500 Z-0.700\nG0 Z5.000\nG0 X0.500 Y3.500\nG1 Z-0.500 F321\nG1 X1.500 Z-0.550 F1234\nG1 X2.500 Z-0.600\nG1 X3.500 Z-0.650\nG1 X4.500 Z-0.700\nG0 Z5.000\nG0 Z5.000\nM5\nM2\n";
  checks.push(["raster pass GCode is byte-identical to golden", rasterGcode === EXPECTED_RASTER, rasterGcode]);

  // --- Outline fixture (small central block) ---
  const OW = 20, OH = 20;
  const ocut = new Uint8Array(OW * OH);
  for (let y = 6; y < 14; y++) for (let x = 6; x < 14; x++) ocut[y * OW + x] = 1;
  const otool = { id: "t2", name: "OutlineTool", shape: "flat", diameterMm: 2, radiusMm: 1, stepoverMm: 1, maxStepdownMm: 1, feedMmMin: 900, plungeMmMin: 250, spindleRpm: 11000 };
  const opass = { id: "p2", name: "OutlinePass", toolId: "t2", direction: "outline", stepoverMm: null, maxStepdownMm: null, allowanceMm: 0, outlineWidthMm: 1.5, outlineDepthMm: -1, enabled: true };
  const ojob = { imageName: "outline.png", pixelSizeMm: 0.5, zeroMode: "stockTop", originMode: "center", stockTopMm: 0, safeZMm: 5 };
  const outlineGcode = generateOutlinePassGCode({ pass: opass, tool: otool, cut: ocut, width: OW, height: OH, jobSpec: ojob, passIndex: 1, imageBase: "gold" }).gcode;
  const EXPECTED_OUTLINE = "; image: outline.png\n; dimensions: 20x20 px\n; pixelSizeMm: 0.5  physical size: 10.000 x 10.000 mm\n; zeroMode: stockTop\n; originMode: center\n; stockTopMm: 0\n; safeZMm: 5\n; tool: OutlineTool  shape: flat  diameterMm: 2\n; pass: OutlinePass  direction: outline  outlineWidthMm: 1.5  outlineDepthMm: -1\n; spindleRpm: 11000\n; loopCount: 3  depthLevels: 1\n; commanded Z range: -1.00 to -1.00 mm\n; depth levels: 1\nG90\nG21\nG17\nM3 S11000\nG0 X-2.796 Y2.750\nG1 Z-1.000 F250\nG1 X-1.750 Y3.200 F900\nG1 X1.750\nG1 X2.750 Y2.796\nG1 X3.200 Y1.750\nG1 Y-1.750\nG1 X2.796 Y-2.750\nG1 X1.750 Y-3.200\nG1 X-1.750\nG1 X-2.750 Y-2.796\nG1 X-3.200 Y-1.750\nG1 Y1.750\nG1 X-2.796 Y2.750\nG0 Z5.000\nG0 X-3.155 Y3.750\nG1 Z-1.000 F250\nG1 X-1.750 Y4.200 F900\nG1 X1.750\nG1 X2.750 Y3.984\nG1 X3.684 Y3.250\nG1 X4.200 Y1.750\nG1 Y-1.750\nG1 X3.984 Y-2.750\nG1 X3.250 Y-3.684\nG1 X1.750 Y-4.200\nG1 X-1.750\nG1 X-2.750 Y-3.984\nG1 X-3.684 Y-3.250\nG1 X-4.200 Y-1.750\nG1 Y1.750\nG1 X-3.984 Y2.750\nG1 X-3.155 Y3.750\nG0 Z5.000\nG0 X-3.441 Y4.750\nG1 Z-1.000 F250\nG1 X-1.750 Y5.200 F900\nG1 X2.250 Y5.163\nG1 X3.441 Y4.750\nG1 X4.557 Y3.750\nG1 X5.163 Y2.250\nG1 Y-2.250\nG1 X4.750 Y-3.441\nG1 X3.750 Y-4.557\nG1 X2.250 Y-5.163\nG1 X-2.250\nG1 X-3.441 Y-4.750\nG1 X-4.557 Y-3.750\nG1 X-5.163 Y-2.250\nG1 Y2.250\nG1 X-4.557 Y3.750\nG1 X-3.441 Y4.750\nG0 Z5.000\nG0 Z5.000\nM5\nM2\n";
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
 * single "ltr" pass, and a hand-made targetSurface Float32Array with a
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
    id: "p1", name: "TestPass", toolId: "t1", direction: "ltr",
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
  // the same row/span/x traversal generatePassGCode uses (ltr, rowStep=1)
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
 * Regression test: in "zigzag" passes, emitRasterSweepMoves must NOT retract
 * to safe Z between rows — only ltr/rtl retract per-row since they rapid all
 * the way back across the row. Instead zigzag does a minimal transition:
 * travel XY at the higher of {current Z, next-start Z}, then step to the
 * start Z (raise-then-move if the next start is raised above current, else
 * move-then-plunge).
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
 * characterization check. An "ltr" control run of the zRaise fixture
 * confirms the no-mid-sweep-retract behavior is zigzag-specific (ltr still
 * retracts once per row).
 */
window.__tests.zigzagNoSafeRetractBetweenRows = function () {
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
  const expectedRaiseZigzag = [
    "G0 X-2.000 Y-1.000",
    "G1 Z-0.400 F300",
    "G1 X-1.000 Z-0.450 F1000",
    "G1 X0.000 Z-0.500",
    "G1 X1.000 Z-0.550",
    "G1 X2.000 Z-0.600",
    "G0 Z-0.400",
    "G0 Y0.000",
    "G1 X1.000 Z-0.350",
    "G1 X0.000 Z-0.300",
    "G1 X-1.000 Z-0.250",
    "G1 X-2.000 Z-0.200",
    "G0 Z0.000",
    "G0 Y1.000",
    "G1 X-1.000 Z-0.050",
    "G1 X0.000 Z-0.100",
    "G1 X1.000 Z-0.150",
    "G1 X2.000 Z-0.200",
    "G0 Z5.000",
  ];
  const expectedPlungeZigzag = [
    "G0 X-2.000 Y-1.000",
    "G1 Z0.400 F300",
    "G1 X-1.000 Z0.350 F1000",
    "G1 X0.000 Z0.300",
    "G1 X1.000 Z0.250",
    "G1 X2.000 Z0.200",
    "G0 Y0.000",
    "G1 Z0.000 F300",
    "G1 X1.000 Z0.050 F1000",
    "G1 X0.000 Z0.100",
    "G1 X-1.000 Z0.150",
    "G1 X-2.000 Z0.200",
    "G0 Y1.000",
    "G1 Z0.000 F300",
    "G1 X-1.000 Z-0.050 F1000",
    "G1 X0.000 Z-0.100",
    "G1 X1.000 Z-0.150",
    "G1 X2.000 Z-0.200",
    "G0 Z5.000",
  ];

  const raiseZigzag = run(zRaise, "zigzag");
  const plungeZigzag = run(zPlunge, "zigzag");
  const raiseLtr = run(zRaise, "ltr");

  const arraysEqual = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);

  checks.push([
    "golden: run(zRaise, 'zigzag') matches captured expected output exactly",
    arraysEqual(raiseZigzag, expectedRaiseZigzag),
    raiseZigzag,
  ]);
  checks.push([
    "golden: run(zPlunge, 'zigzag') matches captured expected output exactly",
    arraysEqual(plungeZigzag, expectedPlungeZigzag),
    plungeZigzag,
  ]);

  // 1. zRaise/zigzag: exactly one safe retract, and it is the last line.
  const raiseZigzagRetracts = raiseZigzag.filter(isSafeRetract);
  checks.push([
    "zigzag (raise fixture): exactly 1 safe-Z retract, and it is the last line",
    raiseZigzagRetracts.length === 1 && isSafeRetract(raiseZigzag[raiseZigzag.length - 1]),
    { count: raiseZigzagRetracts.length, lastLine: raiseZigzag[raiseZigzag.length - 1] },
  ]);

  // 2. zPlunge/zigzag: exactly one safe retract, and it is the last line.
  const plungeZigzagRetracts = plungeZigzag.filter(isSafeRetract);
  checks.push([
    "zigzag (plunge fixture): exactly 1 safe-Z retract, and it is the last line",
    plungeZigzagRetracts.length === 1 && isSafeRetract(plungeZigzag[plungeZigzag.length - 1]),
    { count: plungeZigzagRetracts.length, lastLine: plungeZigzag[plungeZigzag.length - 1] },
  ]);

  // 3. ltr control: exactly 3 safe retracts (one per cut row) -> proves the
  // no-mid-sweep-retract behavior is zigzag-only.
  const raiseLtrRetracts = raiseLtr.filter(isSafeRetract);
  checks.push([
    "ltr control (raise fixture): exactly 3 safe-Z retracts (one per cut row)",
    raiseLtrRetracts.length === 3,
    { count: raiseLtrRetracts.length },
  ]);

  // 4. Raise transitions: G0 Z<non-safe> lines (the "raise first" step)
  // appear exactly twice (once per inter-row transition), and no G1 F300
  // (plunge) line occurs after the first one — raises use G0, never a plunge.
  const raiseNonSafeG0Z = raiseZigzag.filter(
    (l) => l.startsWith("G0") && /\bZ(-?\d+\.\d+)\b/.test(l) && !isSafeRetract(l)
  );
  const firstPlungeIdx = raiseZigzag.findIndex((l) => l.startsWith("G1") && /\bF300\b/.test(l));
  const laterPlunges = raiseZigzag
    .slice(firstPlungeIdx + 1)
    .filter((l) => l.startsWith("G1") && /\bF300\b/.test(l));
  checks.push([
    "zigzag (raise fixture): exactly 2 raise-transition G0 Z moves, no plunge (F300) after the initial one",
    raiseNonSafeG0Z.length === 2 && laterPlunges.length === 0,
    { raiseNonSafeG0Z, laterPlunges },
  ]);

  // 5. Plunge transitions: G1 lines carrying F300 (plunge feed) appear
  // exactly 3 times (1 initial start plunge + 2 inter-row plunges); each
  // inter-row plunge is immediately preceded by a G0 X/Y move with no Z word.
  const plungeFeedLines = [];
  plungeZigzag.forEach((l, i) => {
    if (l.startsWith("G1") && /\bF300\b/.test(l)) plungeFeedLines.push(i);
  });
  const interRowPlungeIdxs = plungeFeedLines.slice(1); // skip the initial start plunge
  const interRowPlungesPrecededByBareG0 = interRowPlungeIdxs.every((i) => {
    const prev = plungeZigzag[i - 1] || "";
    return prev.startsWith("G0") && /\bY/.test(prev) && !/\bZ/.test(prev);
  });
  checks.push([
    "zigzag (plunge fixture): exactly 3 F300 plunge lines, each inter-row one preceded by a bare G0 X/Y move",
    plungeFeedLines.length === 3 && interRowPlungesPrecededByBareG0,
    { plungeFeedLines: plungeFeedLines.map((i) => plungeZigzag[i]), interRowPlungesPrecededByBareG0 },
  ]);

  // 6. Surface following intact: the modal Z commanded for each cut pixel
  // matches zRaise at that pixel. Replays the same row/px traversal
  // emitRasterSweepMoves uses (zigzag alternates row direction, starting
  // ltr). A row's first pixel has its Z set either by the row-start G1
  // plunge line (no X word) or, for the raise-transition rows, by the
  // preceding bare "G0 Z<raise>" line (no X/Y word) — every other pixel is
  // set by an ordinary "G1 X.. Z.." cut move. So the checkpoints are: every
  // G1 line, plus every "bare" G0 line (Z word, no X/Y word — i.e. the
  // zig-zag raise, never the final safe-Z retract since that always follows
  // the last cut with no further pixel to account for).
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
  for (const line of raiseZigzag) {
    const zMatch = line.match(/\bZ(-?\d+\.\d+)\b/);
    if (zMatch) modalZForCuts = parseFloat(zMatch[1]);
    const isBareG0Z = line.startsWith("G0") && zMatch && !/\bX/.test(line) && !/\bY/.test(line) && !isSafeRetract(line);
    if ((line.startsWith("G1") || isBareG0Z) && modalZForCuts !== null) {
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
    "zigzag (raise fixture): cut-move Z values match zRaise(px, py) at each traversed pixel (<=1e-3)",
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
 * 2 rows x a 4px span each, `direction: "ltr"`, converging in a single sweep
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
    id: "p1", name: "FeedTestPass", toolId: "t1", direction: "ltr",
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
 * stopping early), generates one pass's GCode (ltr, single sweep), then
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
  // the row/span/mask logic, not multi-sweep stepping.
  const targetSurface = new Float32Array(width * height);
  for (let i = 0; i < targetSurface.length; i++) {
    targetSurface[i] = cut[i] === 1 ? -1 : -Infinity;
  }

  const tool = {
    id: "t1", name: "mask_test_tool", shape: "flat", diameterMm: 2, radiusMm: 1,
    stepoverMm: 1, maxStepdownMm: 5, feedMmMin: 1000, plungeMmMin: 300, spindleRpm: 10000,
  };
  const pass = {
    id: "p1", name: "MaskSkipPass", toolId: "t1", direction: "ltr",
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
 * exact, easy-to-predict ceil(stockTop/stepdown): with a nonzero-radius tool,
 * a row's footprint can reach rows elsewhere in the SAME sweep that haven't
 * been "cut" yet (per spec step 3 — "so lower rows' material removal is
 * visible to higher rows within the tool footprint"), which correctly
 * accelerates convergence but makes the naive ceil() formula not hold exactly
 * — that cross-row-within-a-sweep interaction is covered qualitatively by
 * roughThenFinish below instead.
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
    id: "p1", name: "RoughAll", toolId: "t1", direction: "ltr",
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
    id: "p1", name: "Rough", toolId: "t1", direction: "rtl",
    stepoverMm: null, maxStepdownMm: null, allowanceMm: 0.8, enabled: true,
  };
  const finishPass = {
    id: "p2", name: "Finish", toolId: "t2", direction: "zigzag",
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
 * `rowStep`) are cut centers driven down to target; between-row pixels are
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
  // (~0) at the center — a smooth non-flat surface so between-row pixels have
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
    id: "p1", name: "Rough", toolId: "t1", direction: "rtl",
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
    id: "p1", name: "Finish", toolId: "b1", direction: "zigzag",
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
 * with a one-line `; --- pass ...` section comment, and ends with a single
 * `G0 Z<safeZ>` retract line.
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
    id: "p1", name: "BodyTestPass", toolId: "t1", direction: "ltr",
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
