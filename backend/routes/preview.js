const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const { execFile } = require('child_process');

const router = express.Router();

const storage = multer.diskStorage({
  destination: path.join(__dirname, '../uploads'),
  filename: (req, file, cb) => cb(null, `${uuidv4()}${path.extname(file.originalname)}`)
});

const ALLOWED_MIMES = [
  'image/jpeg', 'image/png', 'image/webp', 'image/gif',
  'application/pdf'
];

const upload = multer({
  storage,
  limits: { fileSize: (parseInt(process.env.MAX_UPLOAD_MB) || 20) * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (ALLOWED_MIMES.includes(file.mimetype)) return cb(null, true);
    cb(new Error('Only images and PDF files are accepted'));
  }
});

const MAX_PAGES = 50;

/**
 * Use Ghostscript to render a PDF page to PNG (lossless).
 * Returns the output file path.
 */
function renderPdfPage(pdfPath, outputPath, pageNum, dpi = 300) {
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

function fileHash(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('md5');
    fs.createReadStream(filePath)
      .on('data', chunk => hash.update(chunk))
      .on('end', () => resolve(hash.digest('hex')))
      .on('error', reject);
  });
}

// POST /api/preview
// Converts a PDF (all pages) or passes through an image.
// Returns:
//   { imageUrl, imagePath, totalPages, pages: [{page, imageUrl, imagePath}] }
router.post('/', upload.single('image'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file provided' });

  try {
    if (req.file.mimetype !== 'application/pdf') {
      // Plain image — just return it directly
      return res.json({
        imageUrl: `/uploads/${req.file.filename}`,
        imagePath: req.file.filename,
        totalPages: 1,
        pages: [{ page: 1, imageUrl: `/uploads/${req.file.filename}`, imagePath: req.file.filename }]
      });
    }

    const pdfPath = path.resolve(req.file.path);
    const baseName = path.basename(req.file.filename, path.extname(req.file.filename));
    const uploadsDir = path.join(__dirname, '../uploads');
    const savedPages = [];

    console.log(`  [Preview] Rendering PDF with Ghostscript: ${req.file.originalname}`);

    // Render pages one by one until Ghostscript signals end-of-file.
    // Safety net: if GS silently re-renders the last page for out-of-range requests
    // (instead of erroring), the content hash will match the previous page → stop.
    let prevHash = '';
    for (let i = 1; i <= MAX_PAGES; i++) {
      const outName = `${baseName}_p${i}.png`;
      const outPath = path.join(uploadsDir, outName);

      try {
        await renderPdfPage(pdfPath, outPath, i);

        if (!fs.existsSync(outPath) || fs.statSync(outPath).size < 2000) {
          break;
        }

        const hash = await fileHash(outPath);
        if (hash === prevHash) {
          fs.unlinkSync(outPath);
          break;
        }
        prevHash = hash;

        savedPages.push({
          page: i,
          imageUrl: `/uploads/${outName}`,
          imagePath: outName
        });
        console.log(`  [Preview] Page ${i} → ${outName}`);
      } catch (err) {
        // GS throws when page number exceeds document length
        console.log(`  [Preview] Finished at page ${i - 1} (${err.message.slice(0, 60)})`);
        break;
      }
    }

    if (savedPages.length === 0) {
      throw new Error('Could not render any pages from this PDF. Ensure it is not encrypted or corrupted.');
    }

    console.log(`  [Preview] Done — ${savedPages.length} pages rendered.`);

    // Include pdfPath so the frontend can request coordinate-based text extraction
    const pdfFilename = req.file.filename;
    res.json({
      imageUrl:   savedPages[0].imageUrl,
      imagePath:  savedPages[0].imagePath,
      pdfPath:    pdfFilename,
      totalPages: savedPages.length,
      pages:      savedPages.map(p => ({ ...p, pdfPath: pdfFilename }))
    });
  } catch (err) {
    console.error('  [Preview Error]:', err.message);
    res.status(500).json({ error: `PDF preview failed: ${err.message}` });
  }
});

module.exports = router;
