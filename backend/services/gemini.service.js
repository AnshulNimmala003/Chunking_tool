const fs = require('fs');
const { MOCK_BOXES, toFilename } = require('./utils');

function friendlyGeminiError(msg) {
  if (!msg) return 'Gemini API error';
  if (msg.includes('429') || msg.includes('quota') || msg.includes('RESOURCE_EXHAUSTED')) {
    return 'Gemini free-tier quota exhausted for all available models. ' +
      'Wait ~1 minute and retry, or add billing to your Google AI project at https://ai.google.dev. ' +
      'Tip: set MOCK_GEMINI=true in backend/.env to use mock mode for development.';
  }
  if (msg.includes('401') || msg.includes('403') || msg.includes('API key')) {
    return 'Invalid Gemini API key. Check GEMINI_API_KEY in backend/.env.';
  }
  return `Gemini error: ${msg.slice(0, 200)}`;
}

// ─── Convert Gemini raw [ymin,xmin,ymax,xmax] 0-1000 to [x1,y1,x2,y2] 0-1 ──
function convertGeminiBoxes(rawBoxes) {
  return rawBoxes.map(item => {
    const [ymin, xmin, ymax, xmax] = item.box;
    return {
      type:         item.type  || 'unknown',
      title:        item.title || item.label || 'Untitled Section',
      filename:     toFilename(item.title || item.label || 'untitled-section'),
      summary:      '',
      text_content: '',
      label:        item.type  || item.label || 'unknown',
      box: [xmin / 1000, ymin / 1000, xmax / 1000, ymax / 1000]
    };
  });
}

// ─── Post-processing: clamp and remove degenerate boxes ──────────────────────
function postProcess(boxes) {
  const MIN_SPAN = 0.015;

  return boxes
    .map(b => {
      const [x1, y1, x2, y2] = b.box.map(v => Math.max(0, Math.min(1, v)));
      return { ...b, box: [x1, y1, x2, y2] };
    })
    .filter(b => {
      const [x1, y1, x2, y2] = b.box;
      return (x2 - x1) >= MIN_SPAN && (y2 - y1) >= MIN_SPAN;
    })
    .filter(b => b.title); // only require title, not summary
}

// ─── Gemini prompt ────────────────────────────────────────────────────────────
const GEMINI_PROMPT = `You are a document layout analyzer that performs contextual chunking for RAG pipelines.

TASK: Identify meaningful contextual chunks in this document and return bounding boxes for each.
Each chunk should represent a self-contained unit of meaning useful for retrieval.

═══ RULES ═══
1. Output ONLY a valid JSON array. No markdown fences, no explanation, no trailing text.
2. "box" format: [ymin, xmin, ymax, xmax] — four integers in range 0–1000 (normalized; 0=top/left, 1000=bottom/right).
3. Minimum box size: each dimension must span at least 30 units.
4. Overlapping chunks ARE allowed — a heading can overlap with its section body if that improves retrieval context.
5. Cover ALL meaningful content. Prioritise headings, paragraphs, tables, and figures.
6. You do NOT need to extract text — focus only on identifying the right boundaries.

═══ CHUNK TYPES ═══
"header"      — Section heading, document title, subtitle
"text"        — Paragraph, body text, bullet list, footnote
"chart"       — Any chart or graph (include title + legend in the same box)
"table"       — Data table (include caption)
"diagram"     — Flowchart, process diagram, org chart, timeline
"infographic" — KPI card, metric tile, dashboard widget
"image"       — Photograph, illustration, logo

═══ CONTEXTUAL CHUNKING GUIDELINES ═══
• Prefer larger, context-rich chunks over many tiny fragments
• A section heading + its first paragraph = valid overlapping pair (both are useful chunks)
• Tables should be one chunk (do not split rows)
• Multi-column layouts: chunk each column independently

═══ OUTPUT FORMAT ═══
[
  {
    "type": "<one of the 7 types above>",
    "title": "<5–8 word descriptive title for this chunk>",
    "box": [ymin, xmin, ymax, xmax]
  }
]

Now analyze the image and return the JSON array:`;

