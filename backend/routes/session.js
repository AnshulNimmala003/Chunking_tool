const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');

const router = express.Router();

const storage = multer.diskStorage({
  destination: path.join(__dirname, '../uploads'),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, `${uuidv4()}${ext}`);
  }
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

// POST /api/session/create — upload image and create a session without Gemini analysis
router.post('/create', upload.single('image'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file provided' });
  res.json({
    sessionId: uuidv4(),
    imagePath: req.file.filename,
    imageUrl: `/uploads/${req.file.filename}`
  });
});

// POST /api/session/create-by-path — create session for an image already on the server
router.post('/create-by-path', (req, res) => {
  const { imagePath } = req.body || {};
  if (!imagePath || typeof imagePath !== 'string' || imagePath.includes('..')) {
    return res.status(400).json({ error: 'imagePath is required and must be a plain filename' });
  }
  const filePath = path.join(__dirname, '../uploads', path.basename(imagePath));
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'Image not found on server' });
  }
  res.json({
    sessionId: uuidv4(),
    imagePath,
    imageUrl: `/uploads/${path.basename(imagePath)}`
  });
});

module.exports = router;
