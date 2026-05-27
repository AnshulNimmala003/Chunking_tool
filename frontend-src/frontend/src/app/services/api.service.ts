import { Injectable } from '@angular/core';
import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { Observable, throwError, of } from 'rxjs';
import { catchError, timeout, map, retry } from 'rxjs/operators';
import { AnalyzeResponse, Chunk, TranscribeResponse } from '../models/chunk.model';
import { environment } from '../../environments/environment';

export interface PreviewResponse {
  imageUrl:   string;
  imagePath:  string;
  pdfPath:    string | null;
  totalPages: number;
  pages: Array<{ page: number; imageUrl: string; imagePath: string; pdfPath?: string }>;
}

export interface WebpageResponse extends AnalyzeResponse {
  pageTitle?: string;
  sourceUrl?: string;
}

@Injectable({ providedIn: 'root' })
export class ApiService {
  private readonly baseUrl = `${environment.apiBaseUrl}/api`;
  private readonly rootUrl = environment.apiBaseUrl;

  constructor(private http: HttpClient) {}

  checkHealth(): Observable<boolean> {
    return this.http.get<{ status: string }>(`${this.rootUrl}/health`).pipe(
      timeout(3000),
      map(r => r.status === 'ok'),
      catchError(() => of(false))
    );
  }

  previewFile(file: File): Observable<PreviewResponse> {
    const form = new FormData();
    form.append('image', file);
    return this.http.post<PreviewResponse>(`${this.baseUrl}/preview`, form)
      .pipe(timeout(60000), catchError(this.handleError));
  }

  analyzeImage(file: File): Observable<AnalyzeResponse> {
    const form = new FormData();
    form.append('image', file);
    return this.http
      .post<AnalyzeResponse>(`${this.baseUrl}/analyze`, form)
      .pipe(timeout(120000), retry({ count: 1, delay: 1500 }), catchError(this.handleError));
  }

  analyzeByServerPath(serverImagePath: string): Observable<AnalyzeResponse> {
    return this.http
      .post<AnalyzeResponse>(`${this.baseUrl}/analyze/by-path`, { imagePath: serverImagePath })
      .pipe(timeout(120000), retry({ count: 1, delay: 1500 }), catchError(this.handleError));
  }

  /** Transcribe audio or video file into semantic chunks. */
  transcribeMedia(file: File): Observable<TranscribeResponse> {
    const form = new FormData();
    form.append('media', file);
    return this.http
      .post<TranscribeResponse>(`${this.baseUrl}/transcribe`, form)
      .pipe(timeout(300000), catchError(this.handleError));  // 5 min timeout for large files
  }

  /** Screenshot a URL and chunk it — rule-based (DOM) or AI (Gemini). */
  analyzeWebpage(url: string, method: 'rule' | 'ai' = 'ai'): Observable<WebpageResponse> {
    return this.http
      .post<WebpageResponse>(`${this.baseUrl}/webpage`, { url, method })
      .pipe(timeout(120000), catchError(this.handleError));
  }

  createSession(file: File): Observable<{ sessionId: string; imagePath: string; imageUrl: string }> {
    const form = new FormData();
    form.append('image', file);
    return this.http.post<any>(`${this.baseUrl}/session/create`, form)
      .pipe(timeout(30000), catchError(this.handleError));
  }

  createSessionByPath(imagePath: string): Observable<{ sessionId: string; imagePath: string; imageUrl: string }> {
    return this.http.post<any>(`${this.baseUrl}/session/create-by-path`, { imagePath })
      .pipe(timeout(10000), catchError(this.handleError));
  }

  generateQuestions(text: string): Observable<{ questions: string[] }> {
    return this.http.post<{ questions: string[] }>(
      `${this.baseUrl}/generate-questions`,
      { text }
    ).pipe(timeout(90000), catchError(this.handleError));
  }

  extractText(pdfPath: string, pageNum: number, box: [number, number, number, number]): Observable<{ text: string; noTextLayer: boolean; paragraph_number: number | null }> {
    return this.http.post<{ text: string; noTextLayer: boolean; paragraph_number: number | null }>(
      `${this.baseUrl}/extract-text`,
      { pdfPath, pageNum, box }
    ).pipe(timeout(45000), catchError(this.handleError));
  }

  exportChunks(chunks: (Chunk & { screenshot?: string | null })[], sessionId?: string, pdfPath?: string): Observable<Blob> {
    const payload: Record<string, unknown> = {
      sessionId,
      pdfPath,
      chunks: chunks.map(c => ({
        id:              c.id,
        box:             c.box,
        pageNumber:      c.pageNumber,
        label:           c.label,
        title:           c.title || c.label,
        filename:        c.filename || '',
        extracted_text:  c.description || c.extractedText || '',
        type:            c.type,
        screenshot:      c.screenshot ?? null,
        start_time:      c.startTime,
        end_time:        c.endTime,
        paragraphNumber: c.paragraphNumber,
        locationInPage:  c.locationInPage
      }))
    };
    return this.http
      .post(`${this.baseUrl}/export`, payload, { responseType: 'blob' })
      .pipe(timeout(120000), catchError(this.handleError));
  }

  private handleError(err: any) {
    if (err instanceof HttpErrorResponse && err.status === 0) {
      return throwError(() => new Error(
        `Cannot reach backend at ${environment.apiBaseUrl}. ` +
        'The server may be starting up — please wait a moment and try again.'
      ));
    }
    if (err.name === 'TimeoutError') {
      return throwError(() => new Error(
        'Request timed out — the server is taking too long. Try again or check backend logs.'
      ));
    }
    const message = err.error instanceof Blob
      ? 'Export failed — check backend logs'
      : (err.error?.error ?? err.message);
    return throwError(() => new Error(message));
  }
}
