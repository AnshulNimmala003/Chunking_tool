const express = require('express');
const path    = require('path');
const fs      = require('fs');
const { extractTextFromRegion, pageHasTextLayer, enrichBoxesWithLocation } = require('../services/pdf-extract.service');

const router = express.Router();

// POST /api/extract-text
// Body: { pdfPath: "filename.pdf", pageNum: 1, box: [x1,y1,x2,y2] }
// Returns: { text: string, noTextLayer: boolean }
router.post('/', async (req, res) => {
  const { pdfPath, pageNum, box } = req.body;

  if (!pdfPath || !box || !Array.isArray(box) || box.length !== 4) {
    return res.status(400).json({ error: 'pdfPath and box[4] are required' });
  }

  // Sanitise path — only allow plain filenames inside /uploads
  const safeName = path.basename(pdfPath);
  if (!safeName.endsWith('.pdf') && !safeName.endsWith('.PDF')) {
    return res.status(400).json({ error: 'pdfPath must be a .pdf filename' });
  }

  const absPath = path.join(__dirname, '../uploads', safeName);
  if (!fs.existsSync(absPath)) {
    return res.status(404).json({ error: `PDF not found on server: ${safeName}` });
  }

  const page = Math.max(1, parseInt(pageNum, 10) || 1);

  try {
    const hasLayer = await pageHasTextLayer(absPath, page);
    if (!hasLayer) {
      return res.json({ text: '', noTextLayer: true, paragraph_number: null });
    }

    const [text, enriched] = await Promise.all([
      extractTextFromRegion(absPath, page, box),
      enrichBoxesWithLocation([{ box }], page, absPath)
    ]);
    const paragraph_number = enriched[0]?.paragraph_number ?? null;
    res.json({ text: text || '', noTextLayer: false, paragraph_number });
  } catch (err) {
    console.error('[extract-text]', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
