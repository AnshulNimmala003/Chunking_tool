export type ChunkSource = 'ai' | 'user';
export type ChunkType = 'chart' | 'table' | 'text' | 'diagram' | 'header' | 'image' | 'unknown';

export interface Chunk {
  id: string;
  // Normalized 0-1 coordinates [x1, y1, x2, y2]
  box: [number, number, number, number];
  label: string;
  summary: string;
  title: string;
  description: string;
  type: ChunkType | string;
  source: ChunkSource;  // 'ai' = Gemini-generated, 'user' = manually added or moved
  thumbnail?: string;   // base64 data URL for sidebar preview
}

export interface AnalyzeResponse {
  sessionId: string;
  imagePath: string;
  boxes: Array<{
    id: string;
    box: [number, number, number, number];
    label: string;
    summary: string;
  }>;
}

export interface ExportChunk {
  id: string;
  box: [number, number, number, number];
  label: string;
  title: string;
  description: string;
  type: string;
  summary: string;
}
