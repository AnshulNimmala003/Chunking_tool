const fs = require('fs');
const path = require('path');

// Lazy-load pdfjs to avoid hanging on server startup (heavy module initialization)
let _pdfjsLib;
function getPdfjsLib() {
  if (!_pdfjsLib) {
    _pdfjsLib = require('pdfjs-dist/legacy/build/pdf.js');
    _pdfjsLib.GlobalWorkerOptions.workerSrc = false;
  }
  return _pdfjsLib;
}

// ── Shared thresholds ─────────────────────────────────────────────────────────
const SAME_LINE_RATIO  = 0.55; // ty within this × lineH → same visual line
const PARA_GAP_RATIO   = 1.8;  // gap above this × lineH → new paragraph
const FONT_HEIGHT_FLOOR = 6;   // minimum line height in PDF units

// ── Reading-order helpers ─────────────────────────────────────────────────────

/**
 * Group text items into visual lines and return them in reading order.
 *
 * Fixes two problems with the previous pairwise-comparator approach:
 *   1. Non-transitive sort — items A, B, C can all be "on the same line" pairwise
 *      yet be sorted inconsistently by Array.sort.
 *   2. Multi-column layouts — left-column items and right-column items share similar
 *      y-values, so a plain top-to-bottom sort interleaves the two columns.
 *
 * @param {Array}  items       - collected text items (in PDF user space coords)
 * @param {number} regionLeft  - left edge of the extraction region (absolute PDF units)
 * @param {number} regionRight - right edge of the extraction region (absolute PDF units)
 */
function toReadingOrder(items, regionLeft, regionRight) {
  if (!items.length) return [];

  // Step 1 — top-to-bottom (higher ty = higher on page in PDF user space)
  const byY = [...items].sort((a, b) => b.ty - a.ty);

  // Step 2 — greedy line grouping
  const lines = [];
  for (const item of byY) {
    const last   = lines[lines.length - 1];
    const lineH  = Math.max(item.fontH, last?.fontH ?? 0, FONT_HEIGHT_FLOOR);
    if (last && Math.abs(item.ty - last.ty) <= lineH * SAME_LINE_RATIO) {
      last.items.push(item);
      last.fontH = Math.max(last.fontH, item.fontH);
    } else {
      lines.push({ ty: item.ty, fontH: item.fontH, items: [item] });
    }
  }

  // Step 3 — sort each line left → right
  for (const ln of lines) ln.items.sort((a, b) => a.tx - b.tx);

  // Step 4 — two-column detection (region-relative)
  const divX = detectColumnDivider(lines, regionLeft, regionRight);
  if (!divX) return lines; // single column — already in order

  const leftLines  = [];
  const rightLines = [];
  for (const ln of lines) {
    const L = ln.items.filter(i => i.tx <  divX);
    const R = ln.items.filter(i => i.tx >= divX);
    if (L.length) leftLines.push({ ...ln, items: L });
    if (R.length) rightLines.push({ ...ln, items: R });
  }
  return [...leftLines, ...rightLines]; // left column first, then right column
}

/**
 * Return the x-coordinate splitting a two-column layout, or null for single-column.
 *
 * Critically, the histogram is built against the REGION width (not the full page
 * width). Using the full page width caused all items from a narrow bounding box to
 * cluster in 2-3 buckets; any accidental gap looked like a column divider and split
 * single-column text incorrectly.
 *
 * Extra conservatism: require ≥10 lines, a gap of ≥2 consecutive empty buckets, and
 * each column must hold ≥25% of lines.
 */
function detectColumnDivider(lines, regionLeft, regionRight) {
  if (lines.length < 10) return null;

  const regionW = regionRight - regionLeft;
  if (regionW <= 0) return null;

  const bucketW = regionW / 10;
  const hist = new Array(10).fill(0);
  for (const ln of lines) {
    // Normalise the line's left-edge relative to the region, not the full page
    const relX = (ln.items[0]?.tx ?? 0) - regionLeft;
    hist[Math.min(9, Math.max(0, Math.floor(relX / bucketW)))]++;
  }

  // Find the longest run of ≥2 empty buckets between positions 2–7 (skip page edges)
  let bestStart = -1, bestLen = 0, runStart = -1, runLen = 0;
  for (let b = 2; b <= 7; b++) {
    if (hist[b] === 0) {
      if (!runLen) runStart = b;
      runLen++;
    } else {
      if (runLen > bestLen) { bestLen = runLen; bestStart = runStart; }
      runLen = 0;
    }
  }
  if (runLen > bestLen) { bestLen = runLen; bestStart = runStart; }

  // Require a gap of at least 2 empty buckets to avoid triggering on narrow boxes
  if (bestLen < 2 || bestStart < 0) return null;

  // Convert back to absolute PDF coordinates
  const divX = regionLeft + (bestStart + bestLen / 2) * bucketW;

  const leftCount  = lines.filter(l => (l.items[0]?.tx ?? 0) <  divX).length;
  const rightCount = lines.filter(l => (l.items[0]?.tx ?? 0) >= divX).length;
  if (leftCount < lines.length * 0.25 || rightCount < lines.length * 0.25) return null;

  return divX;
}

