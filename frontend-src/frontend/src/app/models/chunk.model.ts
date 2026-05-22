export type ChunkSource  = 'ai' | 'user';
export type ChunkType    = 'chart' | 'table' | 'text' | 'diagram' | 'header' | 'infographic' | 'image' | 'unknown'
                         | 'introduction' | 'explanation' | 'demonstration' | 'discussion' | 'analysis' | 'conclusion' | 'topic';
export type MediaType    = 'image' | 'pdf' | 'audio' | 'video' | 'webpage';

export interface Chunk {
  id: string;
  box: [number, number, number, number];  // [x1,y1,x2,y2] normalized; [0,0,0,0] for audio/video
  pageNumber: number;
  label: string;
  summary: string;
  extractedText?: string;
  title: string;
  description: string;
  type: ChunkType | string;
  source: ChunkSource;
  filename?: string;        // user-editable export filename (no extension)
  thumbnail?: string;       // base64 data URL for sidebar preview
  paragraphNumber?: number | null;
  locationInPage?: string;
  // Audio / Video specific
  startTime?: number;       // seconds
  endTime?: number;         // seconds
  keyFrameUrl?: string;     // server-side URL of the closest video key frame
  mediaType?: MediaType;
  questions?: { text: string; checked: boolean }[];
  noTextLayer?: boolean;
  screenshot?: string | null;
}

export interface AiAnalyzeBox {
  id: string;
  box: [number, number, number, number];
  type: string;
  label: string;
  title: string;
  summary: string;
  text_content?: string;
  filename?: string;
  page_number?: number;
  paragraph_number?: number | null;
  location_in_page?: string;
}

export interface AnalyzeResponse {
  sessionId: string;
  imagePath: string;
  imageUrl?: string;
  pdfPath?: string | null;
  pageTitle?: string;
  sourceUrl?: string;
  boxes: AiAnalyzeBox[];
}

export interface TranscribeResponse {
  chunks:    Chunk[];
  mediaType: MediaType;
  duration:  number;
  fileName:  string;
  fullText:  string;
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
