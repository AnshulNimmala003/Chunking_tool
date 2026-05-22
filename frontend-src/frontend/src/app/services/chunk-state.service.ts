import { Injectable, signal, computed } from '@angular/core';
import { Chunk, ChunkType, AiAnalyzeBox, MediaType, TranscribeResponse } from '../models/chunk.model';

@Injectable({ providedIn: 'root' })
export class ChunkStateService {

  // ── Image / media source ──────────────────────────────────────────────
  imageFile  = signal<File | null>(null);
  imageUrl   = signal<string | null>(null);
  mediaType  = signal<MediaType>('image');

  // ── Multi-page PDF state ─────────────────────────────────────────────
  pdfPages    = signal<Array<{ page: number; imageUrl: string; imagePath: string }>>([]);
  currentPage = signal(1);

  // ── Session ──────────────────────────────────────────────────────────
  sessionId = signal<string | null>(null);
  imagePath = signal<string | null>(null);
  pdfPath   = signal<string | null>(null);

  // ── Webpage metadata ─────────────────────────────────────────────────
  pageTitle = signal<string | null>(null);
  sourceUrl = signal<string | null>(null);

  // ── Audio/Video metadata ─────────────────────────────────────────────
  mediaDuration = signal<number>(0);
  mediaFileName = signal<string | null>(null);
  fullTranscript = signal<string>('');

  // ── Chunk state ──────────────────────────────────────────────────────
  chunks          = signal<Chunk[]>([]);
  selectedChunkId = signal<string | null>(null);

  // ── UI flags ─────────────────────────────────────────────────────────
  isAnalyzing = signal(false);
  isExporting = signal(false);
  isAddMode   = signal(false);
  phase       = signal<'upload' | 'editor' | 'transcript'>('upload');

  // ── Derived ──────────────────────────────────────────────────────────
  selectedChunk = computed(() =>
    this.chunks().find(c => c.id === this.selectedChunkId()) ?? null
  );
  hasSession       = computed(() => !!this.sessionId());
  isTranscriptMode = computed(() => this.mediaType() === 'audio' || this.mediaType() === 'video');

  // ── Undo / Redo ───────────────────────────────────────────────────────
  private undoStack: Chunk[][] = [];
  private redoStack: Chunk[][] = [];

  // ── Per-page chunk persistence (PDFs) ─────────────────────────────────
  private pageChunksMap = new Map<number, Chunk[]>();

  // ── History ──────────────────────────────────────────────────────────

  get canUndo(): boolean { return this.undoStack.length > 0; }
  get canRedo(): boolean { return this.redoStack.length > 0; }

  pushHistory(): void {
    this.undoStack.push(this.chunks().map(c => ({ ...c })));
    this.redoStack = [];
    if (this.undoStack.length > 50) this.undoStack.shift();
  }

  undo(): void {
    if (!this.undoStack.length) return;
    this.redoStack.push(this.chunks().map(c => ({ ...c })));
    this.chunks.set(this.undoStack.pop()!);
    this.selectedChunkId.set(null);
  }

  redo(): void {
    if (!this.redoStack.length) return;
    this.undoStack.push(this.chunks().map(c => ({ ...c })));
    this.chunks.set(this.redoStack.pop()!);
    this.selectedChunkId.set(null);
  }

  // ── Per-page operations ───────────────────────────────────────────────

  savePageChunks(page: number): void {
    this.pageChunksMap.set(page, this.chunks().map(c => ({ ...c })));
  }

  restorePageChunks(page: number): void {
    this.chunks.set(this.pageChunksMap.get(page)?.map(c => ({ ...c })) ?? []);
    this.undoStack = [];
    this.redoStack = [];
    this.selectedChunkId.set(null);
  }

  getAllChunks(): Chunk[] {
    const current = this.currentPage();
    const result: Chunk[] = [];
    for (const [page, chunks] of this.pageChunksMap) {
      if (page !== current) result.push(...chunks);
    }
    result.push(...this.chunks());
    return result;
  }

  // ── Setters ───────────────────────────────────────────────────────────

  setImageFile(file: File, skipPreview = false): void {
    const prev = this.imageUrl();
    if (prev && prev.startsWith('blob:')) URL.revokeObjectURL(prev);
    this.imageFile.set(file);
    this.imageUrl.set(skipPreview ? null : URL.createObjectURL(file));
    this._resetChunkState();
    this.mediaType.set('image');
    this.phase.set('editor');
  }

  setAnalysisResult(
    sessionId: string,
    imagePath: string,
    boxes: AiAnalyzeBox[],
    pdfPath?: string | null,
    mType: MediaType = 'image'
  ): void {
    this.sessionId.set(sessionId);
    this.imagePath.set(imagePath);
    if (pdfPath !== undefined) this.pdfPath.set(pdfPath ?? null);
    this.mediaType.set(mType);
    const page = this.currentPage();
    this.chunks.set(
      boxes.map(b => ({
        id: b.id,
        box: b.box,
        pageNumber: page,
        label:    b.label   || b.type || 'unknown',
        summary: '',
        extractedText: b.text_content || undefined,
        title:       b.title   || b.label || b.type || 'Untitled',
        description: b.text_content || '',
        type: (b.type as ChunkType) || inferType(b.label),
        source: 'ai' as const,
        thumbnail: undefined,
        filename: b.filename || undefined,
        paragraphNumber: b.paragraph_number ?? null,
        locationInPage: b.location_in_page || undefined
      }))
    );
    this.undoStack = [];
    this.redoStack = [];
  }

