import { Component, inject, ChangeDetectionStrategy, ChangeDetectorRef } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';

import { ChunkStateService } from '../../services/chunk-state.service';
import { ApiService } from '../../services/api.service';
import { Chunk } from '../../models/chunk.model';

@Component({
  selector: 'app-transcript-editor',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './transcript-editor.component.html',
  styleUrl: './transcript-editor.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class TranscriptEditorComponent {
  state = inject(ChunkStateService);
  private api = inject(ApiService);
  private cdr = inject(ChangeDetectorRef);

  exportError = '';
  showFullTranscript = false;

  get canUndo(): boolean { return (this.state as any).undoStack?.length > 0; }
  get canRedo(): boolean { return (this.state as any).redoStack?.length > 0; }

  undo(): void { this.state.undo(); this.cdr.markForCheck(); }
  redo(): void { this.state.redo(); this.cdr.markForCheck(); }

  formatTime(seconds: number | undefined): string {
    if (seconds === undefined || seconds === null) return '—';
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return `${m}:${s.toString().padStart(2, '0')}`;
  }

  selectChunk(id: string): void {
    this.state.selectChunk(id);
    this.cdr.markForCheck();
  }

  updateTitle(chunk: Chunk, value: string): void {
    this.state.updateChunk(chunk.id, { title: value });
  }

  updateDescription(chunk: Chunk, value: string): void {
    this.state.updateChunk(chunk.id, { description: value });
  }

  mergeWithNext(id: string): void {
    this.state.mergeWithNext(id);
    this.cdr.markForCheck();
  }

  splitChunk(id: string): void {
    this.state.splitChunk(id);
    this.cdr.markForCheck();
  }

  removeChunk(id: string): void {
    this.state.pushHistory();
    this.state.removeChunk(id);
    this.cdr.markForCheck();
  }

  exportChunks(): void {
    const chunks = this.state.chunks();
    if (!chunks.length) {
      this.exportError = 'No chunks to export.';
      this.cdr.markForCheck();
      return;
    }
    this.exportError = '';
    this.state.isExporting.set(true);
    this.cdr.markForCheck();

    this.api.exportChunks(chunks, this.state.sessionId() ?? undefined).subscribe({
      next: (blob) => {
        const id  = this.state.sessionId() || Date.now().toString();
        const url = URL.createObjectURL(blob);
        const a   = document.createElement('a');
        a.href = url;
        a.download = `transcript_${id.slice(0, 8)}.zip`;
        a.click();
        URL.revokeObjectURL(url);
        this.state.isExporting.set(false);
        this.cdr.markForCheck();
      },
      error: (err) => {
        this.exportError = err.message;
        this.state.isExporting.set(false);
        this.cdr.markForCheck();
      }
    });
  }

  reset(): void {
    this.state.reset();
    this.cdr.markForCheck();
  }

  trackByChunkId(_: number, chunk: Chunk): string {
    return chunk.id;
  }

  isLastChunk(chunk: Chunk): boolean {
    const chunks = this.state.chunks();
    return chunks[chunks.length - 1]?.id === chunk.id;
  }
}
