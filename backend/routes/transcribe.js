const express = require('express');
const multer  = require('multer');
const path    = require('path');
const { v4: uuidv4 } = require('uuid');

const { analyzeAudio } = require('../services/audio.service');
const { analyzeVideo } = require('../services/video.service');

const router = express.Router();

const AUDIO_TYPES = new Set([
  'audio/mpeg', 'audio/mp3', 'audio/wav', 'audio/wave', 'audio/x-wav',
  'audio/mp4', 'audio/m4a', 'audio/x-m4a', 'audio/ogg', 'audio/webm',
  'audio/flac', 'audio/aac', 'audio/x-aac'
]);

const VIDEO_TYPES = new Set([
  'video/mp4', 'video/mpeg', 'video/webm', 'video/quicktime',
  'video/x-msvideo', 'video/x-matroska'
]);

const storage = multer.diskStorage({
  destination: path.join(__dirname, '../uploads'),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, `${uuidv4()}${ext}`);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: (parseInt(process.env.MAX_MEDIA_MB) || 200) * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (AUDIO_TYPES.has(file.mimetype) || VIDEO_TYPES.has(file.mimetype)) return cb(null, true);
    // Some browsers report generic types — allow by extension too
    const ext = path.extname(file.originalname).toLowerCase();
    const audioExts = new Set(['.mp3','.wav','.m4a','.ogg','.flac','.aac','.weba']);
    const videoExts = new Set(['.mp4','.mov','.webm','.avi','.mkv','.mpeg','.mpg']);
    if (audioExts.has(ext) || videoExts.has(ext)) return cb(null, true);
    cb(new Error('Only audio and video files are accepted'));
  }
});

// POST /api/transcribe
// Body: multipart/form-data with field "media"
// Returns: { chunks[], mediaType, duration, fileName }
router.post('/', upload.single('media'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file provided' });

  const filePath    = req.file.path;
  const mimeType    = req.file.mimetype;
  const fileName    = req.file.originalname;
  const uploadsDir  = path.join(__dirname, '../uploads');

  const isVideo = VIDEO_TYPES.has(mimeType) ||
    ['.mp4','.mov','.webm','.avi','.mkv','.mpeg','.mpg'].includes(
      path.extname(req.file.originalname).toLowerCase()
    );

  const mediaType = isVideo ? 'video' : 'audio';

  try {
    console.log(`\n[Transcribe] ${mediaType.toUpperCase()}: ${fileName} (${Math.round(req.file.size/1024)}KB)`);

    const result = isVideo
      ? await analyzeVideo(filePath, uploadsDir)
      : await analyzeAudio(filePath);

    res.json({
      chunks:    result.chunks,
      mediaType,
      duration:  result.duration,
      fileName,
      fullText:  result.fullText || ''
    });
  } catch (err) {
    console.error('[Transcribe] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
