import {
  Component, AfterViewInit, OnDestroy, ViewChild, ElementRef,
  inject, NgZone, effect, ChangeDetectionStrategy, ChangeDetectorRef, HostListener, signal,
  DestroyRef
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
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
  private destroyRef = inject(DestroyRef);

  private canvas!: fabric.Canvas;
  private rectMap = new Map<string, fabric.Rect>();
  private syncingFromCanvas = false;
  private imageReady = false;

  // Image natural size — logical canvas space has image at scale=1
  private imageNaturalSize = { w: 0, h: 0 };

  // Draw mode
  private isDrawing = false;
  private drawStart = { x: 0, y: 0 };
  private activeRect: fabric.Rect | null = null;

  // Pan mode
  private isPanning = false;
  private panStart = { x: 0, y: 0 };

  // Box counter for auto-numbering (resets per image load)
  private boxCounter = 0;

  private resizeObserver?: ResizeObserver;
  private thumbnailsTimer?: ReturnType<typeof setTimeout>;
  private thumbnailTimer?: ReturnType<typeof setTimeout>;

  zoomLevel = 1;
  readonly MIN_ZOOM = 0.05;
  readonly MAX_ZOOM = 10;

  analyzeError = '';
  exportError = '';
  questionsLoading = signal(false);

  get noTextLayerWarning(): boolean {
    return !!this.state.selectedChunk()?.noTextLayer;
  }
  questionsError = signal('');

  get canUndo(): boolean { return this.state.canUndo; }
  get canRedo(): boolean { return this.state.canRedo; }

  undo(): void { this.state.undo(); this.cdr.markForCheck(); }
  redo(): void { this.state.redo(); this.cdr.markForCheck(); }

  private readonly STYLES = {
    ai:   { stroke: '#ef4444', fill: 'rgba(239,68,68,0.08)',   strokeWidth: 2, strokeUniform: true },
    user: { stroke: '#3b82f6', fill: 'rgba(59,130,246,0.08)', strokeWidth: 2, strokeUniform: true }
  };

  constructor() {
    effect(() => {
      const chunks = this.state.chunks();
      if (this.canvas && !this.syncingFromCanvas && this.imageReady) {
        this.ngZone.runOutsideAngular(() => this.syncCanvasFromChunks(chunks));
      }
    });

    effect(() => {
      const id = this.state.selectedChunkId();
      if (this.canvas) {
        this.ngZone.runOutsideAngular(() => this.highlightRect(id));
      }
    });

    effect(() => {
      const url = this.state.imageUrl();
      if (this.canvas && url) {
        this.imageReady = false;
        this.boxCounter = 0;
        this.ngZone.runOutsideAngular(() => this.loadImageOnCanvas(url));
      }
    });

    effect(() => {
      const addMode = this.state.isAddMode();
      if (this.canvas) {
        this.canvas.selection = !addMode && !this.isPanning;
        this.canvas.defaultCursor = addMode ? 'crosshair' : 'grab';
        this.canvas.hoverCursor  = addMode ? 'crosshair' : 'move';
      }
    });
  }

  // ── Keyboard shortcuts ────────────────────────────────────────────────────

  @HostListener('document:keydown', ['$event'])
  onKeyDown(e: KeyboardEvent): void {
    const tag = (e.target as HTMLElement).tagName;
    const inInput = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';

    // Undo / Redo — works even in inputs so user doesn't lose work
    if ((e.ctrlKey || e.metaKey) && e.key === 'z') {
      e.preventDefault();
      if (e.shiftKey) {
        this.ngZone.run(() => { this.state.redo(); this.cdr.markForCheck(); });
      } else {
        this.ngZone.run(() => { this.state.undo(); this.cdr.markForCheck(); });
      }
      return;
    }

    if (inInput) return;

    if (e.key === 'Escape') {
      if (this.isDrawing && this.activeRect) {
        this.canvas.remove(this.activeRect);
        this.activeRect = null;
        this.isDrawing = false;
        this.canvas.renderAll();
      }
      if (this.state.isAddMode()) {
        this.ngZone.run(() => { this.state.isAddMode.set(false); this.cdr.markForCheck(); });
      }
    }

    if (e.key === 'b' || e.key === 'B') {
      this.ngZone.run(() => { this.state.toggleAddMode(); this.cdr.markForCheck(); });
    }

    if (e.key === 'f' || e.key === 'F') {
      this.fitImageInView();
    }
  }

  ngAfterViewInit(): void {
    this.canvas = new fabric.Canvas(this.canvasRef.nativeElement, {
      selection: true,
      preserveObjectStacking: true,
      stopContextMenu: true,
      enableRetinaScaling: true
    });

    this.sizeCanvasToContainer();

    const area = this.containerRef.nativeElement.parentElement!;
    this.resizeObserver = new ResizeObserver(() => {
      this.ngZone.runOutsideAngular(() => {
        this.sizeCanvasToContainer();
        if (this.imageReady) this.fitImageInView();
      });
    });
    this.resizeObserver.observe(area);

    this.bindCanvasEvents();
  }

  ngOnDestroy(): void {
    clearTimeout(this.thumbnailsTimer);
    clearTimeout(this.thumbnailTimer);
    this.resizeObserver?.disconnect();
    this.canvas?.dispose();
  }

  // ── Canvas sizing ──────────────────────────────────────────────────────────

  private sizeCanvasToContainer(): void {
    const area = this.containerRef.nativeElement.parentElement!;
    const w = Math.max(area.clientWidth  || 900, 300);
    const h = Math.max(area.clientHeight || 600, 200);
    this.canvas.setWidth(w);
    this.canvas.setHeight(h);
  }

  // ── Image Loading ──────────────────────────────────────────────────────────

  private loadImageOnCanvas(url: string): void {
    this.rectMap.forEach(r => this.canvas.remove(r));
    this.rectMap.clear();

    fabric.Image.fromURL(url, (img) => {
      if (!img || (img.getElement() as HTMLImageElement).naturalWidth === 0) {
        this.ngZone.run(() => {
          this.analyzeError = 'Failed to load image from server. Try re-uploading the file.';
          this.cdr.markForCheck();
        });
        return;
      }
      img.scale(1);
      this.imageNaturalSize = { w: img.width! || 800, h: img.height! || 600 };

      this.canvas.setBackgroundImage(img, () => {
        this.imageReady = true;
        this.fitImageInView();
        this.canvas.renderAll();
        const chunks = this.state.chunks();
        if (chunks.length) this.syncCanvasFromChunks(chunks);
      });
    }, { crossOrigin: 'anonymous' });
  }

  // ── Viewport fit helpers ───────────────────────────────────────────────────

  private fitImageInView(): void {
    const cw = this.canvas.getWidth();
    const ch = this.canvas.getHeight();
    const { w: iw, h: ih } = this.imageNaturalSize;
    if (!iw || !ih) return;

    const zoom = Math.min(cw / iw, ch / ih);
    const offsetX = (cw - iw * zoom) / 2;
    const offsetY = (ch - ih * zoom) / 2;
    this.canvas.setViewportTransform([zoom, 0, 0, zoom, offsetX, offsetY]);
    this.zoomLevel = zoom;
    this.cdr.markForCheck();
  }

  fitWidth(): void {
    const cw = this.canvas.getWidth();
    const { w: iw } = this.imageNaturalSize;
    if (!iw) return;
    const zoom = Math.min(cw / iw, this.MAX_ZOOM);
    this.canvas.setViewportTransform([zoom, 0, 0, zoom, 0, 0]);
    this.zoomLevel = zoom;
    this.cdr.markForCheck();
  }

  // ── Zoom-to-chunk ─────────────────────────────────────────────────────────

  // Called from sidebar — selects AND pans/zooms canvas to show the chunk.
  selectAndZoom(id: string): void {
    this.state.selectChunk(id);

    const chunk = this.state.chunks().find(c => c.id === id);
    if (!chunk || !this.imageReady) return;

    const { w, h } = this.imageNaturalSize;
    const [x1, y1, x2, y2] = chunk.box;
    const chunkW = (x2 - x1) * w;
    const chunkH = (y2 - y1) * h;
    const centerX = ((x1 + x2) / 2) * w;
    const centerY = ((y1 + y2) / 2) * h;
    const cw = this.canvas.getWidth();
    const ch = this.canvas.getHeight();

    // Zoom so the chunk occupies ~60% of the viewport
    const targetZoom = Math.min(
      (cw * 0.6) / (chunkW || 1),
      (ch * 0.6) / (chunkH || 1),
      this.MAX_ZOOM
    );

    const offsetX = cw / 2 - centerX * targetZoom;
    const offsetY = ch / 2 - centerY * targetZoom;

    this.canvas.setViewportTransform([targetZoom, 0, 0, targetZoom, offsetX, offsetY]);
    this.zoomLevel = targetZoom;
    this.canvas.renderAll();
    this.cdr.markForCheck();
  }

  // ── Analyze ────────────────────────────────────────────────────────────────

  analyze(): void {
    this.analyzeError = '';
    this.exportError = '';
    this.state.isAnalyzing.set(true);
    this.cdr.markForCheck();

    const serverPath = this.state.imagePath();
    let request$;
    if (serverPath) {
      request$ = this.api.analyzeByServerPath(serverPath);
    } else {
      const file = this.state.imageFile();
      if (!file) {
        this.state.isAnalyzing.set(false);
        this.cdr.markForCheck();
        return;
      }
      request$ = this.api.analyzeImage(file);
    }

    request$.pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (res) => {
        this.ngZone.run(() => {
          this.state.setAnalysisResult(res.sessionId, res.imagePath, res.boxes, res.pdfPath);
          this.state.isAnalyzing.set(false);
          clearTimeout(this.thumbnailsTimer);
          this.thumbnailsTimer = setTimeout(() => this.generateAllThumbnails(), 300);
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
    for (const [id, rect] of this.rectMap) {
      if (!currentIds.has(id)) {
        this.canvas.remove(rect);
        this.rectMap.delete(id);
      }
    }
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

  // ── Canvas Events ──────────────────────────────────────────────────────────

  private bindCanvasEvents(): void {
    // ── Mouse wheel zoom at cursor ─────────────────────────────────────
    this.canvas.on('mouse:wheel', (opt: any) => {
      const e = opt.e as WheelEvent;
      let zoom = this.canvas.getZoom();
      if (e.deltaMode === 0) {
        // Pixel-mode (trackpad, Magic Mouse): smooth continuous zoom, capped to prevent jumps
        zoom *= 0.999 ** Math.max(-80, Math.min(80, e.deltaY));
      } else {
        // Line/page mode (mouse wheel): consistent ~10% step per notch
        zoom *= e.deltaY > 0 ? 0.9 : 1 / 0.9;
      }
      zoom = Math.max(this.MIN_ZOOM, Math.min(this.MAX_ZOOM, zoom));
      this.ngZone.run(() => this.applyZoom(zoom, new fabric.Point(e.offsetX, e.offsetY)));
      e.preventDefault();
      e.stopPropagation();
    });

    // ── Right-click cancels active draw ───────────────────────────────
    this.canvas.on('mouse:down:before', (opt: any) => {
      if (opt.e.button === 2 && this.isDrawing && this.activeRect) {
        this.canvas.remove(this.activeRect);
        this.activeRect = null;
        this.isDrawing = false;
        this.canvas.renderAll();
        opt.e.preventDefault();
      }
    });

    this.canvas.on('mouse:down', (opt: any) => {
      if (opt.e.button === 2) return;

      if (opt.e.altKey || opt.e.button === 1) {
        this.startPan(opt.e);
        return;
      }

      if (this.state.isAddMode()) {
        this.isDrawing = true;
        const p = this.canvas.getPointer(opt.e);
        this.drawStart = { x: p.x, y: p.y };
        this.activeRect = new fabric.Rect({
          left: p.x, top: p.y, width: 0, height: 0,
          ...this.STYLES.user,
          selectable: false, evented: false, opacity: 0.8
        });
        this.canvas.add(this.activeRect);
        return;
      }

      if (!opt.target) {
        this.startPan(opt.e);
      }
    });

    this.canvas.on('mouse:move', (opt: any) => {
      if (this.isPanning) {
        const vpt = this.canvas.viewportTransform!;
        vpt[4] += opt.e.clientX - this.panStart.x;
        vpt[5] += opt.e.clientY - this.panStart.y;
        this.canvas.requestRenderAll();
        this.panStart = { x: opt.e.clientX, y: opt.e.clientY };
        return;
      }

      if (!this.isDrawing || !this.activeRect) return;
      const p = this.canvas.getPointer(opt.e);
      this.activeRect.set({
        left:   Math.min(p.x, this.drawStart.x),
        top:    Math.min(p.y, this.drawStart.y),
        width:  Math.abs(p.x - this.drawStart.x),
        height: Math.abs(p.y - this.drawStart.y)
      });
      this.canvas.renderAll();
    });

    this.canvas.on('mouse:up', () => {
      if (this.isPanning) { this.endPan(); return; }

      if (!this.isDrawing || !this.activeRect) return;
      this.isDrawing = false;

      const rect = this.activeRect;
      this.activeRect = null;

      if ((rect.width ?? 0) < 10 || (rect.height ?? 0) < 10) {
        this.canvas.remove(rect);
        this.ngZone.run(() => this.cdr.markForCheck());
        return;
      }

      const id = `user_${Date.now()}`;
      rect.set({ selectable: true, evented: true, data: { chunkId: id }, opacity: 1 });
      this.attachDeleteControl(rect, id);
      this.rectMap.set(id, rect);
      rect.setCoords();

      const normalized = this.rectToNormalized(rect);
      const label = `Box ${++this.boxCounter}`;
      const [bx1, by1, bx2, by2] = normalized;
      const cx = (bx1 + bx2) / 2, cy = (by1 + by2) / 2;
      const locationInPage = `${cy < 0.33 ? 'top' : cy < 0.67 ? 'middle' : 'bottom'}-${cx < 0.33 ? 'left' : cx < 0.67 ? 'center' : 'right'}`;
      const filename = label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
      this.ngZone.run(() => {
        this.state.pushHistory();
        this.state.addChunk({
          id, box: normalized,
          pageNumber: this.state.currentPage(),
          label, summary: '',
          title: label, description: '',
          type: 'unknown', source: 'user',
          locationInPage, filename
        });
        this.state.selectChunk(id);
        this.generateThumbnail(id);
        this.extractTextForChunk(id);
        this.cdr.markForCheck();
      });

      this.canvas.setActiveObject(rect);
      this.canvas.renderAll();
    });

    // ── Selection sync ─────────────────────────────────────────────────
    this.canvas.on('selection:created', (e: any) => {
      const chunkId = e.selected?.[0]?.data?.chunkId;
      if (chunkId) this.ngZone.run(() => {
        this.state.selectChunk(chunkId);
        this.cdr.markForCheck();
      });
    });

    this.canvas.on('selection:updated', (e: any) => {
      const chunkId = e.selected?.[0]?.data?.chunkId;
      if (chunkId) this.ngZone.run(() => {
        this.state.selectChunk(chunkId);
        this.cdr.markForCheck();
      });
    });

    this.canvas.on('selection:cleared', () => {
      this.ngZone.run(() => { this.state.selectChunk(null); this.cdr.markForCheck(); });
    });

    // ── Box moved / resized ────────────────────────────────────────────
    this.canvas.on('object:modified', (e) => {
      const rect = e.target as fabric.Rect;
      const chunkId = rect.data?.chunkId as string | undefined;
      if (!chunkId) return;

      this.syncingFromCanvas = true;
      const normalized = this.rectToNormalized(rect);
      this.ngZone.run(() => {
        this.state.pushHistory();
        this.state.updateChunk(chunkId, { box: normalized, source: 'user' });
        this.generateThumbnail(chunkId);
        this.cdr.markForCheck();
      });
      Promise.resolve().then(() => { this.syncingFromCanvas = false; });
    });

    // ── Box labels drawn after each render ────────────────────────────
    let lastZoom = -1;
    let lastChunkCount = -1;
    let lastSelectedId: string | null = null;
    this.canvas.on('after:render', () => {
      if (!this.imageReady) return;
      const zoom = this.canvas.getZoom();
      if (zoom < 0.15) return;
      const chunkCount = this.state.chunks().length;
      const selectedId = this.state.selectedChunkId();
      if (zoom === lastZoom && chunkCount === lastChunkCount && selectedId === lastSelectedId) return;
      lastZoom = zoom;
      lastChunkCount = chunkCount;
      lastSelectedId = selectedId;
      this.drawBoxLabels(zoom);
    });
  }

  // ── Box label rendering ────────────────────────────────────────────────────

  private drawBoxLabels(zoom: number): void {
    const ctx = (this.canvas as any).contextContainer as CanvasRenderingContext2D;
    if (!ctx) return;
    const vpt = this.canvas.viewportTransform!;
    const chunks = this.state.chunks();
    const selectedId = this.state.selectedChunkId();
    const fontSize = 12;
    const chunkById = new Map(chunks.map(c => [c.id, c]));

    ctx.save();

    for (const [id, rect] of this.rectMap) {
      const chunk = chunkById.get(id);
      if (!chunk) continue;

      const screenX = (rect.left! * zoom) + vpt[4];
      const screenY = (rect.top!  * zoom) + vpt[5];
      const screenW = (rect.width! * (rect.scaleX ?? 1)) * zoom;

      const label    = chunk.title || chunk.label || id;
      const filename = chunk.filename || '';
      const isAi = chunk.source === 'ai';
      const isSelected = id === selectedId;
      const bgColor = isAi
        ? (isSelected ? 'rgba(239,68,68,0.95)' : 'rgba(239,68,68,0.75)')
        : (isSelected ? 'rgba(59,130,246,0.95)' : 'rgba(59,130,246,0.75)');

      const pad       = 4;
      const lineGap   = 2;
      const fileSize  = 10;
      const titleW    = ctx.measureText(label).width;
      const filenameW = filename ? ctx.measureText(filename).width : 0;
      const maxW      = Math.min(Math.max(titleW, filenameW), screenW - 4);
      const bh        = filename
        ? fontSize + lineGap + fileSize + pad * 2
        : fontSize + pad * 2;

      // Background pill
      ctx.fillStyle = bgColor;
      ctx.beginPath();
      ctx.rect(screenX + 2, screenY + 2, Math.max(maxW + pad * 2, 20), bh);
      ctx.fill();

      ctx.save();
      ctx.rect(screenX + 2, screenY + 2, screenW - 4, bh);
      ctx.clip();

      // Title line
      ctx.fillStyle = '#fff';
      ctx.font = `600 ${fontSize}px -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif`;
      ctx.fillText(label, screenX + 2 + pad, screenY + 2 + pad + fontSize - 2);

      // Filename line (smaller, slightly transparent)
      if (filename) {
        ctx.font = `400 ${fileSize}px -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif`;
        ctx.globalAlpha = 0.85;
        ctx.fillText(filename, screenX + 2 + pad, screenY + 2 + pad + fontSize + lineGap + fileSize - 2);
        ctx.globalAlpha = 1;
      }

      ctx.restore();
    }

    ctx.restore();
  }

  private startPan(e: MouseEvent): void {
    this.isPanning = true;
    this.canvas.selection = false;
    this.canvas.defaultCursor = 'grabbing';
    this.panStart = { x: e.clientX, y: e.clientY };
  }

  private endPan(): void {
    this.isPanning = false;
    const addMode = this.state.isAddMode();
    this.canvas.selection = !addMode;
    this.canvas.defaultCursor = addMode ? 'crosshair' : 'grab';
  }

  // ── Zoom Controls ──────────────────────────────────────────────────────────

  zoomIn(): void {
    const zoom = Math.min(this.canvas.getZoom() * 1.25, this.MAX_ZOOM);
    this.applyZoom(zoom);
  }

  zoomOut(): void {
    const zoom = Math.max(this.canvas.getZoom() / 1.25, this.MIN_ZOOM);
    this.applyZoom(zoom);
  }

  resetZoom(): void {
    this.fitImageInView();
  }

  private applyZoom(zoom: number, point?: fabric.Point): void {
    const p = point ?? new fabric.Point(this.canvas.getWidth() / 2, this.canvas.getHeight() / 2);
    this.canvas.zoomToPoint(p, zoom);
    this.zoomLevel = zoom;
    this.cdr.markForCheck();
  }

  get zoomPercent(): string {
    return Math.round(this.zoomLevel * 100) + '%';
  }

  // ── Duplicate selected box ─────────────────────────────────────────────────

  duplicateSelected(): void {
    const chunk = this.state.selectedChunk();
    if (!chunk) return;

    const [x1, y1, x2, y2] = chunk.box;
    const offset = 0.02;
    const newBox: [number, number, number, number] = [
      Math.min(x1 + offset, 0.95),
      Math.min(y1 + offset, 0.95),
      Math.min(x2 + offset, 1),
      Math.min(y2 + offset, 1)
    ];

    const id = `user_${Date.now()}`;
    this.state.pushHistory();
    this.state.addChunk({
      id, box: newBox,
      pageNumber: chunk.pageNumber,
      label: chunk.label,
      summary: chunk.summary,
      title: `${chunk.title} (copy)`,
      description: chunk.description,
      type: chunk.type,
      source: 'user'
    });
    this.state.selectChunk(id);
    clearTimeout(this.thumbnailTimer);
    this.thumbnailTimer = setTimeout(() => this.generateThumbnail(id), 100);
    this.cdr.markForCheck();
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
          this.state.pushHistory();
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

  private normalizedToCanvas(box: [number, number, number, number]) {
    const [x1, y1, x2, y2] = box;
    const { w, h } = this.imageNaturalSize;
    return { left: x1 * w, top: y1 * h, width: (x2 - x1) * w, height: (y2 - y1) * h };
  }

  private rectToNormalized(rect: fabric.Rect): [number, number, number, number] {
    const { w, h } = this.imageNaturalSize;
    const left = rect.left  ?? 0;
    const top  = rect.top   ?? 0;
    const rw   = (rect.width  ?? 0) * (rect.scaleX ?? 1);
    const rh   = (rect.height ?? 0) * (rect.scaleY ?? 1);
    return [
      Math.max(0, Math.min(1, left / w)),
      Math.max(0, Math.min(1, top  / h)),
      Math.max(0, Math.min(1, (left + rw) / w)),
      Math.max(0, Math.min(1, (top  + rh) / h))
    ];
  }

  // ── Thumbnails ─────────────────────────────────────────────────────────────

  generateAllThumbnails(): void {
    this.state.chunks().forEach(c => this.generateThumbnail(c.id));
    this.cdr.markForCheck();
  }

  private cropRegionToCanvas(
    chunk: Chunk,
    maxDim: number | { w: number; h: number }
  ): HTMLCanvasElement | null {
    const bgImg = this.canvas.backgroundImage as fabric.Image;
    if (!bgImg) return null;
    const imgEl = bgImg.getElement() as HTMLImageElement;
    if (!imgEl.naturalWidth) return null;
    const [x1, y1, x2, y2] = chunk.box;
    const nw = imgEl.naturalWidth, nh = imgEl.naturalHeight;
    const srcW = (x2 - x1) * nw, srcH = (y2 - y1) * nh;
    if (srcW < 1 || srcH < 1) return null;
    const scale = typeof maxDim === 'number'
      ? Math.min(1, maxDim / Math.max(srcW, srcH))
      : Math.min(maxDim.w / (srcW || 1), maxDim.h / (srcH || 1));
    const out = document.createElement('canvas');
    out.width  = Math.round(srcW * scale);
    out.height = Math.round(srcH * scale);
    const ctx = out.getContext('2d')!;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(imgEl, x1 * nw, y1 * nh, srcW, srcH, 0, 0, out.width, out.height);
    return out;
  }

  private generateThumbnail(chunkId: string): void {
    const chunk = this.state.chunks().find(c => c.id === chunkId);
    if (!chunk) return;
    const out = this.cropRegionToCanvas(chunk, { w: 240, h: 160 });
    if (!out) return;
    this.state.updateChunk(chunkId, { thumbnail: out.toDataURL('image/jpeg', 0.85) });
  }

  private generateScreenshot(chunkId: string): string | null {
    const chunk = this.state.chunks().find(c => c.id === chunkId);
    if (!chunk) return null;
    const out = this.cropRegionToCanvas(chunk, 2400);
    if (!out) return null;
    try { return out.toDataURL('image/jpeg', 0.95); } catch { return null; }
  }

  // ── Export (all pages) ────────────────────────────────────────────────────

  exportChunks(): void {
    // Capture screenshots for the current page before saving and collecting all chunks
    for (const chunk of this.state.chunks()) {
      const screenshot = this.generateScreenshot(chunk.id);
      if (screenshot) this.state.updateChunk(chunk.id, { screenshot });
    }
    this.state.savePageChunks(this.state.currentPage());
    const chunks = this.state.getAllChunks();
    if (!chunks.length) {
      this.exportError = 'No chunks to export.';
      this.cdr.markForCheck();
      return;
    }
    this.exportError = '';
    this.doExport(chunks, this.state.sessionId() ?? undefined);
  }

  private doExport(chunks: Chunk[], sessionId?: string): void {
    const chunksWithScreenshots = chunks.map(c => ({
      ...c,
      screenshot: c.screenshot ?? null
    }));

    this.state.isExporting.set(true);
    this.cdr.markForCheck();
    this.api.exportChunks(chunksWithScreenshots, sessionId, this.state.pdfPath() ?? undefined).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (blob) => {
        this.ngZone.run(() => {
          const id  = sessionId || Date.now().toString();
          const url = URL.createObjectURL(blob);
          const a   = document.createElement('a');
          a.href = url;
          a.download = `chunks_${id.slice(0, 8)}.zip`;
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

  // ── Page navigation with chunk persistence ────────────────────────────────

  goToPage(p: { page: number; imageUrl: string; imagePath: string }): void {
    if (this.state.currentPage() === p.page) return;
    // Capture screenshots before leaving so they are available in multi-page exports
    for (const chunk of this.state.chunks()) {
      const screenshot = this.generateScreenshot(chunk.id);
      if (screenshot) this.state.updateChunk(chunk.id, { screenshot });
    }
    // Persist chunks for the page we're leaving
    this.state.savePageChunks(this.state.currentPage());
    // Switch page
    this.state.currentPage.set(p.page);
    this.state.imageUrl.set(p.imageUrl);
    this.state.imagePath.set(p.imagePath);
    // Restore chunks for the new page (empty array if first visit)
    this.state.restorePageChunks(p.page);
    this.state.sessionId.set(null);
    this.analyzeError = '';
    this.cdr.markForCheck();
  }

  // ── Template helpers ───────────────────────────────────────────────────────

  get chunkTypes(): string[] {
    return ['chart', 'table', 'text', 'diagram', 'header', 'infographic', 'image', 'unknown'];
  }

  trackByChunkId(_: number, chunk: Chunk): string {
    return chunk.id;
  }

  selectChunk(id: string): void {
    this.state.selectChunk(id);
  }

  // ── Question Generation ────────────────────────────────────────────────────

  generateQuestionsForSelected(): void {
    const chunk = this.state.selectedChunk();
    if (!chunk || !chunk.description?.trim()) return;

    this.questionsLoading.set(true);
    this.questionsError.set('');
    this.api.generateQuestions(chunk.description).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (res) => {
        this.ngZone.run(() => {
          this.state.updateChunk(chunk.id, {
            questions: res.questions.map(t => ({ text: t, checked: false }))
          });
          this.questionsLoading.set(false);
          this.cdr.markForCheck();
        });
      },
      error: (err) => {
        this.ngZone.run(() => {
          this.questionsError.set(err.message || 'Failed to generate questions');
          this.questionsLoading.set(false);
          this.cdr.markForCheck();
        });
      }
    });
  }

  toggleQuestion(chunkId: string, index: number): void {
    const chunk = this.state.chunks().find(c => c.id === chunkId);
    if (!chunk?.questions) return;
    const updated = chunk.questions.map((q, i) =>
      i === index ? { ...q, checked: !q.checked } : q
    );
    this.state.updateChunk(chunkId, { questions: updated });
  }

  // ── Text Extraction ────────────────────────────────────────────────────────

  reExtractText(chunkId: string): void {
    this.extractTextForChunk(chunkId);
  }

  private extractTextForChunk(chunkId: string): void {
    const pdfPath = this.state.pdfPath();
    if (!pdfPath) return;

    const chunk = this.state.chunks().find(c => c.id === chunkId);
    if (!chunk) return;

    this.api.extractText(pdfPath, chunk.pageNumber, chunk.box).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (res) => {
        this.ngZone.run(() => {
          if (res.noTextLayer) {
            this.state.updateChunk(chunkId, { description: '', noTextLayer: true });
          } else {
            this.state.updateChunk(chunkId, {
              description: res.text,
              noTextLayer: false,
              paragraphNumber: res.paragraph_number ?? undefined
            });
          }
          this.cdr.markForCheck();
        });
      },
      error: (err) => {
        this.ngZone.run(() => {
          const msg = err?.error?.error || err?.message || 'unknown error';
          this.state.updateChunk(chunkId, { description: `⚠ Text extraction failed: ${msg}`, noTextLayer: true });
          this.cdr.markForCheck();
        });
      }
    });
  }
}
