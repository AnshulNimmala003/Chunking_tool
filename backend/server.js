require('dotenv').config();

console.log('[1] dotenv OK');

const express = require('express');   console.log('[2] express OK');
const cors = require('cors');          console.log('[3] cors OK');
const path = require('path');
const fs = require('fs');              console.log('[4] fs/path OK');

const analyzeRoutes      = require('./routes/analyze');        console.log('[5] analyze OK');
const exportRoutes       = require('./routes/export');         console.log('[6] export OK');
const previewRoutes      = require('./routes/preview');        console.log('[7] preview OK');
const sessionRoutes      = require('./routes/session');        console.log('[8] session OK');
const extractTextRoutes  = require('./routes/extract-text');   console.log('[9] extract-text OK');
const richExtractRoutes  = require('./routes/rich-extract');   console.log('[10] rich-extract OK');
const transcribeRoutes        = require('./routes/transcribe');       console.log('[11] transcribe OK');
const webpageRoutes           = require('./routes/webpage');          console.log('[12] webpage OK');
const generateQuestionsRoutes = require('./routes/generate-questions'); console.log('[13] generate-questions OK');

const app = express();
const PORT = process.env.PORT || 3001;

// Ensure required directories exist on startup
['uploads', 'outputs'].forEach(dir => {
  const p = path.join(__dirname, dir);
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
});

app.use(cors({
  origin: process.env.FRONTEND_URL || 'http://localhost:4200',
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Serve uploaded originals and cropped chunks
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));
app.use('/outputs', express.static(path.join(__dirname, 'outputs')));

app.use('/api/analyze',       analyzeRoutes);
app.use('/api/export',        exportRoutes);
app.use('/api/preview',       previewRoutes);
app.use('/api/session',       sessionRoutes);
app.use('/api/extract-text',  extractTextRoutes);
app.use('/api/rich-extract',  richExtractRoutes);
app.use('/api/transcribe',    transcribeRoutes);
app.use('/api/webpage',             webpageRoutes);
app.use('/api/generate-questions',  generateQuestionsRoutes);

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    mockMode: process.env.MOCK_GEMINI?.trim().toLowerCase() !== 'false',
    timestamp: new Date().toISOString()
  });
});

const server = app.listen(PORT, () => {
  const isMock = process.env.MOCK_GEMINI?.trim().toLowerCase() !== 'false';
  console.log(`\nHITL Chunking Backend → http://localhost:${PORT}`);
  console.log(`Gemini mode: ${isMock ? 'MOCK' : 'LIVE'}\n`);
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\nERROR: Port ${PORT} is already in use.`);
    console.error(`Run this to free it:  lsof -ti :${PORT} | xargs kill -9\n`);
  } else {
    console.error('\nServer error:', err.message);
  }
  process.exit(1);
});
