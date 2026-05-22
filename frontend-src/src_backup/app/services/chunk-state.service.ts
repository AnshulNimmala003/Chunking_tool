import { Injectable, signal, computed } from '@angular/core';
import { Chunk, ChunkType } from '../models/chunk.model';

@Injectable({ providedIn: 'root' })
export class ChunkStateService {
  // ── Image state ──────────────────────────────────────────────────────
  imageFile = signal<File | null>(null);
  imageUrl = signal<string | null>(null);

  // ── Session (returned from backend after analyze) ────────────────────
  sessionId = signal<string | null>(null);
  imagePath = signal<string | null>(null);

  // ── Chunk state ──────────────────────────────────────────────────────
  chunks = signal<Chunk[]>([]);
  selectedChunkId = signal<string | null>(null);

  // ── UI flags ─────────────────────────────────────────────────────────
  isAnalyzing = signal(false);
  isExporting = signal(false);
  isAddMode = signal(false);
  phase = signal<'upload' | 'editor'>('upload');

  // ── Derived ──────────────────────────────────────────────────────────
  selectedChunk = computed(() =>
    this.chunks().find(c => c.id === this.selectedChunkId()) ?? null
  );

  hasSession = computed(() => !!this.sessionId());

  // ── Actions ──────────────────────────────────────────────────────────
  setImageFile(file: File): void {
    if (this.imageUrl()) URL.revokeObjectURL(this.imageUrl()!);
    this.imageFile.set(file);
    this.imageUrl.set(URL.createObjectURL(file));
    this.chunks.set([]);
    this.sessionId.set(null);
    this.imagePath.set(null);
    this.selectedChunkId.set(null);
    this.phase.set('editor');
  }

  setAnalysisResult(sessionId: string, imagePath: string, boxes: AnalyzeBox[]): void {
    this.sessionId.set(sessionId);
    this.imagePath.set(imagePath);
    this.chunks.set(
      boxes.map(b => ({
        id: b.id,
        box: b.box,
        label: b.label,
        summary: b.summary,
        title: b.label,
        description: b.summary,
        type: inferType(b.label),
        source: 'ai' as const,
        thumbnail: undefined
      }))
    );
  }

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

  selectChunk(id: string | null): void {
    this.selectedChunkId.set(id);
  }

  toggleAddMode(): void {
    this.isAddMode.update(v => !v);
  }

  reset(): void {
    if (this.imageUrl()) URL.revokeObjectURL(this.imageUrl()!);
    this.imageFile.set(null);
    this.imageUrl.set(null);
    this.sessionId.set(null);
    this.imagePath.set(null);
    this.chunks.set([]);
    this.selectedChunkId.set(null);
    this.isAddMode.set(false);
    this.phase.set('upload');
  }
}

interface AnalyzeBox {
  id: string;
  box: [number, number, number, number];
  label: string;
  summary: string;
}

function inferType(label: string): ChunkType {
  const l = label.toLowerCase();
  if (l.includes('chart') || l.includes('graph') || l.includes('plot')) return 'chart';
  if (l.includes('table') || l.includes('grid')) return 'table';
  if (l.includes('text') || l.includes('paragraph') || l.includes('block')) return 'text';
  if (l.includes('diagram') || l.includes('flow') || l.includes('infographic')) return 'diagram';
  if (l.includes('title') || l.includes('header') || l.includes('footer')) return 'header';
  if (l.includes('image') || l.includes('photo') || l.includes('figure')) return 'image';
  return 'unknown';
}
