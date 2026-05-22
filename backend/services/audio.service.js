const fs = require('fs');
const path = require('path');

// ── JSON repair (same logic as gemini.service.js) ─────────────────────────────
function repairJson(raw) {
  let s = raw.replace(/^\s*```(?:json)?\n?/im, '').replace(/\n?```\s*$/im, '').trim();
  try { return JSON.parse(s); } catch {}
  s = s.replace(/[''ʼ]/g, "'").replace(/[""„]/g, '"');
  try { return JSON.parse(s); } catch {}
  s = s.replace(/,(\s*[}\]])/g, '$1');
  try { return JSON.parse(s); } catch {}
  const arrMatch = s.match(/\[[\s\S]*\]/);
  if (arrMatch) { try { return JSON.parse(arrMatch[0]); } catch {} }
  throw new SyntaxError(`Audio chunking: unparseable JSON. Snippet: ${s.slice(0, 120)}`);
}

// ── Mock data ──────────────────────────────────────────────────────────────────
const MOCK_AUDIO_CHUNKS = [
  {
    chunk_id: 'seg_1',
    title: 'Opening Remarks and Agenda',
    type: 'introduction',
    start_time: 0,
    end_time: 75.3,
    text: "Good morning everyone. Thank you for joining today's Q3 performance review. We have a packed agenda covering revenue performance, product launches, and the 2025 roadmap. I'd like to start by acknowledging the team's incredible work this quarter before we dive into the numbers.",
    source: 'ai', label: 'introduction', summary: '', description: '', box: [0,0,0,0], pageNumber: 1
  },
  {
    chunk_id: 'seg_2',
    title: 'Q3 Revenue Performance Summary',
    type: 'analysis',
    start_time: 75.3,
    end_time: 198.7,
    text: 'Total revenue for Q3 came in at 4.2 million, representing a 12% year-over-year growth. The North region led performance at 2.1 million — 5% above target. The South region came in at 1.8 million, slightly below its 2 million target. Enterprise accounts were the primary growth driver, contributing 68% of total revenue.',
    source: 'ai', label: 'analysis', summary: '', description: '', box: [0,0,0,0], pageNumber: 1
  },
  {
    chunk_id: 'seg_3',
    title: 'Product Launch Highlights',
    type: 'explanation',
    start_time: 198.7,
    end_time: 340.1,
    text: "Moving on to product. We shipped three major releases this quarter. The analytics dashboard launched in July with 340 enterprise customers onboarding in the first month — ahead of our 250 target. The mobile app v2 shipped in August with a 4.8 App Store rating. And the API gateway, which launched quietly in September, is already processing 12 million requests per day.",
    source: 'ai', label: 'explanation', summary: '', description: '', box: [0,0,0,0], pageNumber: 1
  },
  {
    chunk_id: 'seg_4',
    title: '2025 Roadmap and Investment Areas',
    type: 'discussion',
    start_time: 340.1,
    end_time: 498.9,
    text: 'For 2025, we are prioritizing three investment areas. First, AI-native features — we plan to embed Gemini-powered intelligence across the entire product surface. Second, international expansion, starting with EMEA in Q1 and APAC in Q3. Third, platform extensibility — opening the API to third-party developers with a marketplace launching in Q2.',
    source: 'ai', label: 'discussion', summary: '', description: '', box: [0,0,0,0], pageNumber: 1
  },
  {
    chunk_id: 'seg_5',
    title: 'Q&A and Next Steps',
    type: 'conclusion',
    start_time: 498.9,
    end_time: 612.0,
    text: "Great questions from the team. To summarise next steps: Sarah's team will finalize the EMEA go-to-market by end of October. Engineering will complete the AI feature spec by November 1st. Finance will circulate the updated budget model by Friday. We'll reconvene for the Q4 kickoff on November 15th. Thank you all.",
    source: 'ai', label: 'conclusion', summary: '', description: '', box: [0,0,0,0], pageNumber: 1
  }
];

// ── Semantic chunking prompt sent to Gemini ────────────────────────────────────
function buildChunkingPrompt(segments) {
  const formatted = segments
    .map((s, i) => `[${i}] ${formatTime(s.start)}–${formatTime(s.end)}: ${s.text}`)
    .join('\n');

  return `You are a transcript chunker for RAG pipelines.

Below is a speech transcript split into timed segments. Group these segments into coherent semantic chunks (topics, sections, or narrative units).

SEGMENTS:
${formatted}

OUTPUT: a JSON array only — no markdown, no explanation.
[
  {
    "title": "5-8 word descriptive title",
    "type": "introduction|explanation|demonstration|discussion|analysis|conclusion|topic",
    "segment_start": 0,
    "segment_end": 3
  }
]

Rules:
- Minimum chunk: at least 2 consecutive segments or 30 seconds
- Maximum chunk: 5 minutes (300 seconds)
- Cover ALL segments
- Output ONLY valid JSON array`;
}

