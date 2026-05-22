const fs = require('fs');

const VISUAL_TYPES = new Set(['chart', 'infographic', 'diagram', 'image']);

const OCR_PROMPTS = {
  chart:
    'This is a chart or graph. Extract ALL text exactly as it appears: the title, ' +
    'all axis labels with units, every data value and tick mark visible, legend entries, ' +
    'and any annotations. Preserve exact numbers and units. Use a structured layout.',
  infographic:
    'This is an infographic or KPI card. Extract every piece of text, number, percentage, ' +
    'statistic, label, icon label, and callout exactly as shown. Preserve formatting.',
  diagram:
    'This is a diagram, flowchart, or process map. List every labeled node, every connector ' +
    'or arrow label, and describe the flow or structure step by step.',
  image:
    'Describe this image and extract every visible piece of text, label, caption, ' +
    'or number exactly as shown.',
  text:
    'Perform accurate OCR on this scanned text block. Output the exact text as it appears, ' +
    'preserving paragraph structure and line breaks. Do not paraphrase or summarize.',
  header:
    'Extract the exact text from this heading or title area as it appears, ' +
    'including any subtitle, section number, date, or metadata line.',
  table:
    'This is a table. Extract all cell contents. Use | to separate columns and a newline ' +
    'for each row. Include the header row. Preserve all numbers and values exactly.',
  unknown:
    'Extract all visible text from this image exactly as it appears.'
};

const MOCK_OCR = {
  chart:       'Revenue by Quarter\nQ1: $1.2M  Q2: $1.5M  Q3: $1.8M  Q4: $1.4M\nYear-over-year growth: +12%',
  infographic: 'Total Revenue: $4.2M  ▲ +12% YoY\nActive Users: 48,200  ▲ +22%\nNPS Score: 72  ▲ +8pts',
  diagram:     'Upload → Parse → Chunk → Embed → Index → Retrieve → Generate\nAll stages connected sequentially.',
  image:       'Photograph: team in modern office. Company logo on wall: "Accelerate".',
  text:        'Sample body text extracted from scanned document. This paragraph continues across multiple lines of the original page.',
  header:      'Document Title\nSubtitle Line\nJanuary 2024',
  table:       'Column A | Column B | Column C\nRow 1    | Value 1  | Value 2\nRow 2    | Value 3  | Value 4',
  unknown:     'Text content extracted from the image region.'
};

const OCR_MODEL_CHAIN = [
  'gemini-2.0-flash',
  'gemini-2.0-flash-lite',
  'gemini-1.5-flash-latest',
  'gemini-1.5-flash'
];

// Upscale crops whose longest side is smaller than this before sending to Gemini
const MIN_OCR_PX = 800;

/**
 * Crop a bounding-box region from the source image, upscale if it is too small,
 * and return a lossless PNG Buffer for accurate OCR.
 */
async function cropToBuffer(sourceImagePath, box, imgW, imgH) {
  const sharp = require('sharp'); // lazy-load to avoid hang on startup
  const [x1, y1, x2, y2] = box;
  const left   = Math.max(0, Math.round(x1 * imgW));
  const top    = Math.max(0, Math.round(y1 * imgH));
  const width  = Math.max(1, Math.round((x2 - x1) * imgW));
  const height = Math.max(1, Math.round((y2 - y1) * imgH));

  if (width < 20 || height < 20) return null;

  // Upscale small crops — Gemini OCR is significantly more accurate on larger inputs
  const longestSide = Math.max(width, height);
  const scale = longestSide < MIN_OCR_PX
    ? Math.min(4, Math.ceil(MIN_OCR_PX / longestSide))
    : 1;

  let pipeline = sharp(sourceImagePath).extract({ left, top, width, height });

  if (scale > 1) {
    pipeline = pipeline.resize(width * scale, height * scale, {
      kernel: sharp.kernel.lanczos3,
      fit: 'fill'
    });
  }

  // PNG (lossless) preserves fine detail that JPEG compression destroys
  return pipeline.png({ compressionLevel: 3 }).toBuffer();
}

/**
 * Call Gemini to OCR a PNG Buffer using a model fallback chain.
 */
