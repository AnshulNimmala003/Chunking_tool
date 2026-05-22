const { execSync, execFileSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const { analyzeAudio } = require('./audio.service');

// Check ffmpeg is available
function checkFfmpeg() {
  try {
    execFileSync('ffmpeg', ['-version'], { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Extract audio track from a video file as MP3.
 * Returns the output audio file path.
 */
function extractAudio(videoPath, outputDir) {
  const base     = path.basename(videoPath, path.extname(videoPath));
  const audioOut = path.join(outputDir, `${base}_audio.mp3`);
  execFileSync('ffmpeg', [
    '-i', videoPath,
    '-vn', '-acodec', 'libmp3lame', '-ab', '128k',
    '-y', audioOut
  ], { stdio: 'pipe' });
  console.log(`  [Video] Audio extracted → ${path.basename(audioOut)}`);
  return audioOut;
}

/**
 * Extract key frames from a video — one per `intervalSecs` seconds.
 * Returns array of { frameTime (seconds), imagePath }.
 */
function extractKeyFrames(videoPath, outputDir, intervalSecs = 30) {
  const base    = path.basename(videoPath, path.extname(videoPath));
  const pattern = path.join(outputDir, `${base}_frame_%04d.jpg`);

  execFileSync('ffmpeg', [
    '-i', videoPath,
    '-vf', `fps=1/${intervalSecs}`,
    '-q:v', '3',
    '-y', pattern
  ], { stdio: 'pipe' });

  const frames = fs.readdirSync(outputDir)
    .filter(f => f.startsWith(`${base}_frame_`) && f.endsWith('.jpg'))
    .sort()
    .map((f, idx) => ({
      frameTime: idx * intervalSecs,
      imagePath: f,
      imageUrl:  `/uploads/${f}`
    }));

  console.log(`  [Video] ${frames.length} key frames extracted`);
  return frames;
}

/**
 * Associate key frames with transcript chunks by time range.
 */
function assignFramesToChunks(chunks, keyFrames) {
  return chunks.map(chunk => {
    const frame = keyFrames.find(
      f => f.frameTime >= chunk.start_time && f.frameTime < chunk.end_time
    ) || keyFrames.find(f => f.frameTime >= chunk.start_time);

    return frame ? { ...chunk, keyFrameUrl: frame.imageUrl } : chunk;
  });
}

/**
 * Main entry point: analyze a video file.
 * Returns { chunks, keyFrames, duration, fullText }.
 */
async function analyzeVideo(videoPath, uploadsDir) {
  const useMock = process.env.MOCK_GEMINI?.trim().toLowerCase() !== 'false';

  if (useMock) {
    const { analyzeAudio: audioMock } = require('./audio.service');
    const { chunks, duration, fullText } = await audioMock(videoPath);
    // Attach placeholder key frame info
    const mockedChunks = chunks.map((c, i) => ({
      ...c,
      keyFrameUrl: null  // no real frames in mock mode
    }));
    return { chunks: mockedChunks, keyFrames: [], duration, fullText };
  }

  if (!checkFfmpeg()) {
    throw new Error(
      'ffmpeg is not installed or not in PATH. Install it to enable video processing. ' +
      'macOS: brew install ffmpeg   Ubuntu: sudo apt install ffmpeg'
    );
  }

  // 1. Extract audio
  const audioPath = extractAudio(videoPath, uploadsDir);

  // 2. Extract key frames (one per 30s)
  const keyFrames = extractKeyFrames(videoPath, uploadsDir, 30);

  // 3. Transcribe and chunk the audio
  const { chunks: rawChunks, duration, fullText } = await analyzeAudio(audioPath);

  // 4. Clean up temporary audio
  try { fs.unlinkSync(audioPath); } catch {}

  // 5. Assign key frames to transcript chunks
  const chunks = assignFramesToChunks(rawChunks, keyFrames);

  return { chunks, keyFrames, duration, fullText };
}

module.exports = { analyzeVideo };
