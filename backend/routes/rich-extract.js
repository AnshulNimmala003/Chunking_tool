'use strict';

const express = require('express');
const path = require('path');
const fs = require('fs');
const { extractRichBatch } = require('../services/rich-extract.service');

const router = express.Router();
const UPLOADS = path.join(__dirname, '../uploads');

/**
 * POST /api/rich-extract
 * Body: { pdfPath: string, pageNum: number, box: [nx1,ny1,nx2,ny2] }
 * Returns: { page_size, clip_rect, spans }
 *
 * Single-box convenience endpoint (wraps the batch service with one request).
 */
router.post('/', async (req, res) => {
  const { pdfPath, pageNum, box } = req.body || {};

  if (!pdfPath || typeof pdfPath !== 'string') {
    return res.status(400).json({ error: 'pdfPath is required' });
  }
  if (!Number.isInteger(pageNum) || pageNum < 1) {
    return res.status(400).json({ error: 'pageNum must be a positive integer' });
  }
  if (!Array.isArray(box) || box.length !== 4) {
    return res.status(400).json({ error: 'box must be [nx1, ny1, nx2, ny2]' });
  }

  // Prevent path traversal — require path separator after uploads dir to block sibling dirs
  const pdfAbsPath = path.resolve(UPLOADS, pdfPath);
  if (!pdfAbsPath.startsWith(UPLOADS + path.sep)) {
    return res.status(400).json({ error: 'Invalid pdfPath' });
  }
  if (!fs.existsSync(pdfAbsPath)) {
    return res.status(404).json({ error: `PDF not found: ${pdfPath}` });
  }

  try {
    const [result] = await extractRichBatch(pdfAbsPath, [{ pageNum, box }]);
    if (result.error) {
      return res.status(500).json({ error: result.error });
    }
    res.json(result);
  } catch (err) {
    console.error('[rich-extract]', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