async function geminiOcr(buffer, chunkType) {
  const { GoogleGenerativeAI } = require('@google/generative-ai');
  const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

  const prompt = OCR_PROMPTS[chunkType] || OCR_PROMPTS.unknown;
  const base64 = buffer.toString('base64');

  let lastErr;
  for (const modelName of OCR_MODEL_CHAIN) {
    const model = genAI.getGenerativeModel({ model: modelName });
    try {
      const result = await model.generateContent([
        { inlineData: { data: base64, mimeType: 'image/png' } },
        { text: prompt }
      ]);
      return result.response.text().trim();
    } catch (err) {
      lastErr = err;
      const msg = err.message || '';
      if (
        msg.includes('429') || msg.includes('quota') || msg.includes('RESOURCE_EXHAUSTED') ||
        msg.includes('404') || msg.includes('not found') || msg.includes('is not supported')
      ) {
        console.warn(`  [OCR] ${modelName} unavailable, trying next model...`);
        continue;
      }
      throw err;
    }
  }
  throw lastErr || new Error('All OCR models exhausted');
}

/**
 * Call OpenAI (GPT-4o) to OCR a PNG Buffer.
 */
async function openaiOcr(buffer, chunkType) {
  const { OpenAI } = require('openai');
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

  const prompt = OCR_PROMPTS[chunkType] || OCR_PROMPTS.unknown;
  const base64 = buffer.toString('base64');

  const models = ['gpt-4o', 'gpt-4o-mini'];
  let lastErr;
  for (const model of models) {
    try {
      const response = await client.chat.completions.create({
        model,
        messages: [{
          role: 'user',
          content: [
            { type: 'image_url', image_url: { url: `data:image/png;base64,${base64}`, detail: 'high' } },
            { type: 'text', text: prompt }
          ]
        }],
        max_tokens: 2048
      });
      return response.choices[0].message.content?.trim() || '';
    } catch (err) {
      lastErr = err;
      const msg = err.message || '';
      if (msg.includes('429') || msg.includes('quota') || msg.includes('insufficient_quota') ||
          msg.includes('404') || msg.includes('model_not_found')) {
        console.warn(`  [OCR] OpenAI ${model} unavailable, trying next...`);
        continue;
      }
      throw err;
    }
  }
  throw lastErr || new Error('All OpenAI OCR models exhausted');
}

/**
 * Enrich every box that lacks text content with Gemini OCR.
 *
 * - Visual types (chart / infographic / diagram / image): OCR when text is absent.
 * - Text types (text / header / table / unknown): OCR as a scanned-PDF fallback
 *   when pdfjs returned nothing (empty text layer).
 *
 * Boxes that already have meaningful text (>10 chars) are left untouched so that
 * pdfjs-extracted native-PDF text is never replaced unnecessarily.
 */
async function enrichBoxesWithOcr(boxes, sourceImagePath) {
  if (!sourceImagePath || !fs.existsSync(sourceImagePath)) return boxes;

  const sharp     = require('sharp'); // lazy-load to avoid hang on startup
  const useMock   = process.env.MOCK_GEMINI?.trim().toLowerCase() !== 'false';
  const useOpenAI = (process.env.AI_PROVIDER || 'openai').trim().toLowerCase() !== 'gemini';
  const meta      = await sharp(sourceImagePath).metadata();
  const { width: imgW, height: imgH } = meta;

  const results = await Promise.allSettled(
    boxes.map(async box => {
      const hasText = box.text_content && box.text_content.trim().length > 10;
      if (hasText) return box;

      if (useMock) {
        return { ...box, text_content: MOCK_OCR[box.type] || MOCK_OCR.unknown };
      }

      try {
        const buffer = await cropToBuffer(sourceImagePath, box.box, imgW, imgH);
        if (!buffer) return box;
        const text = await (useOpenAI ? openaiOcr(buffer, box.type) : geminiOcr(buffer, box.type));
        console.log(`  [OCR] ${box.type} ${box.id} → ${text.length} chars`);
        return { ...box, text_content: text };
      } catch (err) {
        console.warn(`  [OCR] ${box.type} ${box.id} failed: ${err.message}`);
        return box;
      }
    })
  );

  return results.map((r, i) => r.status === 'fulfilled' ? r.value : boxes[i]);
}

module.exports = { enrichBoxesWithOcr, VISUAL_TYPES };
