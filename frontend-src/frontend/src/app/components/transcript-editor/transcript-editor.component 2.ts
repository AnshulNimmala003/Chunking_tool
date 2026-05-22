import {
  Component, inject, ChangeDetectionStrategy, ChangeDetectorRef, HostListener
} from '@angular/core';
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
  private api  = inject(ApiService);
  cdr  = inject(ChangeDetectorRef);

  exportError = '';
  isExporting = false;

  // ── Keyboard shortcuts ─────────────────────────────────────────────────────

  @HostListener('document:keydown', ['$event'])
  onKey(e: KeyboardEvent): void {
    const inInput = ['INPUT','TEXTAREA','SELECT'].includes((e.target as HTMLElement).tagName);
    if (inInput) return;

    const chunks = this.state.chunks();
    const selId  = this.state.selectedChunkId();
    const idx    = chunks.findIndex(c => c.id === selId);

    if (e.key === 'ArrowDown' && idx < chunks.length - 1) {
      this.state.selectChunk(chunks[idx + 1].id);
      this.cdr.markForCheck();
    }
    if (e.key === 'ArrowUp' && idx > 0) {
      this.state.selectChunk(chunks[idx - 1].id);
      this.cdr.markForCheck();
    }
    if ((e.ctrlKey || e.metaKey) && e.key === 'z') {
      e.preventDefault();
      e.shiftKey ? this.state.redo() : this.state.undo();
      this.cdr.markForCheck();
    }
  }

  // ── Selection ──────────────────────────────────────────────────────────────

  select(id: string): void {
    this.state.selectChunk(id);
    this.cdr.markForCheck();
  }

  // ── Merge / Split ──────────────────────────────────────────────────────────

  mergeWithNext(id: string, e: Event): void {
    e.stopPropagation();
    this.state.mergeWithNext(id);
    this.cdr.markForCheck();
  }

  splitChunk(id: string, e: Event): void {
    e.stopPropagation();
    this.state.splitChunk(id);
    this.cdr.markForCheck();
  }

  deleteChunk(id: string, e: Event): void {
    e.stopPropagation();
    this.state.pushHistory();
    this.state.removeChunk(id);
    this.cdr.markForCheck();
  }

  // ── Add chunk ──────────────────────────────────────────────────────────────

  addChunk(): void {
    const chunks = this.state.chunks();
    const last   = chunks[chunks.length - 1];
    const startTime = last?.endTime ?? 0;
    const id = `user_${Date.now()}`;
    this.state.pushHistory();
    this.state.addChunk({
      id, box: [0,0,0,0], pageNumber: 1,
      label: 'topic', summary: '',
      title: 'New Chunk',
      description: '',
      type: 'topic',
      source: 'user',
      startTime,
      endTime: startTime + 60,
      mediaType: this.state.mediaType()
    });
    this.state.selectChunk(id);
    this.cdr.markForCheck();
  }

  // ── Export ─────────────────────────────────────────────────────────────────

  exportChunks(): void {
    this.exportError = '';
    const chunks = this.state.chunks();
    if (!chunks.length) { this.exportError = 'No chunks to export.'; return; }

    this.isExporting = true;
    this.cdr.markForCheck();

    this.api.exportChunks(chunks, this.state.sessionId() ?? undefined).subscribe({
      next: (blob) => {
        const sessionId = this.state.sessionId() || Date.now().toString();
        const url = URL.createObjectURL(blob);
        const a   = document.createElement('a');
        a.href = url;
        a.download = `transcript_${sessionId.slice(0, 8)}.zip`;
        a.click();
        URL.revokeObjectURL(url);
        this.isExporting = false;
        this.cdr.markForCheck();
      },
      error: (err) => {
        this.exportError = err.message;
        this.isExporting = false;
        this.cdr.markForCheck();
      }
    });
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  formatTime(seconds: number | undefined): string {
    if (seconds === undefined || isNaN(seconds)) return '--:--';
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    if (h > 0) return `${h}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
    return `${m}:${String(s).padStart(2,'0')}`;
  }

  formatDuration(secs: number): string {
    return this.formatTime(secs);
  }

  get totalChunks(): number { return this.state.chunks().length; }

  get chunkTypes(): string[] {
    return ['introduction','explanation','demonstration','discussion','analysis','conclusion','topic',
            'chart','table','text','diagram','header','infographic','image','unknown'];
  }

  canMergeWithNext(id: string): boolean {
    const cs = this.state.chunks();
    return cs.findIndex(c => c.id === id) < cs.length - 1;
  }

  canSplit(chunk: Chunk): boolean {
    return chunk.startTime !== undefined && chunk.endTime !== undefined &&
           (chunk.endTime - chunk.startTime) > 10;
  }

  trackById(_: number, c: Chunk): string { return c.id; }

  isLast(id: string): boolean {
    const cs = this.state.chunks();
    return cs[cs.length - 1]?.id === id;
  }
}