// ─── JSON repair: handles curly quotes, trailing commas, and markdown fences ──
function repairJson(raw) {
  // Strip markdown code fences Gemini sometimes wraps around responses
  let s = raw.replace(/^\s*```(?:json)?\n?/im, '').replace(/\n?```\s*$/im, '').trim();

  // Attempt 1 — clean text as-is
  try { return JSON.parse(s); } catch {}

  // Attempt 2 — replace curly/smart quotes with straight ASCII quotes
  s = s
    .replace(/[‘’ʼ]/g, "'")   // ' '
    .replace(/[“”„]/g, '"');   // " " „
  try { return JSON.parse(s); } catch {}

  // Attempt 3 — strip trailing commas before ] or }
  s = s.replace(/,(\s*[}\]])/g, '$1');
  try { return JSON.parse(s); } catch {}

  // Attempt 4 — extract just the outermost [ ... ] array
  const arrMatch = s.match(/\[[\s\S]*\]/);
  if (arrMatch) { try { return JSON.parse(arrMatch[0]); } catch {} }

  throw new SyntaxError(`Gemini returned unparseable JSON. Snippet: ${s.slice(0, 120)}`);
}

const CACHE_MAX = 100;
const cache = new Map();

async function fileHash(filePath) {
  const crypto = require('crypto');
  const buf = await fs.promises.readFile(filePath);
  return crypto.createHash('sha256').update(buf).digest('hex').slice(0, 16);
}

// ─── Main analyze function ────────────────────────────────────────────────────
async function analyzeImage(imagePath, mimeType) {
  const useMock = process.env.MOCK_GEMINI?.trim().toLowerCase() !== 'false';

  if (useMock) {
    console.log('  [Gemini] MOCK mode — returning semantic mock boxes');
    await new Promise(r => setTimeout(r, 700));
    return MOCK_BOXES.map((b, i) => ({ id: `box_${i + 1}`, ...b, filename: toFilename(b.title) }));
  }

  // Check cache
  const hash = await fileHash(imagePath);
  if (cache.has(hash)) {
    console.log(`  [Gemini] Cache hit for ${hash}`);
    return cache.get(hash);
  }

  // Real Gemini call
  const { GoogleGenerativeAI } = require('@google/generative-ai');
  const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

  const imageData = await fs.promises.readFile(imagePath);
  const base64 = imageData.toString('base64');

  // Try models in order; fall back to mock if all fail
  const MODEL_CHAIN = [
    'gemini-2.0-flash',
    'gemini-2.0-flash-lite',
    'gemini-2.0-flash-001',
    'gemini-1.5-flash-latest',
    'gemini-1.5-flash',
    'gemini-1.5-pro-latest'
  ];

  const requestPayload = {
    contents: [{
      role: 'user',
      parts: [
        { inlineData: { data: base64, mimeType } },
        { text: GEMINI_PROMPT }
      ]
    }]
  };

  let raw;
  let lastErr;
  let anyQuotaHit = false;

  for (const modelName of MODEL_CHAIN) {
    const model = genAI.getGenerativeModel({ model: modelName });
    console.log(`  [Gemini] Trying ${modelName} (${Math.round(imageData.length / 1024)} KB)...`);
    try {
      const result = await model.generateContent(requestPayload);
      const text = result.response.text().trim();
      console.log(`  [Gemini] ${modelName} responded (${text.length} chars)`);
      raw = repairJson(text);
      break;
    } catch (err) {
      lastErr = err;
      const msg = err.message || '';
      if (msg.includes('429') || msg.includes('quota') || msg.includes('RESOURCE_EXHAUSTED')) {
        console.warn(`  [Gemini] ${modelName} quota exceeded, trying next model...`);
        anyQuotaHit = true;
        continue;
      }
      if (msg.includes('404') || msg.includes('not found') || msg.includes('is not supported')) {
        console.warn(`  [Gemini] ${modelName} not available, trying next model...`);
        continue;
      }
      // Auth errors or unexpected failures — fail immediately
      console.error(`  [Gemini] Fatal error from ${modelName}:`, msg.slice(0, 200));
      throw new Error(friendlyGeminiError(msg));
    }
  }

  if (!raw) {
    const lastMsg = lastErr?.message || '';
    if (lastMsg.includes('401') || lastMsg.includes('403') || lastMsg.includes('API_KEY')) {
      throw new Error(friendlyGeminiError(lastMsg));
    }
    // Quota exhausted or all models unavailable — throw so the UI shows an actionable error
    // instead of silently overlaying unrelated mock boxes on the user's document.
    throw new Error(
      'All Gemini models are quota-limited or unavailable right now. ' +
      'Wait ~1 minute and retry, or add billing to your Google AI project at https://ai.google.dev. ' +
      'Tip: set MOCK_GEMINI=true in backend/.env to test with placeholder boxes.'
    );
  }

  const converted = convertGeminiBoxes(Array.isArray(raw) ? raw : raw.sections || raw.regions || []);
  const processed = postProcess(converted);
  const boxes = processed.map((b, i) => ({ id: `box_${i + 1}`, ...b }));

  console.log(`  [Gemini] Returning ${boxes.length} boxes after post-processing`);
  cache.set(hash, boxes);
  if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
  return boxes;
}