  setWebpageResult(
    sessionId: string,
    imagePath: string,
    boxes: AiAnalyzeBox[],
    imageUrl: string,
    pageTitle?: string,
    sourceUrl?: string
  ): void {
    this.pageTitle.set(pageTitle ?? null);
    this.sourceUrl.set(sourceUrl ?? null);
    this.imageUrl.set(imageUrl);
    this.imagePath.set(imagePath);
    this.setAnalysisResult(sessionId, imagePath, boxes, null, 'webpage');
    this.phase.set('editor');
  }

  setTranscriptResult(res: TranscribeResponse): void {
    this.mediaType.set(res.mediaType);
    this.mediaDuration.set(res.duration);
    this.mediaFileName.set(res.fileName);
    this.fullTranscript.set(res.fullText || '');
    this.chunks.set(res.chunks.map(c => ({
      ...c,
      mediaType: res.mediaType,
      description: (c as any).text || c.description || ''
    } as Chunk)));
    this.undoStack = [];
    this.redoStack = [];
    this.selectedChunkId.set(null);
    this.phase.set('transcript');
  }

  // ── Chunk mutations ───────────────────────────────────────────────────

  updateChunk(id: string, updates: Partial<Chunk>): void {
    this.chunks.update(cs => cs.map(c => c.id === id ? { ...c, ...updates } : c));
  }

  addChunk(chunk: Chunk): void {
    this.chunks.update(cs => [...cs, chunk]);
  }

  removeChunk(id: string): void {
    this.chunks.update(cs => cs.filter(c => c.id !== id));
    if (this.selectedChunkId() === id) this.selectedChunkId.set(null);
  }

  mergeWithNext(id: string): void {
    const cs = this.chunks();
    const idx = cs.findIndex(c => c.id === id);
    if (idx < 0 || idx >= cs.length - 1) return;
    const a = cs[idx], b = cs[idx + 1];
    this.pushHistory();
    const merged: Chunk = {
      ...a,
      endTime:     b.endTime,
      description: [a.description, b.description].filter(Boolean).join('\n\n'),
      title:       a.title
    };
    this.chunks.set([...cs.slice(0, idx), merged, ...cs.slice(idx + 2)]);
    this.selectedChunkId.set(merged.id);
  }

  splitChunk(id: string): void {
    const cs = this.chunks();
    const idx = cs.findIndex(c => c.id === id);
    if (idx < 0) return;
    const chunk = cs[idx];
    if (chunk.startTime === undefined || chunk.endTime === undefined) return;

    const midTime = (chunk.startTime + chunk.endTime) / 2;
    const words   = chunk.description.split(' ');
    const half    = Math.floor(words.length / 2);
    const textA   = words.slice(0, half).join(' ');
    const textB   = words.slice(half).join(' ');

    this.pushHistory();
    const a: Chunk = { ...chunk, endTime: midTime,         description: textA, title: chunk.title + ' (1)' };
    const b: Chunk = { ...chunk, id: `user_${Date.now()}`, startTime: midTime, description: textB, title: chunk.title + ' (2)' };
    this.chunks.set([...cs.slice(0, idx), a, b, ...cs.slice(idx + 1)]);
  }

  selectChunk(id: string | null): void {
    this.selectedChunkId.set(id);
  }

  toggleAddMode(): void {
    this.isAddMode.update(v => !v);
  }

  reset(): void {
    const prev = this.imageUrl();
    if (prev && prev.startsWith('blob:')) URL.revokeObjectURL(prev);
    this.imageFile.set(null);
    this.imageUrl.set(null);
    this.mediaType.set('image');
    this._resetChunkState();
    this.pageTitle.set(null);
    this.sourceUrl.set(null);
    this.mediaDuration.set(0);
    this.mediaFileName.set(null);
    this.fullTranscript.set('');
    this.isAddMode.set(false);
    this.phase.set('upload');
    this.pageChunksMap.clear();
  }

  private _resetChunkState(): void {
    this.sessionId.set(null);
    this.imagePath.set(null);
    this.pdfPath.set(null);
    this.chunks.set([]);
    this.selectedChunkId.set(null);
    this.pdfPages.set([]);
    this.currentPage.set(1);
    this.undoStack = [];
    this.redoStack = [];
  }
}

function inferType(label: string): ChunkType {
  const l = label.toLowerCase();
  if (l.includes('chart') || l.includes('graph') || l.includes('plot')) return 'chart';
  if (l.includes('table') || l.includes('grid'))                          return 'table';
  if (l.includes('text')  || l.includes('paragraph'))                    return 'text';
  if (l.includes('diagram') || l.includes('flow'))                       return 'diagram';
  if (l.includes('header') || l.includes('title') || l.includes('footer')) return 'header';
  if (l.includes('infographic') || l.includes('kpi') || l.includes('metric')) return 'infographic';
  if (l.includes('image') || l.includes('photo') || l.includes('figure')) return 'image';
  return 'unknown';
}
