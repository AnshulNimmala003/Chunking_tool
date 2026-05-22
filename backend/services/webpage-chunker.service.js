'use strict';

const path = require('path');
const { v4: uuidv4 } = require('uuid');
const { toFilename } = require('./utils');

// Semantic rules ordered most-specific → most-general.
// More specific elements win during deduplication.
const RULES = [
  { selector: 'h1',                        type: 'header', minW: 40,  minH: 12 },
  { selector: 'h2, h3',                    type: 'header', minW: 40,  minH: 10 },
  { selector: 'h4, h5, h6',               type: 'header', minW: 30,  minH: 8  },
  { selector: 'table',                     type: 'table',  minW: 80,  minH: 30 },
  { selector: 'figure',                    type: 'image',  minW: 60,  minH: 40 },
  { selector: 'img[src]',                  type: 'image',  minW: 60,  minH: 40 },
  { selector: 'article,[role="article"]', type: 'text',   minW: 100, minH: 50 },
  { selector: 'section',                   type: 'text',   minW: 100, minH: 40 },
  { selector: 'main > div',               type: 'text',   minW: 100, minH: 40 },
  { selector: 'p',                         type: 'text',   minW: 50,  minH: 8  },
  { selector: 'ul, ol',                    type: 'text',   minW: 50,  minH: 20 },
  { selector: 'blockquote',               type: 'text',   minW: 50,  minH: 20 },
];

/**
 * Screenshot a URL and chunk it using DOM semantic structure — no LLM needed.
 * Returns the same shape as the AI route so the frontend needs no changes.
 */
async function chunkWebpageByRules(url, uploadsDir) {
  let puppeteer;
  try { puppeteer = require('puppeteer'); }
  catch { throw new Error('puppeteer is not installed. Run: cd backend && npm install puppeteer'); }

  const filename    = `${uuidv4()}_webpage.jpg`;
  const outputPath  = path.join(uploadsDir, filename);

  console.log(`\n[Webpage/Rule] Launching Chromium for: ${url}`);
  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu']
  });

  let title = url;
  let boxes = [];

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1.5 });
    await page.setUserAgent(
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    );

    await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
    await autoScroll(page);
    title = await page.title().catch(() => url);

    const fullHeight = await page.evaluate(() => document.body.scrollHeight);
    const capHeight  = Math.min(fullHeight, 15000);

    // Expand viewport to full-page before querying layout — positions are relative to this
    await page.setViewport({ width: 1440, height: capHeight, deviceScaleFactor: 1.5 });

    await page.screenshot({ path: outputPath, type: 'jpeg', quality: 88, fullPage: false });
    console.log(`  [Webpage/Rule] Screenshot saved: ${filename}`);

    const rawChunks = [];
    let idx = 1;

    for (const rule of RULES) {
      let elements;
      try { elements = await page.$$(rule.selector); }
      catch { continue; }

      for (const el of elements) {
        let data;
        try {
          data = await el.evaluate(e => {
            const r   = e.getBoundingClientRect();
            const cs  = window.getComputedStyle(e);
            return {
              x:    r.left,
              y:    r.top,
              w:    r.width,
              h:    r.height,
              text: (e.innerText || '').trim().slice(0, 3000),
              disp: cs.display,
              vis:  cs.visibility,
              op:   parseFloat(cs.opacity),
            };
          });
        } catch { continue; }

        if (data.disp === 'none' || data.vis === 'hidden' || data.op < 0.1) continue;
        if (data.w < rule.minW || data.h < rule.minH) continue;
        if (data.x < 0 || data.y < 0 || data.y + data.h > capHeight + 10) continue;
        if (!data.text && rule.type !== 'image') continue;

        const x1 = clamp(data.x / 1440);
        const y1 = clamp(data.y / capHeight);
        const x2 = clamp((data.x + data.w) / 1440);
        const y2 = clamp((data.y + data.h) / capHeight);

        if (x2 - x1 < 0.02 || y2 - y1 < 0.005) continue;

        const titleText = (data.text.split('\n')[0] || rule.type).trim().slice(0, 80);
        rawChunks.push({
          id:           `box_${idx++}`,
          type:          rule.type,
          title:         titleText,
          filename:      toFilename(titleText),
          label:         rule.type,
          summary:       '',
          text_content:  data.text,
          box:           [x1, y1, x2, y2],
        });
      }
    }

    boxes = dedup(rawChunks);
    console.log(`  [Webpage/Rule] ${boxes.length} chunks (from ${rawChunks.length} raw elements)`);
  } finally {
    await browser.close();
  }

  return { filename, imageUrl: `/uploads/${filename}`, title, boxes };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function clamp(v) { return Math.max(0, Math.min(1, v)); }

function autoScroll(page) {
  return page.evaluate(() => new Promise(resolve => {
    let total = 0;
    const dist  = 400;
    const timer = setInterval(() => {
      window.scrollBy(0, dist);
      total += dist;
      if (total >= Math.min(document.body.scrollHeight, 8000)) {
        clearInterval(timer);
        window.scrollTo(0, 0);
        resolve();
      }
    }, 120);
  }));
}

function boxArea(b)      { return (b[2] - b[0]) * (b[3] - b[1]); }
function intersect(a, b) {
  const x1 = Math.max(a[0], b[0]), y1 = Math.max(a[1], b[1]);
  const x2 = Math.min(a[2], b[2]), y2 = Math.min(a[3], b[3]);
  return x1 < x2 && y1 < y2 ? (x2 - x1) * (y2 - y1) : 0;
}

/**
 * Remove large containers whose area is already well-covered by smaller,
 * more-specific children. Keeps the HITL canvas uncluttered without hiding
 * content that isn't represented by any specific child.
 */
function dedup(chunks) {
  const sorted = [...chunks].sort((a, b) => boxArea(a.box) - boxArea(b.box));
  const kept   = [];
  for (const chunk of sorted) {
    const area    = boxArea(chunk.box);
    const covered = kept.reduce((sum, k) => sum + intersect(chunk.box, k.box), 0);
    if (covered / area < 0.65) kept.push(chunk);
  }
  return kept;
}

module.exports = { chunkWebpageByRules };