// ─── Question Generation ──────────────────────────────────────────────────────
async function generateQuestions(text) {
  const useMock = process.env.MOCK_GEMINI?.trim().toLowerCase() !== 'false';

  if (useMock) {
    console.log('  [Gemini] MOCK mode — returning stub questions');
    await new Promise(r => setTimeout(r, 400));
    return [
      'What is the main topic described in this section?',
      'What key terms or concepts are introduced here?',
      'How does this content relate to the broader document?',
      'What action or conclusion does this passage support?'
    ];
  }

  const { GoogleGenerativeAI } = require('@google/generative-ai');
  const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

  const prompt = `You are a question-generation assistant. Given the following text passage, generate 3 to 4 concise questions that can be answered directly from the passage. Each question must be at most 20 words. Return ONLY valid JSON in this exact shape: { "questions": ["...", "...", "..."] }

Passage:
${text}`;

  const MODEL_CHAIN = ['gemini-2.0-flash', 'gemini-2.0-flash-lite', 'gemini-1.5-flash-latest'];
  const CALL_TIMEOUT_MS = 25000;
  let lastErr;

  for (const modelName of MODEL_CHAIN) {
    // No responseMimeType — some models hang when JSON mode is enforced.
    // repairJson handles the parsing instead.
    const model = genAI.getGenerativeModel({ model: modelName });
    console.log(`  [Gemini] Trying ${modelName} for question generation...`);
    try {
      const callPromise = model.generateContent(prompt);
      let timeoutId;
      const timeoutPromise = new Promise((_, reject) => {
        timeoutId = setTimeout(() => reject(new Error('Gemini call timed out after 25s')), CALL_TIMEOUT_MS);
      });
      const result = await Promise.race([callPromise, timeoutPromise]);
      clearTimeout(timeoutId);
      const raw = result.response.text().trim();
      console.log(`  [Gemini] ${modelName} responded (${raw.length} chars)`);
      const parsed = repairJson(raw);
      const questions = Array.isArray(parsed) ? parsed
        : Array.isArray(parsed.questions) ? parsed.questions : [];
      if (!questions.length) console.warn(`  [Gemini] ${modelName} returned no questions. Raw: ${raw.slice(0, 120)}`);
      return questions.slice(0, 4);
    } catch (err) {
      lastErr = err;
      const msg = err.message || '';
      if (msg.includes('timed out')) {
        console.warn(`  [Gemini] ${modelName} timed out, trying next...`);
        continue;
      }
      if (msg.includes('429') || msg.includes('quota') || msg.includes('RESOURCE_EXHAUSTED')) {
        console.warn(`  [Gemini] ${modelName} quota exceeded, trying next...`);
        continue;
      }
      if (msg.includes('404') || msg.includes('not found') || msg.includes('is not supported')) {
        console.warn(`  [Gemini] ${modelName} not available, trying next...`);
        continue;
      }
      throw new Error(friendlyGeminiError(msg));
    }
  }

  throw new Error(friendlyGeminiError(lastErr?.message || 'All Gemini models unavailable'));
}

module.exports = { analyzeImage, generateQuestions };