function formatTime(sec) {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

// ── Real transcription via Groq Whisper ────────────────────────────────────────
async function transcribeWithGroq(audioPath) {
  const Groq = require('groq-sdk');
  const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

  console.log('  [Audio] Uploading to Groq Whisper...');
  const transcription = await groq.audio.transcriptions.create({
    file: fs.createReadStream(audioPath),
    model: 'whisper-large-v3',
    response_format: 'verbose_json',
    timestamp_granularities: ['segment']
  });

  return {
    segments: (transcription.segments || []).map(s => ({
      start: s.start,
      end: s.end,
      text: s.text.trim()
    })),
    duration: transcription.duration || 0,
    fullText: transcription.text || ''
  };
}

// ── Semantic chunking via Gemini ───────────────────────────────────────────────
async function semanticChunk(segments, duration) {
  if (!segments.length) return [];

  const { GoogleGenerativeAI } = require('@google/generative-ai');
  const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
  const model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash' });

  const prompt = buildChunkingPrompt(segments);
  console.log('  [Audio] Running Gemini semantic chunking...');

  let raw;
  try {
    const result = await model.generateContent(prompt);
    const text = result.response.text().trim();
    raw = repairJson(text);
  } catch (err) {
    console.warn('  [Audio] Gemini chunking failed, falling back to fixed-window:', err.message);
    return fixedWindowChunks(segments, duration);
  }

  return raw.map((item, i) => {
    const start = segments[item.segment_start]?.start ?? 0;
    const end   = segments[item.segment_end]?.end   ?? duration;
    const text  = segments
      .slice(item.segment_start, item.segment_end + 1)
      .map(s => s.text)
      .join(' ');

    return {
      chunk_id: `seg_${i + 1}`,
      title:    item.title   || `Segment ${i + 1}`,
      type:     item.type    || 'topic',
      start_time: Math.round(start * 10) / 10,
      end_time:   Math.round(end   * 10) / 10,
      text,
      source: 'ai', label: item.type || 'topic',
      summary: '', description: text, box: [0,0,0,0], pageNumber: 1
    };
  });
}

// Fallback: group segments into ~90-second windows
function fixedWindowChunks(segments, duration) {
  const WINDOW = 90;
  const chunks = [];
  let bucket = [], bucketStart = 0, chunkIdx = 1;

  for (const seg of segments) {
    bucket.push(seg);
    if (seg.end - bucketStart >= WINDOW || seg === segments[segments.length - 1]) {
      const text = bucket.map(s => s.text).join(' ');
      chunks.push({
        chunk_id: `seg_${chunkIdx++}`,
        title: `Section ${chunkIdx - 1}`,
        type: 'topic',
        start_time: Math.round(bucketStart * 10) / 10,
        end_time:   Math.round((seg.end) * 10) / 10,
        text, source: 'ai', label: 'topic',
        summary: '', description: text, box: [0,0,0,0], pageNumber: 1
      });
      bucket = [];
      bucketStart = seg.end;
    }
  }
  return chunks;
}

// ── Main entry point ──────────────────────────────────────────────────────────
async function analyzeAudio(audioPath) {
  const useMock = process.env.MOCK_GEMINI?.trim().toLowerCase() !== 'false';

  if (useMock) {
    console.log('  [Audio] MOCK mode — returning mock transcript chunks');
    await new Promise(r => setTimeout(r, 800));
    return { chunks: MOCK_AUDIO_CHUNKS, duration: 612, fullText: MOCK_AUDIO_CHUNKS.map(c => c.text).join(' ') };
  }

  if (!process.env.GROQ_API_KEY) {
    throw new Error('GROQ_API_KEY is not set. Add it to backend/.env to enable audio transcription.');
  }

  const { segments, duration, fullText } = await transcribeWithGroq(audioPath);
  console.log(`  [Audio] Transcribed ${segments.length} segments, ${Math.round(duration)}s`);

  const chunks = await semanticChunk(segments, duration);
  console.log(`  [Audio] ${chunks.length} semantic chunks`);

  return { chunks, duration, fullText };
}

module.exports = { analyzeAudio };
