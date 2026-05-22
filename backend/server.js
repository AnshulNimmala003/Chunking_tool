require('dotenv').config();

const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');

const analyzeRoutes      = require('./routes/analyze');
const exportRoutes       = require('./routes/export');
const previewRoutes      = require('./routes/preview');
const sessionRoutes      = require('./routes/session');
const extractTextRoutes  = require('./routes/extract-text');
const richExtractRoutes  = require('./routes/rich-extract');
const transcribeRoutes        = require('./routes/transcribe');
const webpageRoutes           = require('./routes/webpage');
const generateQuestionsRoutes = require('./routes/generate-questions');

const app = express();
const PORT = process.env.PORT || 3001;

// Ensure required directories exist on startup
['uploads', 'outputs'].forEach(dir => {
  const p = path.join(__dirname, dir);
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
});

app.use(cors({
  origin: 'http://localhost:4200',
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

app.listen(PORT, () => {
  const isMock = process.env.MOCK_GEMINI?.trim().toLowerCase() !== 'false';
  console.log(`\nHITL Chunking Backend → http://localhost:${PORT}`);
  console.log(`Gemini mode: ${isMock ? '🟡 MOCK' : '🟢 LIVE'}\n`);
});
