# High-Fidelity PDF → HTML Pipeline

This document describes the architecture added to the **hitl-chunking-hifi** copy of the project.
The original codebase at `human in loop chunkng ` is untouched.

---

## Why it exists

The original export pipeline wrote chunk text as verbatim plain text and then wrapped it in a
simple `<section>` with `white-space: pre-wrap`.  This is MLR-safe but loses all visual
typography: font faces, sizes, bold/italic, and exact positioning are gone.

The high-fidelity pipeline uses **PyMuPDF** (`fitz`) to extract raw text spans from the PDF
with their exact coordinates and font metadata, then reconstructs the chunk as an
**absolutely-positioned HTML layout** — each span placed at the same pixel position it occupies
on the PDF page.

---

## Prerequisites

```bash
pip install pymupdf          # installs the fitz package
node --version               # v18+ recommended
python3 --version            # 3.9+
```

If `python3` is not on `PATH`, set `PYTHON_BIN` in your environment:

```bash
PYTHON_BIN=/opt/homebrew/bin/python3 node server.js
```

---

## New and changed files

### `backend/services/fitz_extract.py`  *(new)*

Python script that opens a PDF with PyMuPDF and extracts styled text spans for any number of
bounding boxes in a single process.

**Protocol (stdio batch)**

```
stdin  → JSON array: [{pageNum: int (1-based), box: [nx1,ny1,nx2,ny2]}, ...]
stdout ← JSON array: [{page_size, clip_rect, spans}, ...]
argv[1] = absolute path to the PDF
```

Each `spans` entry:

| field  | type    | description |
|--------|---------|-------------|
| text   | string  | span text exactly as embedded in the PDF |
| x, y   | number  | top-left of the span bbox in PDF points (top-left origin) |
| w, h   | number  | span bbox dimensions in PDF points |
| font   | string  | font name from the PDF (e.g. `TimesNewRomanPS-ItalicMT`) |
| size   | number  | font size in points |
| bold   | boolean | `flags & 16` |
| italic | boolean | `flags & 2`  |
| color  | string  | rrggbb hex (without `#`) |

**Known limitation** — italic/bold detection relies on the `flags` bitmask in the PDF font
stream.  Some PDFs encode all glyphs under a single obfuscated font name (e.g. `g_d0_f1`) and
set no flags; in that case `italic` and `bold` will both be `false`.

---

### `backend/services/rich-extract.service.js`  *(new)*

Node.js wrapper that spawns `fitz_extract.py` once per export (batch), writes the requests to
`stdin`, and parses the JSON from `stdout`.

```javascript
const { extractRichBatch } = require('./services/rich-extract.service');

const results = await extractRichBatch(pdfAbsPath, [
  { pageNum: 1, box: [0.1, 0.2, 0.9, 0.5] },
  { pageNum: 2, box: [0.0, 0.0, 1.0, 0.3] },
]);
// results[i] = { page_size, clip_rect, spans }
```

Falls back gracefully: if Python is unavailable or the script throws, a rejected Promise is
returned.  The caller (`export.js`) catches and falls back to text HTML.

---

### `backend/routes/rich-extract.js`  *(new)*

REST endpoint for on-demand single-box extraction (useful for debugging or future frontend use).

```
POST /api/rich-extract
{ "pdfPath": "abc123.pdf", "pageNum": 1, "box": [0.1, 0.2, 0.9, 0.5] }
→ { page_size, clip_rect, spans }
```

`pdfPath` is resolved relative to `backend/uploads/` and must stay within that directory
(path-traversal guard).

---

### `backend/services/html-generator.service.js`  *(rewritten)*

Exports two functions:

#### `generateHtml(chunk)` — text-only fallback (unchanged contract)

Produces verbatim `<section white-space:pre-wrap>` HTML.  MLR-safe — no structural
reinterpretation.  Italic sentinels (``…``) from `pdf-extract.service.js` are
converted to `<em>` tags.

#### `generateHtmlRich(chunkMeta, richData)` — new

Produces an absolutely-positioned HTML document from PyMuPDF span data.

- Container `<div class="chunk">` matches `clip_rect.w × clip_rect.h` in CSS pixels.
- Each `<span>` is placed at `(span.x − clip_rect.x, span.y − clip_rect.y)` with
  `position:absolute`.
- Font family, size (in `pt`), bold, italic, and color are applied inline.
- **No font embedding** — the browser uses the named font or falls back to `serif`.
  Adding `@font-face` with Base64-embedded subsets is a documented future step.

---

### `backend/routes/export.js`  *(updated)*

The export route now:

1. Accepts an optional top-level `pdfPath` field in the request body.
2. If `pdfPath` is provided and the file exists, calls `extractRichBatch` once for all
   PDF-sourced chunks.
3. Uses `generateHtmlRich` for chunks where spans were returned; falls back to `generateHtml`
   for all others (media, webpage, image-only, or failed extraction).
4. Adds `html_mode: "rich" | "text"` to each entry in `metadata.json`.

---

### `backend/server.js`  *(updated)*

Registers the new `/api/rich-extract` route.

---

### `frontend-src/.../api.service.ts`  *(updated)*

`exportChunks()` now accepts an optional third parameter `pdfPath?: string` and includes it in
the POST body.

---

### `frontend-src/.../canvas-editor.component.ts`  *(updated)*

`doExport()` passes `this.state.pdfPath() ?? undefined` as the third argument to
`api.exportChunks()`.  When no PDF was loaded (image or webpage session), `pdfPath` is
`undefined` and the backend silently uses the text fallback.

---

## Fallback chain

```
Export requested
    │
    ├── pdfPath provided and file exists?
    │       Yes → extractRichBatch (PyMuPDF)
    │                │
    │                ├── success → generateHtmlRich (absolute-positioned HTML)
    │                └── failure → warn, continue ↓
    │
    └── No / fallback → generateHtml (verbatim text HTML)
```

At no point does a rich-extraction failure prevent the export from completing.

---

## Accuracy & known limitations

| Factor | Impact |
|---|---|
| Font not installed in browser | Glyphs render in fallback serif/sans — positions correct, exact shapes differ |
| Obfuscated font names in PDF | `bold`/`italic` flags may be `false` even when glyph is styled |
| Sub-pixel rounding | Coordinates rounded to 0.1 px — negligible visual difference |
| Right-to-left / vertical text | Not handled — spans will be positioned incorrectly |

For true pixel fidelity on arbitrary PDFs, font subset extraction and `@font-face` embedding
would be required.  The infrastructure (PyMuPDF is already running) makes that a straightforward
extension.
