import {
  Component, AfterViewInit, OnDestroy, ViewChild, ElementRef,
  inject, NgZone, effect, ChangeDetectionStrategy, ChangeDetectorRef
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { fabric } from 'fabric';

import { ChunkStateService } from '../../services/chunk-state.service';
import { ApiService } from '../../services/api.service';
import { Chunk } from '../../models/chunk.model';

@Component({
  selector: 'app-canvas-editor',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './canvas-editor.component.html',
  styleUrl: './canvas-editor.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class CanvasEditorComponent implements AfterViewInit, OnDestroy {
  @ViewChild('fabricCanvas') canvasRef!: ElementRef<HTMLCanvasElement>;
  @ViewChild('canvasContainer') containerRef!: ElementRef<HTMLDivElement>;

  state = inject(ChunkStateService);
  private api = inject(ApiService);
  private ngZone = inject(NgZone);
  private cdr = inject(ChangeDetectorRef);

  private canvas!: fabric.Canvas;
  // Maps chunkId → Fabric rect for O(1) lookup
  private rectMap = new Map<string, fabric.Rect>();
  // Prevents service→canvas→service update loops
  private syncingFromCanvas = false;
  // Guards against rendering boxes before background image is ready
  private imageReady = false;

  // Draw-mode state
  private isDrawing = false;
  private drawStart = { x: 0, y: 0 };
  private activeRect: fabric.Rect | null = null;

  analyzeError = '';
  exportError = '';

  // Box color palette
  private readonly STYLES = {
    ai:   { stroke: '#ef4444', fill: 'rgba(239,68,68,0.08)',   strokeWidth: 2, strokeUniform: true },
    user: { stroke: '#3b82f6', fill: 'rgba(59,130,246,0.08)', strokeWidth: 2, strokeUniform: true }
  };

  constructor() {
    // ── Effect 1: Re-render canvas boxes when chunks change in service
    effect(() => {
      const chunks = this.state.chunks();
      if (this.canvas && !this.syncingFromCanvas && this.imageReady) {
        this.ngZone.runOutsideAngular(() => this.syncCanvasFromChunks(chunks));
      }
    });

    // ── Effect 2: Highlight box when sidebar selection changes
    effect(() => {
      const id = this.state.selectedChunkId();
      if (this.canvas) {
        this.ngZone.runOutsideAngular(() => this.highlightRect(id));
      }
    });

    // ── Effect 3: Load new image when URL changes (new upload)
    effect(() => {
      const url = this.state.imageUrl();
      if (this.canvas && url) {
        this.imageReady = false;
        this.ngZone.runOutsideAngular(() => this.loadImageOnCanvas(url));
      }
    });

    // ── Effect 4: Toggle canvas cursor/selection mode
    effect(() => {
      const addMode = this.state.isAddMode();
      if (this.canvas) {
        this.canvas.selection = !addMode;
        this.canvas.defaultCursor = addMode ? 'crosshair' : 'default';
        this.canvas.hoverCursor = addMode ? 'crosshair' : 'move';
      }
    });
  }

  ngAfterViewInit(): void {
    this.canvas = new fabric.Canvas(this.canvasRef.nativeElement, {
      selection: true,
      preserveObjectStacking: true,
      stopContextMenu: true
    });

    this.bindCanvasEvents();

    // If image already set (navigating back to editor), load it
    const url = this.state.imageUrl();
    if (url) {
      this.imageReady = false;
      this.loadImageOnCanvas(url);
    }
  }

  ngOnDestroy(): void {
    this.canvas?.dispose();
  }

  // ── Image Loading ──────────────────────────────────────────────────────────

  private loadImageOnCanvas(url: string): void {
    // Clear existing rects
    this.rectMap.forEach(r => this.canvas.remove(r));
    this.rectMap.clear();

    const container = this.containerRef.nativeElement;

    fabric.Image.fromURL(url, (img) => {
      const maxW = container.clientWidth || 1000;
      const maxH = Math.min(window.innerHeight * 0.85, 1000);
      const scale = Math.min(maxW / img.width!, maxH / img.height!);

      this.canvas.setWidth(Math.round(img.width! * scale));
      this.canvas.setHeight(Math.round(img.height! * scale));
      img.scale(scale);

      this.canvas.setBackgroundImage(img, () => {
        this.imageReady = true;
        this.canvas.renderAll();
        // Render any pre-existing chunks (e.g. if user navigated back)
        const chunks = this.state.chunks();
        if (chunks.length) this.syncCanvasFromChunks(chunks);
      });
    }, { crossOrigin: 'anonymous' });
  }

  // ── Analyze ────────────────────────────────────────────────────────────────

  analyze(): void {
    const file = this.state.imageFile();
    if (!file) return;

    this.analyzeError = '';
    this.exportError = '';
    this.state.isAnalyzing.set(true);

    this.api.analyzeImage(file).subscribe({
      next: (res) => {
        this.ngZone.run(() => {
          this.state.setAnalysisResult(res.sessionId, res.imagePath, res.boxes);
          this.state.isAnalyzing.set(false);
          // Delay thumbnail generation until background image settles
          setTimeout(() => this.generateAllThumbnails(), 300);
          this.cdr.markForCheck();
        });
      },
      error: (err) => {
        this.ngZone.run(() => {
          this.analyzeError = err.message;
          this.state.isAnalyzing.set(false);
          this.cdr.markForCheck();
        });
      }
    });
  }

  // ── Canvas ↔ Service Sync ──────────────────────────────────────────────────

  private syncCanvasFromChunks(chunks: Chunk[]): void {
    const currentIds = new Set(chunks.map(c => c.id));

    // Remove stale rects
    for (const [id, rect] of this.rectMap) {
      if (!currentIds.has(id)) {
        this.canvas.remove(rect);
        this.rectMap.delete(id);
      }
    }

    // Add or update rects
    for (const chunk of chunks) {
      if (this.rectMap.has(chunk.id)) {
        this.updateRectCoords(chunk);
      } else {
        this.createRectForChunk(chunk);
      }
    }

    this.canvas.renderAll();
  }

  private createRectForChunk(chunk: Chunk): void {
    const { left, top, width, height } = this.normalizedToCanvas(chunk.box);

    const rect = new fabric.Rect({
      left, top, width, height,
      ...this.STYLES[chunk.source === 'ai' ? 'ai' : 'user'],
      data: { chunkId: chunk.id }
    });

    this.attachDeleteControl(rect, chunk.id);
    this.canvas.add(rect);
    this.rectMap.set(chunk.id, rect);
  }

  private updateRectCoords(chunk: Chunk): void {
    const rect = this.rectMap.get(chunk.id);
    if (!rect) return;
    const { left, top, width, height } = this.normalizedToCanvas(chunk.box);
    rect.set({ left, top, width, height, scaleX: 1, scaleY: 1 });
    rect.setCoords();
  }

  private highlightRect(id: string | null): void {
    this.canvas.discardActiveObject();
    if (id) {
      const rect = this.rectMap.get(id);
      if (rect) this.canvas.setActiveObject(rect);
    }
    this.canvas.renderAll();
  }

  // ── Canvas Event Binding ───────────────────────────────────────────────────

  private bindCanvasEvents(): void {
    // Box moved or resized → update service
    this.canvas.on('object:modified', (e) => {
      const rect = e.target as fabric.Rect;
      const chunkId = rect.data?.chunkId as string | undefined;
      if (!chunkId) return;

      this.syncingFromCanvas = true;
      const normalized = this.rectToNormalized(rect);
      this.ngZone.run(() => {
        this.state.updateChunk(chunkId, { box: normalized, source: 'user' });
        this.generateThumbnail(chunkId);
        this.cdr.markForCheck();
      });
      // Reset AFTER the angular run finishes (next microtask)
      Promise.resolve().then(() => { this.syncingFromCanvas = false; });
    });

    // Selection → update service
    this.canvas.on('selection:created', (e: any) => {
      const chunkId = e.selected?.[0]?.data?.chunkId;
      if (chunkId) this.ngZone.run(() => { this.state.selectChunk(chunkId); this.cdr.markForCheck(); });
    });

    this.canvas.on('selection:updated', (e: any) => {
      const chunkId = e.selected?.[0]?.data?.chunkId;
      if (chunkId) this.ngZone.run(() => { this.state.selectChunk(chunkId); this.cdr.markForCheck(); });
    });

    this.canvas.on('selection:cleared', () => {
      this.ngZone.run(() => { this.state.selectChunk(null); this.cdr.markForCheck(); });
    });

    // Draw mode: mouse:down → mouse:move → mouse:up
    this.canvas.on('mouse:down', (e) => {
      if (!this.state.isAddMode()) return;
      this.isDrawing = true;
      const p = this.canvas.getPointer(e.e);
      this.drawStart = { x: p.x, y: p.y };

      this.activeRect = new fabric.Rect({
        left: p.x, top: p.y, width: 0, height: 0,
        ...this.STYLES.user,
        selectable: false, evented: false, opacity: 0.8
      });
      this.canvas.add(this.activeRect);
    });

    this.canvas.on('mouse:move', (e) => {
      if (!this.isDrawing || !this.activeRect) return;
      const p = this.canvas.getPointer(e.e);
      this.activeRect.set({
        left: Math.min(p.x, this.drawStart.x),
        top:  Math.min(p.y, this.drawStart.y),
        width:  Math.abs(p.x - this.drawStart.x),
        height: Math.abs(p.y - this.drawStart.y)
      });
      this.canvas.renderAll();
    });

    this.canvas.on('mouse:up', () => {
      if (!this.isDrawing || !this.activeRect) return;
      this.isDrawing = false;

      const rect = this.activeRect;
      this.activeRect = null;

      // Discard tiny/accidental draws
      if ((rect.width ?? 0) < 10 || (rect.height ?? 0) < 10) {
        this.canvas.remove(rect);
        this.ngZone.run(() => { this.state.isAddMode.set(false); this.cdr.markForCheck(); });
        return;
      }

      const id = `user_${Date.now()}`;
      rect.set({ selectable: true, evented: true, data: { chunkId: id }, opacity: 1 });
      this.attachDeleteControl(rect, id);
      this.rectMap.set(id, rect);
      rect.setCoords();

      const normalized = this.rectToNormalized(rect);
      this.ngZone.run(() => {
        this.state.addChunk({
          id, box: normalized,
          label: 'User Box', summary: '',
          title: 'User Box', description: '',
          type: 'unknown', source: 'user'
        });
        this.state.selectChunk(id);
        this.state.isAddMode.set(false);
        this.generateThumbnail(id);
        this.cdr.markForCheck();
      });

      this.canvas.setActiveObject(rect);
      this.canvas.renderAll();
    });
  }

  // ── Delete Control ─────────────────────────────────────────────────────────

  private attachDeleteControl(rect: fabric.Rect, chunkId: string): void {
    rect.controls = {
      ...rect.controls,
      deleteControl: new (fabric as any).Control({
        x: 0.5, y: -0.5,
        offsetY: -16, offsetX: 16,
        cursorStyle: 'pointer',
        mouseUpHandler: () => {
          this.canvas.remove(rect);
          this.rectMap.delete(chunkId);
          this.canvas.renderAll();
          this.ngZone.run(() => {
            this.state.removeChunk(chunkId);
            this.cdr.markForCheck();
          });
          return true;
        },
        render: (ctx: CanvasRenderingContext2D, left: number, top: number) => {
          ctx.save();
          ctx.beginPath();
          ctx.arc(left, top, 9, 0, 2 * Math.PI);
          ctx.fillStyle = '#ef4444';
          ctx.fill();
          ctx.strokeStyle = '#fff';
          ctx.lineWidth = 1.5;
          ctx.stroke();
          ctx.beginPath();
          ctx.strokeStyle = '#fff';
          ctx.lineWidth = 2;
          ctx.lineCap = 'round';
          ctx.moveTo(left - 4, top - 4); ctx.lineTo(left + 4, top + 4);
          ctx.moveTo(left + 4, top - 4); ctx.lineTo(left - 4, top + 4);
          ctx.stroke();
          ctx.restore();
        }
      })
    };
  }

  // ── Coordinate Conversion ──────────────────────────────────────────────────

  // Normalized [x1,y1,x2,y2] → Fabric canvas pixel coords
  private normalizedToCanvas(box: [number, number, number, number]) {
    const [x1, y1, x2, y2] = box;
    const cw = this.canvas.getWidth();
    const ch = this.canvas.getHeight();
    return {
      left:   x1 * cw,
      top:    y1 * ch,
      width:  (x2 - x1) * cw,
      height: (y2 - y1) * ch
    };
  }

  // Fabric Rect → normalized [x1,y1,x2,y2]
  // Accounts for scaleX/scaleY that Fabric sets when user resizes a rect
  private rectToNormalized(rect: fabric.Rect): [number, number, number, number] {
    const cw = this.canvas.getWidth();
    const ch = this.canvas.getHeight();
    const left = rect.left  ?? 0;
    const top  = rect.top   ?? 0;
    const w    = (rect.width  ?? 0) * (rect.scaleX ?? 1);
    const h    = (rect.height ?? 0) * (rect.scaleY ?? 1);
    return [
      Math.max(0, Math.min(1, left / cw)),
      Math.max(0, Math.min(1, top  / ch)),
      Math.max(0, Math.min(1, (left + w) / cw)),
      Math.max(0, Math.min(1, (top  + h) / ch))
    ];
  }

  // ── Thumbnails ─────────────────────────────────────────────────────────────

  generateAllThumbnails(): void {
    this.state.chunks().forEach(c => this.generateThumbnail(c.id));
    this.cdr.markForCheck();
  }

  private generateThumbnail(chunkId: string): void {
    const chunk = this.state.chunks().find(c => c.id === chunkId);
    if (!chunk) return;

    const bgImg = this.canvas.backgroundImage as fabric.Image;
    if (!bgImg) return;

    const imgEl = bgImg.getElement() as HTMLImageElement;
    const [x1, y1, x2, y2] = chunk.box;
    const nw = imgEl.naturalWidth;
    const nh = imgEl.naturalHeight;

    const thumb = document.createElement('canvas');
    thumb.width  = 120;
    thumb.height = 80;
    const ctx = thumb.getContext('2d')!;
    ctx.drawImage(imgEl, x1 * nw, y1 * nh, (x2 - x1) * nw, (y2 - y1) * nh, 0, 0, 120, 80);
    this.state.updateChunk(chunkId, { thumbnail: thumb.toDataURL('image/jpeg', 0.75) });
  }

  // ── Export ─────────────────────────────────────────────────────────────────

  exportChunks(): void {
    const sessionId  = this.state.sessionId();
    const imagePath  = this.state.imagePath();
    const chunks     = this.state.chunks();

    if (!sessionId || !imagePath) {
      this.exportError = 'Run "Analyze with Gemini" first to create a session.';
      this.cdr.markForCheck();
      return;
    }
    if (!chunks.length) {
      this.exportError = 'No chunks to export.';
      this.cdr.markForCheck();
      return;
    }

    this.exportError = '';
    this.state.isExporting.set(true);

    this.api.exportChunks(sessionId, imagePath, chunks).subscribe({
      next: (blob) => {
        this.ngZone.run(() => {
          const url = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = url;
          a.download = `chunks_${sessionId.slice(0, 8)}.zip`;
          a.click();
          URL.revokeObjectURL(url);
          this.state.isExporting.set(false);
          this.cdr.markForCheck();
        });
      },
      error: (err) => {
        this.ngZone.run(() => {
          this.exportError = err.message;
          this.state.isExporting.set(false);
          this.cdr.markForCheck();
        });
      }
    });
  }

  // ── Template helpers ───────────────────────────────────────────────────────

  get chunkTypes(): string[] {
    return ['chart', 'table', 'text', 'diagram', 'header', 'image', 'unknown'];
  }

  trackByChunkId(_: number, chunk: Chunk): string {
    return chunk.id;
  }

  selectChunk(id: string): void {
    this.state.selectChunk(id);
  }
}
