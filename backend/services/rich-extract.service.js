'use strict';

const { spawn } = require('child_process');
const path = require('path');

const PYTHON = process.env.PYTHON_BIN || 'python3';
const SCRIPT = path.join(__dirname, 'fitz_extract.py');

/**
 * Batch-extract font-embedded HTML for multiple chunks from one PDF.
 * Spawns a single Python process for the whole batch to avoid per-chunk startup cost.
 *
 * @param {string} pdfAbsPath  - Absolute path to the PDF file on disk
 * @param {Array<{pageNum: number, box: number[]}>} requests - One entry per chunk
 *   box: normalized 0-1 coords [nx1, ny1, nx2, ny2], top-left origin
 * @returns {Promise<Array<{html, fonts_embedded, fonts_skipped, page_size, clip_rect}>>}
 *   Parallel array to requests. Each entry has:
 *     html           {string}  self-contained HTML doc with inline @font-face rules
 *     fonts_embedded {string[]} basefont names successfully embedded as base64
 *     fonts_skipped  {Array<{name,ext,reason}>} fonts not embedded (CFF/Type1/etc.)
 *     page_size      {w, h}    PDF page dimensions in points
 *     clip_rect      {x, y, w, h} actual clip rect used (clamped to page bounds)
 *   On per-request error the entry is {error: string, html: null}.
 */
const TIMEOUT_MS = 60_000;

function extractRichBatch(pdfAbsPath, requests) {
  return new Promise((resolve, reject) => {
    const py = spawn(PYTHON, [SCRIPT, pdfAbsPath]);
    const stdoutChunks = [];
    const stderrChunks = [];
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      py.kill('SIGKILL');
      reject(new Error(`fitz_extract timed out after ${TIMEOUT_MS / 1000}s`));
    }, TIMEOUT_MS);

    py.stdout.on('data', chunk => { stdoutChunks.push(chunk); });
    py.stderr.on('data', chunk => { stderrChunks.push(chunk); });

    py.on('close', code => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const raw = Buffer.concat(stdoutChunks).toString('utf8').trim();
      if (!raw) {
        return reject(new Error(
          `fitz_extract exited ${code} with no output. stderr: ${Buffer.concat(stderrChunks).toString('utf8').slice(0, 300)}`
        ));
      }
      try {
        const parsed = JSON.parse(raw);
        // Top-level error object means the PDF couldn't be opened
        if (!Array.isArray(parsed)) {
          return reject(new Error(parsed.error || 'fitz_extract returned unexpected JSON'));
        }
        resolve(parsed);
      } catch (e) {
        reject(new Error(`fitz_extract JSON parse error: ${raw.slice(0, 200)}`));
      }
    });

    py.on('error', err => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(
        `Cannot spawn "${PYTHON}" — set PYTHON_BIN env var if python3 is not on PATH: ${err.message}`
      ));
    });

    py.stdin.on('error', () => {}); // suppress EPIPE if Python exits before reading all input
    py.stdin.write(JSON.stringify(requests));
    py.stdin.end();
  });
}

module.exports = { extractRichBatch };
