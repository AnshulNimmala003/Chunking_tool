const express  = require('express');
const path     = require('path');
const fs       = require('fs');
// archiver is lazy-loaded inside the handler to avoid hanging on server startup
const { v4: uuidv4 } = require('uuid');
const { toFilename }   = require('../services/utils');
const { generateHtml } = require('../services/html-generator.service');
const { extractRichBatch } = require('../services/rich-extract.service');

const router = express.Router();

// POST /api/export
// Body: { sessionId?, pdfPath?, chunks: [...] }
//   pdfPath — optional; when present and the PDF exists, HTML files are rendered
//             using PyMuPDF span data (absolute-positioned, font-accurate).
//             Falls back to verbatim text HTML if rich extraction fails.
// Returns: ZIP with *.txt, *.html, *.jpeg per chunk + metadata.json
router.post('/', async (req, res) => {
  const { chunks, pdfPath } = req.body;

  if (!Array.isArray(chunks) || chunks.length === 0) {
    return res.status(400).json({ error: 'chunks[] is required and must not be empty' });
  }

  const sessionId  = uuidv4();
  const outputDir  = path.join(__dirname, '../outputs', sessionId);
  const uploadsDir = path.join(__dirname, '../uploads');
  try {
    fs.mkdirSync(outputDir, { recursive: true });
  } catch (e) {
    return res.status(500).json({ error: `Failed to create output directory: ${e.message}` });
  }

  // ── Rich HTML extraction via PyMuPDF (batch, one Python process) ─────────────
  const richMap = new Map(); // chunk.id → rich HTML string
  if (pdfPath && chunks.length) {
    const pdfAbsPath = path.join(uploadsDir, path.basename(pdfPath));
    if (fs.existsSync(pdfAbsPath)) {
      const requests = chunks.map(c => ({
        pageNum: c.pageNumber || c.page_number || 1,
        box: c.box,
      }));
      try {
        const results = await extractRichBatch(pdfAbsPath, requests);
        results.forEach((r, i) => {
          if (r && r.html) richMap.set(chunks[i].id, r.html);
        });
        console.log(`[export] fitz rich HTML ready for ${richMap.size}/${chunks.length} chunks`);
      } catch (err) {
        console.warn('[export] fitz extraction failed, falling back to plain HTML:', err.message);
      }
    } else {
      console.warn(`[export] PDF not found at ${pdfAbsPath}, using plain HTML fallback`);
    }
  }

  // ── Per-chunk file generation ────────────────────────────────────────────────
  const metadata  = [];
  const usedNames = new Map();

  const writeOps = [];

  for (const chunk of chunks) {
    const text  = (chunk.extracted_text || chunk.description || '').trim();
    const title = (chunk.title || chunk.label || `Chunk ${chunk.id}`).slice(0, 100);

    let base = toFilename(chunk.filename || chunk.title || 'chunk');
    const orig = base;
    const n = usedNames.get(orig) ?? 0;
    usedNames.set(orig, n + 1);
    if (n > 0) base = `${orig}-${n}`;

    // TXT — plain text extracted by pdfjs (same as sidebar)
    const txtName = `${base}.txt`;
    writeOps.push(fs.promises.writeFile(path.join(outputDir, txtName), text, 'utf8'));

    // HTML — rich PyMuPDF output when available, plain HTML fallback
    const htmlName  = `${base}.html`;
    const chunkMeta = {
      id:               chunk.id,
      title,
      type:             chunk.type            || 'unknown',
      text,
      page_number:      chunk.pageNumber      || chunk.page_number      || 1,
      paragraph_number: chunk.paragraphNumber ?? null,
      location_in_page: chunk.locationInPage  || null,
      bounding_box:     chunk.box,
    };
    const richHtml = richMap.get(chunk.id);
    const htmlContent = richHtml || generateHtml(chunkMeta);
    writeOps.push(fs.promises.writeFile(path.join(outputDir, htmlName), htmlContent, 'utf8'));

    // JPEG screenshot (base64 from canvas)
    let imgName = null;
    if (chunk.screenshot && typeof chunk.screenshot === 'string') {
      try {
        const base64 = chunk.screenshot.replace(/^data:image\/[a-z]+;base64,/i, '');
        imgName = `${base}.jpeg`;
        writeOps.push(
          fs.promises.writeFile(path.join(outputDir, imgName), Buffer.from(base64, 'base64'))
            .catch(e => { console.warn(`[export] Screenshot write failed for chunk ${chunk.id}:`, e.message); })
        );
      } catch (e) {
        console.warn(`[export] Screenshot encode failed for chunk ${chunk.id}:`, e.message);
        imgName = null;
      }
    }

    metadata.push({
      chunk_id:         chunk.id,
      title,
      filename:         base,
      type:             chunk.type            || 'unknown',
      page_number:      chunk.pageNumber      || chunk.page_number      || 1,
      paragraph_number: chunk.paragraphNumber ?? null,
      location_in_page: chunk.locationInPage  || null,
      bounding_box:     chunk.box,
      extracted_text:   text,
      text_file:        txtName,
      html_file:        htmlName,
      image_file:       imgName,
    });
  }

  // ── Flush all async file writes before zipping ───────────────────────────────
  try {
    await Promise.all(writeOps);
  } catch (e) {
    fs.rm(outputDir, { recursive: true, force: true }, () => {});
    return res.status(500).json({ error: `Failed to write chunk files: ${e.message}` });
  }

  // ── metadata.json ────────────────────────────────────────────────────────────
  const metaPath = path.join(outputDir, 'metadata.json');
  try {
    await fs.promises.writeFile(metaPath, JSON.stringify(metadata, null, 2));
  } catch (e) {
    fs.rm(outputDir, { recursive: true, force: true }, () => {});
    return res.status(500).json({ error: `Failed to write metadata: ${e.message}` });
  }

  // ── ZIP stream ───────────────────────────────────────────────────────────────
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition',
    `attachment; filename="chunks_${sessionId.slice(0, 8)}.zip"`);

  const archiver = require('archiver'); // lazy-loaded
  const archive = archiver('zip', { zlib: { level: 9 } });
  archive.on('error', err => {
    console.error('[export] archiver error:', err.message);
    if (!res.headersSent) {
      res.status(500).json({ error: err.message });
    } else {
      res.destroy();
    }
  });
  archive.pipe(res);

  archive.glob('*.txt',  { cwd: outputDir });
  archive.glob('*.html', { cwd: outputDir });
  archive.glob('*.jpeg', { cwd: outputDir });
  archive.file(metaPath, { name: 'metadata.json' });

  res.on('close', () => {
    setTimeout(() => {
      fs.rm(outputDir, { recursive: true, force: true }, (err) => {
        if (err) console.error(`[export] Cleanup failed for ${outputDir}:`, err.message);
      });
    }, 2000);
  });

  archive.finalize();
});

module.exports = router;
