'use strict';

const express = require('express');
const router = express.Router();
const { generateQuestions } = require('../services/gemini.service');

router.post('/', async (req, res) => {
  const { text } = req.body;

  if (!text || typeof text !== 'string' || !text.trim()) {
    return res.status(400).json({ error: 'text is required and must be a non-empty string' });
  }
  if (text.length > 8192) {
    return res.status(400).json({ error: 'text exceeds maximum length of 8192 characters' });
  }

  try {
    const questions = await generateQuestions(text.trim());
    res.json({ questions });
  } catch (err) {
    console.error('[generate-questions] error:', err.message);
    res.status(500).json({ error: err.message || 'Failed to generate questions' });
  }
});

module.exports = router;
