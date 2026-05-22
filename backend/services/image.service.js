const path = require('path');

// Convert normalized [x1,y1,x2,y2] (0–1) to pixel coords clamped to image bounds
function normalizedToPixels(box, imgWidth, imgHeight) {
  const [x1n, y1n, x2n, y2n] = box;

  const x1 = Math.round(Math.max(0, x1n) * imgWidth);
  const y1 = Math.round(Math.max(0, y1n) * imgHeight);
  const x2 = Math.round(Math.min(1, x2n) * imgWidth);
  const y2 = Math.round(Math.min(1, y2n) * imgHeight);

  const width = Math.max(1, x2 - x1);
  const height = Math.max(1, y2 - y1);

  return { left: x1, top: y1, width, height };
}

// Crop all chunks from the source image and write PNG files to outputDir.
// Returns the RAG-ready metadata array.
async function cropChunks(sourceImagePath, chunks, outputDir, sessionId) {
  const sharp = require('sharp'); // lazy-load to avoid hang on startup
  const meta = await sharp(sourceImagePath).metadata();
  const { width: imgW, height: imgH } = meta;

  const metadata = [];

  for (const chunk of chunks) {
    const { left, top, width, height } = normalizedToPixels(chunk.box, imgW, imgH);

    // Skip boxes that are degenerate (< 10px in any dimension)
    if (width < 10 || height < 10) {
      console.warn(`  [Image] Skipping tiny box ${chunk.id} (${width}×${height}px)`);
      continue;
    }

    const filename = `${sessionId}_${chunk.id}.png`;
    const outPath = path.join(outputDir, filename);

    await sharp(sourceImagePath)
      .extract({ left, top, width, height })
      .png()
      .toFile(outPath);

    metadata.push({
      chunk_id: chunk.id,
      title: chunk.title || chunk.label || `Chunk ${chunk.id}`,
      description: chunk.description || chunk.summary || '',
      type: chunk.type || chunk.label || 'unknown',
      image_path: filename,
      coordinates: chunk.box,            // normalized 0-1, for re-use
      pixel_coordinates: [left, top, left + width, top + height],
      original_image_size: { width: imgW, height: imgH }
    });
  }

  return metadata;
}

module.exports = { cropChunks, normalizedToPixels };
