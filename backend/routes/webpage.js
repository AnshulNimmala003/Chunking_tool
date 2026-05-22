const express = require('express');
const path    = require('path');
const { v4: uuidv4 } = require('uuid');

const { screenshotUrl }          = require('../services/webpage.service');
const { chunkWebpageByRules }    = require('../services/webpage-chunker.service');
const geminiService              = require('../services/gemini.service');
const { enrichBoxesWithOcr }     = require('../services/ocr.service');

const router = express.Router();

function isValidUrl(str) {
  try {
    const u = new URL(str);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch { return false; }
}

// POST /api/webpage
// Body: { url: string }
// Returns: { sessionId, imageUrl, imagePath, boxes[], pageTitle }
router.post('/', async (req, res) => {
  const { url, method = 'ai' } = req.body || {};

  if (!url || typeof url !== 'string' || !isValidUrl(url)) {
    return res.status(400).json({ error: 'A valid http/https URL is required' });
  }

  const uploadsDir = path.join(__dirname, '../uploads');

  try {
    // ── Rule-based: DOM semantic extraction, no LLM ──────────────────────────
    if (method === 'rule') {
      const { filename, imageUrl, title, boxes } = await chunkWebpageByRules(url, uploadsDir);
      return res.json({ sessionId: uuidv4(), imagePath: filename, imageUrl, pdfPath: null, pageTitle: title, sourceUrl: url, boxes });
    }

    // ── AI: Gemini visual analysis ────────────────────────────────────────────
    console.log(`\n[Webpage] AI chunking: ${url}`);
    const { filename, imageUrl, title } = await screenshotUrl(url, uploadsDir);
    const filePath = path.join(uploadsDir, filename);

    console.log('  [Webpage] Running Gemini visual analysis...');
    const rawBoxes = await geminiService.analyzeImage(filePath, 'image/jpeg');
    const boxes    = await enrichBoxesWithOcr(rawBoxes, filePath);

    return res.json({ sessionId: uuidv4(), imagePath: filename, imageUrl, pdfPath: null, pageTitle: title, sourceUrl: url, boxes });
  } catch (err) {
    console.error('[Webpage] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
