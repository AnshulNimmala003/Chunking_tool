import { Component, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ChunkStateService } from '../../services/chunk-state.service';
import { ApiService } from '../../services/api.service';
import { environment } from '../../../environments/environment';

type Tab = 'document' | 'media' | 'webpage';

const DOCUMENT_TYPES = new Set([
  'image/jpeg', 'image/png', 'image/webp', 'image/gif', 'application/pdf'
]);

const MEDIA_TYPES = new Set([
  'audio/mpeg', 'audio/mp3', 'audio/wav', 'audio/wave', 'audio/x-wav',
  'audio/mp4', 'audio/m4a', 'audio/x-m4a', 'audio/ogg', 'audio/webm',
  'audio/flac', 'audio/aac',
  'video/mp4', 'video/mpeg', 'video/webm', 'video/quicktime', 'video/x-msvideo'
]);

const MEDIA_EXTS = new Set([
  '.mp3','.wav','.m4a','.ogg','.flac','.aac','.weba',
  '.mp4','.mov','.webm','.avi','.mkv','.mpeg','.mpg'
]);

@Component({
  selector: 'app-upload-zone',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './upload-zone.component.html',
  styleUrl: './upload-zone.component.css'
})
export class UploadZoneComponent {
  state = inject(ChunkStateService);
  private api = inject(ApiService);

  activeTab: Tab = 'document';
  isDragging = false;
  isProcessing = false;
  processError = '';
  urlInput = '';
  urlError = '';
  isFetchingUrl = false;
  webpageMethod: 'rule' | 'ai' = 'rule';

  selectTab(tab: Tab) {
    this.activeTab = tab;
    this.processError = '';
    this.urlError = '';
  }

  // ── Drag & drop ───────────────────────────────────────────────────────

  onDragOver(e: DragEvent) {
    e.preventDefault();
    this.isDragging = true;
  }

  onDragLeave() {
    this.isDragging = false;
  }

  onDrop(e: DragEvent) {
    e.preventDefault();
    this.isDragging = false;
    const file = e.dataTransfer?.files[0];
    if (file) this.handleFile(file);
  }

  onFileSelect(e: Event) {
    const file = (e.target as HTMLInputElement).files?.[0];
    if (file) this.handleFile(file);
    (e.target as HTMLInputElement).value = '';
  }

  // ── File dispatch ─────────────────────────────────────────────────────

  private handleFile(file: File) {
    this.processError = '';
    const ext = '.' + file.name.split('.').pop()?.toLowerCase();

    if (this.activeTab === 'document') {
      if (!DOCUMENT_TYPES.has(file.type) && !['image/jpeg','image/png'].includes(file.type)) {
        this.processError = 'Please upload a JPEG, PNG, WEBP, GIF, or PDF file.';
        return;
      }
      this.loadDocumentFile(file);
    } else if (this.activeTab === 'media') {
      if (!MEDIA_TYPES.has(file.type) && !MEDIA_EXTS.has(ext)) {
        this.processError = 'Please upload an audio (MP3, WAV, M4A, OGG) or video (MP4, MOV, WEBM) file.';
        return;
      }
      this.loadMediaFile(file);
    }
  }

  // ── Document (image / PDF) ────────────────────────────────────────────

  private loadDocumentFile(file: File) {
    if (file.type === 'application/pdf') {
      this.isProcessing = true;
      this.api.previewFile(file).subscribe({
        next: (res) => {
          this.isProcessing = false;
          const pages = res.pages || [{ page: 1, imageUrl: res.imageUrl, imagePath: res.imagePath }];
          this.state.setImageFile(file, true);
          this.state.pdfPath.set(res.pdfPath ?? null);
          this.state.pdfPages.set(pages.map((p: any) => ({
            page: p.page,
            imageUrl: `${environment.apiBaseUrl}${p.imageUrl}`,
            imagePath: p.imagePath
          })));
          this.state.currentPage.set(1);
          this.state.imagePath.set(res.imagePath);
          this.state.imageUrl.set(`${environment.apiBaseUrl}${res.imageUrl}`);
        },
        error: (err) => {
          this.isProcessing = false;
          this.processError = err?.message || 'PDF preview failed.';
        }
      });
    } else {
      this.state.setImageFile(file, false);
    }
  }

  // ── Audio / Video ─────────────────────────────────────────────────────

  private loadMediaFile(file: File) {
    this.isProcessing = true;
    this.api.transcribeMedia(file).subscribe({
      next: (res) => {
        this.isProcessing = false;
        this.state.setTranscriptResult(res);
      },
      error: (err) => {
        this.isProcessing = false;
        this.processError = err?.message || 'Transcription failed. Make sure the backend is running.';
      }
    });
  }

  // ── Webpage URL ───────────────────────────────────────────────────────

  onUrlKeydown(e: KeyboardEvent) {
    if (e.key === 'Enter') this.fetchWebpage();
  }

  fetchWebpage() {
    this.urlError = '';
    const url = this.urlInput.trim();
    if (!url) { this.urlError = 'Please enter a URL.'; return; }
    if (!url.startsWith('http://') && !url.startsWith('https://')) {
      this.urlError = 'URL must start with http:// or https://';
      return;
    }

    this.isFetchingUrl = true;
    this.api.analyzeWebpage(url, this.webpageMethod).subscribe({
      next: (res) => {
        this.isFetchingUrl = false;
        this.state.setWebpageResult(
          res.sessionId,
          res.imagePath,
          res.boxes,
          `${environment.apiBaseUrl}${res.imageUrl}`,
          res.pageTitle,
          res.sourceUrl
        );
      },
      error: (err) => {
        this.isFetchingUrl = false;
        this.urlError = err?.message || 'Failed to capture webpage. Ensure the URL is publicly accessible.';
      }
    });
  }
}
