'use strict';

// ── Shared helpers ────────────────────────────────────────────────────────────

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Render one line: escape HTML entities, then convert italic sentinels to <em>
function renderLine(line) {
  return line.split(/([^]*)/).map(part => {
    if (part.startsWith('')) {
      return `<em>${escapeHtml(part.slice(1, -1))}</em>`;
    }
    return escapeHtml(part);
  }).join('');
}

function dataAttrs(chunk) {
  const { id, type, page_number, paragraph_number, location_in_page, bounding_box } = chunk;
  const boxAttr = Array.isArray(bounding_box)
    ? bounding_box.map(v => (typeof v === 'number' && isFinite(v) ? v : parseFloat(v) || 0).toFixed(4)).join(',')
    : '';
  return [
    `data-chunk-id="${escapeHtml(String(id ?? ''))}"`,
    `data-type="${escapeHtml(type || 'unknown')}"`,
    `data-page="${page_number ?? ''}"`,
    `data-paragraph="${paragraph_number ?? ''}"`,
    `data-location="${escapeHtml(location_in_page || '')}"`,
    `data-box="${boxAttr}"`,
  ].join('\n    ');
}

// ── Text-only mode (verbatim, MLR-safe) ──────────────────────────────────────

/**
 * Generate a complete HTML document for a chunk using plain extracted text.
 * Every character is reproduced verbatim — no structural reinterpretation.
 * Italic runs marked with U+E001/U+E002 sentinels are rendered as <em>.
 *
 * @param {{ id, title, type, text, page_number, paragraph_number, location_in_page, bounding_box }} chunk
 * @returns {string}
 */
function generateHtml(chunk) {
  const { title, text } = chunk;
  const safeTitle = escapeHtml(title || 'Untitled');

  // Split on blank lines to detect paragraph breaks; within each paragraph
  // individual lines are joined with <br> to preserve the original line structure.
  const rawText = text || '';
  const paragraphs = rawText.split(/\n\n+/);
  const body = paragraphs
    .map(para => {
      if (!para.trim()) return '';
      const lines = para.split('\n').map(renderLine).join('<br>\n    ');
      return `  <p style="margin:0 0 4px;" ${dataAttrs(chunk)}>${lines}</p>`;
    })
    .filter(Boolean)
    .join('\n');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${safeTitle}</title>
</head>
<body>
${body}
</body>
</html>
`;
}

module.exports = { generateHtml };