/**
 * Reconstruct a text string from an ordered array of line objects.
 * Inserts a blank line between sections whose vertical gap exceeds 1.8× line height.
 */
function buildTextFromLines(lines) {
  const out = [];
  let prevTy = null, prevFontH = 0;

  for (const ln of lines) {
    if (prevTy !== null) {
      const vGap  = Math.abs(prevTy - ln.ty);
      const lineH = Math.max(ln.fontH, prevFontH, 6);
      if (vGap > lineH * PARA_GAP_RATIO) out.push('');
    }

    // Build a flat list of segments, inserting a space segment wherever the
    // horizontal gap between consecutive items exceeds ~10% of the font height.
    // This preserves exact word spacing as it appears in the PDF.
    const segments = [];
    for (let i = 0; i < ln.items.length; i++) {
      const item = ln.items[i];
      if (i > 0) {
        const prev = ln.items[i - 1];
        const gap  = item.tx - (prev.tx + prev.iw);
        if (gap > ln.fontH * 0.10) segments.push({ str: ' ', italic: false });
      }
      segments.push({ str: item.str, italic: !!item.italic });
    }

    // Merge adjacent same-style segments, then emit italic runs with sentinels
    // so html-generator can convert them to <em> after safe HTML escaping.
    const merged = segments.reduce((acc, seg) => {
      const last = acc[acc.length - 1];
      if (last && last.italic === seg.italic) { last.str += seg.str; }
      else acc.push({ str: seg.str, italic: seg.italic });
      return acc;
    }, []);

    out.push(merged.map(seg => seg.italic ? `${seg.str}` : seg.str).join(''));
    prevTy    = ln.ty;
    prevFontH = ln.fontH;
  }

  return out.join('\n')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// ── Main extraction ───────────────────────────────────────────────────────────

/**
 * Extract text within a normalized bounding box from a PDF page.
 *
 * @param {string} pdfAbsPath  - Absolute path to the .pdf file
 * @param {number} pageNum     - 1-based page number
 * @param {[number,number,number,number]} box - normalized [x1,y1,x2,y2] (0–1, top-left origin)
 * @returns {Promise<string>}
 */
async function extractTextFromRegion(pdfAbsPath, pageNum, box) {
  const data = new Uint8Array(await fs.promises.readFile(pdfAbsPath));
  const pdf  = await getPdfjsLib().getDocument({ data, useSystemFonts: true, disableFontFace: true }).promise;

  try {
    const page     = await pdf.getPage(pageNum);
    const viewport = page.getViewport({ scale: 1 });
    const W = viewport.width;
    const H = viewport.height;

    // Convert normalized top-left coords → PDF user space (bottom-left origin)
    const [nx1, ny1, nx2, ny2] = box;
    const rLeft   = nx1 * W;
    const rRight  = nx2 * W;
    const rBottom = (1 - ny2) * H;
    const rTop    = (1 - ny1) * H;

    // Tolerance for boundary items — small enough for PDF coordinate rounding only.
    // tX=5 was observed to pull in stray margin glyphs on dense pharmaceutical labels.
    const tX = 1;
    const tY = 2;

    const textContent = await page.getTextContent();
    const collected   = [];

    for (const item of textContent.items) {
      const raw = item.str;
      if (!raw) continue;

      // transform = [scaleX, skewX, skewY, scaleY, tx, ty]
      const [, , , scaleY, tx, ty] = item.transform;
      const fontH = Math.abs(scaleY) || 10;
      const iw    = item.width  || 0;   // still needed for column-divider detection downstream
      const ih    = Math.abs(item.height) || fontH;

      const itemCenterX = tx + iw / 2;
      const itemCenterY = ty + ih / 2;

      // Left boundary: use the item's left edge (tx), not its center. Narrow
      // items (table numbers, single chars) whose tx is just at rLeft would
      // pass a center check even though they physically start outside the box.
      // Right boundary: center check is fine — wide items that start inside
      // but extend past the right edge should still be included.
      // Y: center check on both sides handles typical line-height rounding.
      const overlaps =
        tx             >= rLeft   - tX &&
        itemCenterX    <  rRight  + tX &&
        itemCenterY    >  rBottom - tY &&
        itemCenterY    <  rTop    + tY;

      const italic = /italic|oblique/i.test(item.fontName || '');
      if (overlaps) collected.push({ str: raw, tx, ty, iw, fontH, italic });
    }

    if (!collected.length) return '';

    // Pass region bounds (not page width) so column detection is calibrated to the
    // actual extraction area rather than the full page.
    const orderedLines = toReadingOrder(collected, rLeft, rRight);
    return buildTextFromLines(orderedLines);
  } finally {
    await pdf.destroy();
  }
}

/**
 * Returns true if the PDF page has any selectable text.
 */
async function pageHasTextLayer(pdfAbsPath, pageNum) {
  const data = new Uint8Array(await fs.promises.readFile(pdfAbsPath));
  const pdf  = await getPdfjsLib().getDocument({ data, useSystemFonts: true, disableFontFace: true }).promise;
  try {
    const page = await pdf.getPage(pageNum);
    const tc   = await page.getTextContent();
    // Require at least a few non-whitespace characters — some PDFs embed invisible
    // zero-width spaces as "text" which would give a false positive
    const totalChars = tc.items.reduce((acc, i) => acc + (i.str?.trim().length ?? 0), 0);
    return totalChars >= 3;
  } finally {
    await pdf.destroy();
  }
}

/**
 * Derive the original .pdf filename from a rendered JPEG filename.
 * e.g.  "abc123_p2.jpg"  →  "abc123.pdf"
 */
function pdfPathFromImagePath(imageFilename) {
  const m = imageFilename.match(/^(.+?)_p\d+\.(jpg|jpeg|png|webp)$/i);
  if (!m) return null;
  return m[1] + '.pdf';
}

/**
 * Build a list of paragraph y-centers (normalized 0-1, top-left origin) for a full page.
 * Uses the same line-grouping and paragraph-gap logic as extractTextFromRegion.
 */
async function getParagraphCenters(pdfAbsPath, pageNum) {
  const data = new Uint8Array(await fs.promises.readFile(pdfAbsPath));
  const pdf  = await getPdfjsLib().getDocument({ data, useSystemFonts: true, disableFontFace: true }).promise;

  let H, tcItems;
  try {
    const page = await pdf.getPage(pageNum);
    H       = page.getViewport({ scale: 1 }).height;
    const tc = await page.getTextContent();
    tcItems  = tc.items;
  } finally {
    await pdf.destroy();
  }

  const items = [];
  for (const item of tcItems) {
    if (!item.str?.trim()) continue;
    const [, , , scaleY, , ty] = item.transform;
    items.push({ ty, fontH: Math.abs(scaleY) || 10 });
  }
  if (!items.length) return [];

  // Top-to-bottom (higher ty = closer to top in PDF user space)
  items.sort((a, b) => b.ty - a.ty);

  // Group into lines (same threshold as toReadingOrder)
  const lines = [];
  for (const item of items) {
    const last   = lines[lines.length - 1];
    const lineH  = Math.max(item.fontH, last?.fontH ?? 0, FONT_HEIGHT_FLOOR);
    if (last && Math.abs(item.ty - last.ty) <= lineH * SAME_LINE_RATIO) {
      last.fontH = Math.max(last.fontH, item.fontH);
    } else {
      lines.push({ ty: item.ty, fontH: item.fontH });
    }
  }

  // Group lines into paragraphs (same gap threshold as buildTextFromLines)
  const paragraphs = [];
  let paraTopTy = null, paraBottomTy = null;
  let prevTy = null, prevFontH = 0;

  for (const ln of lines) {
    const vGap  = prevTy !== null ? Math.abs(prevTy - ln.ty) : 0;
    const lineH = Math.max(ln.fontH, prevFontH, FONT_HEIGHT_FLOOR);
    if (prevTy === null || vGap > lineH * PARA_GAP_RATIO) {
      if (paraTopTy !== null) paragraphs.push({ topTy: paraTopTy, bottomTy: paraBottomTy });
      paraTopTy    = ln.ty;
      paraBottomTy = ln.ty;
    } else {
      paraBottomTy = ln.ty;
    }
    prevTy    = ln.ty;
    prevFontH = ln.fontH;
  }
  if (paraTopTy !== null) paragraphs.push({ topTy: paraTopTy, bottomTy: paraBottomTy });

  // Convert to normalized y-center (top-left origin: normalizedY = 1 - ty/H)
  return paragraphs.map((p, i) => ({
    index:   i + 1,
    yCenter: 1 - ((p.topTy + p.bottomTy) / 2) / H
  }));
}

/**
 * Adds page_number, paragraph_number, and location_in_page to every box.
 *
 * paragraph_number — 1-based index of the nearest text paragraph on the page
 *   (by vertical center distance). Null when no PDF is available.
 * location_in_page — coarse 3×3 grid label, e.g. "top-left", "middle-center".
 */
async function enrichBoxesWithLocation(boxes, pageNum, pdfAbsPath) {
  let paragraphs = [];
  if (pdfAbsPath) {
    try { paragraphs = await getParagraphCenters(pdfAbsPath, pageNum); } catch {}
  }

  return boxes.map(box => {
    const [x1, y1, x2, y2] = box.box;
    const cx = (x1 + x2) / 2;
    const cy = (y1 + y2) / 2;
    const vZone = cy < 0.33 ? 'top'    : cy < 0.67 ? 'middle' : 'bottom';
    const hZone = cx < 0.33 ? 'left'   : cx < 0.67 ? 'center' : 'right';

    let paragraph_number = null;
    if (paragraphs.length) {
      let minDist = Infinity;
      for (const p of paragraphs) {
        const d = Math.abs(cy - p.yCenter);
        if (d < minDist) { minDist = d; paragraph_number = p.index; }
      }
    }

    return { ...box, page_number: pageNum, paragraph_number, location_in_page: `${vZone}-${hZone}` };
  });
}

module.exports = { extractTextFromRegion, pageHasTextLayer, pdfPathFromImagePath, enrichBoxesWithLocation };
