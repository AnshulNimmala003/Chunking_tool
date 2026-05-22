const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const { execFile } = require('child_process');
const geminiService = require('../services/gemini.service');
const { extractTextFromRegion, pdfPathFromImagePath, enrichBoxesWithLocation } = require('../services/pdf-extract.service');
const { enrichBoxesWithOcr } = require('../services/ocr.service');

const router = express.Router();

const storage = multer.diskStorage({
  destination: path.join(__dirname, '../uploads'),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, `${uuidv4()}${ext}`);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: (parseInt(process.env.MAX_UPLOAD_MB) || 20) * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = [
      'image/jpeg', 'image/png', 'image/webp', 'image/gif',
      'application/pdf',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/msword'
    ];
    if (allowed.includes(file.mimetype)) return cb(null, true);
    cb(new Error('Only images, PDF, and Word files are accepted'));
  }
});

/**
 * Enrich boxes with extracted_text from the PDF (replaces Gemini's text_content).
 * pdfFilename may be null for plain images — returns boxes unchanged in that case.
 */
async function enrichBoxesWithPdfText(boxes, pdfFilename, pageNum, uploadsDir) {
  if (!pdfFilename) return boxes;
  const pdfAbsPath = path.join(uploadsDir, pdfFilename);
  if (!fs.existsSync(pdfAbsPath)) return boxes;

  return Promise.all(boxes.map(async (box) => {
    try {
      const text = await extractTextFromRegion(pdfAbsPath, pageNum, box.box);
      return { ...box, text_content: text };
    } catch (e) {
      console.warn(`[analyze] text extraction failed for box ${box.id}:`, e.message);
      return { ...box, text_content: '' };
    }
  }));
}

/**
 * Use Ghostscript to render a specific PDF page to PNG (lossless).
 */
function renderPdfPage(pdfPath, outputPath, pageNum, dpi = 200) {
  return new Promise((resolve, reject) => {
    execFile('gs', [
      '-dNOPAUSE', '-dBATCH', '-dSAFER',
      '-sDEVICE=png16m',
      `-r${dpi}`,
      `-dFirstPage=${pageNum}`,
      `-dLastPage=${pageNum}`,
      `-sOutputFile=${outputPath}`,
      pdfPath
    ], { stdio: 'pipe' }, (err, _stdout, stderr) => {
      if (err) reject(new Error(`Ghostscript error: ${stderr?.slice(0, 300) || err.message}`));
      else resolve();
    });
  });
}

// POST /api/analyze
// Body: multipart/form-data with field "image"
// Returns: { sessionId, boxes: [{ id, box: [x1,y1,x2,y2], label, summary }] }
router.post('/', upload.single('image'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No file provided' });
  }

  let processingPath = req.file.path;
  let processingMimeType = req.file.mimetype;
  let processingFilename = req.file.filename;

  let pdfFilename = null; // original PDF filename, returned for text extraction
  let pageParam   = 1;
  let renderedPngPath = null; // track GS-rendered PNG so we can clean up on error

  try {
    // ─── Handle PDF Conversion ──────────────────────────────────────────────
    if (req.file.mimetype === 'application/pdf') {
      pageParam = Math.max(1, parseInt(req.body.page, 10) || 1);
      const imgFilename = `${path.basename(req.file.filename, path.extname(req.file.filename))}_p${pageParam}.png`;
      const imgPath = path.join(__dirname, '../uploads', imgFilename);

      console.log(`  [Backend] Rendering PDF page ${pageParam} with Ghostscript...`);
      await renderPdfPage(path.resolve(req.file.path), imgPath, pageParam);

      renderedPngPath    = imgPath;
      pdfFilename        = req.file.filename;
      processingPath     = imgPath;
      processingMimeType = 'image/png';
      processingFilename = imgFilename;
    }
    // ─── Handle Word (Docx) ─────────────────────────────────────────────────
    else if (req.file.mimetype.includes('word') || req.file.mimetype.includes('msword')) {
      return res.status(400).json({
        error: 'Word documents are not yet supported for visual chunking. Please save as PDF first for the best experience.'
      });
    }

    const sessionId   = uuidv4();
    const rawBoxes    = await geminiService.analyzeImage(processingPath, processingMimeType);
    const uploadsDir  = path.join(__dirname, '../uploads');
    const pdfEnriched = await enrichBoxesWithPdfText(rawBoxes, pdfFilename, pageParam, uploadsDir);
    const ocrBoxes    = await enrichBoxesWithOcr(pdfEnriched, processingPath);
    const pdfAbsPath  = pdfFilename ? path.join(uploadsDir, pdfFilename) : null;
    const boxes       = await enrichBoxesWithLocation(ocrBoxes, pageParam, pdfAbsPath);

    res.json({
      sessionId,
      imagePath:  processingFilename,
      imageUrl:   `/uploads/${processingFilename}`,
      pdfPath:    pdfFilename,
      boxes
    });
  } catch (err) {
    console.error('Analyze error:', err.message);
    if (renderedPngPath) fs.promises.unlink(renderedPngPath).catch(() => {});
    res.status(500).json({ error: err.message });
  }
});

// POST /api/analyze/by-path
// Body: { imagePath: "uuid_p2.jpg" }  (filename inside uploads/)
// Analyzes an image that was already rendered server-side (e.g. by /api/preview).
// Avoids re-uploading large PDFs on every analyze click.
router.post('/by-path', async (req, res) => {
  const { imagePath } = req.body || {};
  if (!imagePath || typeof imagePath !== 'string') {
    return res.status(400).json({ error: 'imagePath is required and must be a plain filename' });
  }

  const uploadsDir = path.join(__dirname, '../uploads');
  const filePath = path.join(uploadsDir, path.basename(imagePath));

  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: `Image not found on server: ${imagePath}` });
  }

  try {
    const ext = path.extname(imagePath).toLowerCase();
    const mimeMap = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp' };
    const mimeType = mimeMap[ext] || 'image/jpeg';

    // Derive original PDF path from rendered image filename (e.g. uuid_p2.jpg → uuid.pdf)
    const pdfFilename = pdfPathFromImagePath(path.basename(imagePath));
    const pageMatch   = imagePath.match(/_p(\d+)\./);
    const pageNum     = pageMatch ? parseInt(pageMatch[1], 10) : 1;

    const sessionId  = uuidv4();
    const rawBoxes   = await geminiService.analyzeImage(filePath, mimeType);
    const uploadsDir = path.join(__dirname, '../uploads');
    const pdfEnriched = await enrichBoxesWithPdfText(rawBoxes, pdfFilename, pageNum, uploadsDir);
    const ocrBoxes   = await enrichBoxesWithOcr(pdfEnriched, filePath);
    const pdfAbsPath = pdfFilename ? path.join(uploadsDir, pdfFilename) : null;
    const boxes      = await enrichBoxesWithLocation(ocrBoxes, pageNum, pdfAbsPath);

    res.json({
      sessionId,
      imagePath,
      imageUrl: `/uploads/${path.basename(imagePath)}`,
      pdfPath:  pdfFilename,
      boxes
    });
  } catch (err) {
    console.error('Analyze by-path error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
