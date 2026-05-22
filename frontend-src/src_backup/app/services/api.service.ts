import { Injectable } from '@angular/core';
import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { Observable, throwError } from 'rxjs';
import { catchError } from 'rxjs/operators';
import { AnalyzeResponse, Chunk } from '../models/chunk.model';

@Injectable({ providedIn: 'root' })
export class ApiService {
  // Change this to match your admin console API gateway if needed
  private readonly baseUrl = 'http://localhost:3001/api';

  constructor(private http: HttpClient) {}

  analyzeImage(file: File): Observable<AnalyzeResponse> {
    const form = new FormData();
    form.append('image', file);
    return this.http
      .post<AnalyzeResponse>(`${this.baseUrl}/analyze`, form)
      .pipe(catchError(this.handleError));
  }

  exportChunks(sessionId: string, imagePath: string, chunks: Chunk[]): Observable<Blob> {
    const payload = {
      sessionId,
      imagePath,
      chunks: chunks.map(c => ({
        id: c.id,
        box: c.box,
        label: c.label,
        title: c.title || c.label,
        description: c.description || c.summary,
        type: c.type,
        summary: c.summary
      }))
    };
    return this.http
      .post(`${this.baseUrl}/export`, payload, { responseType: 'blob' })
      .pipe(catchError(this.handleError));
  }

  private handleError(err: HttpErrorResponse) {
    const message = err.error instanceof Blob
      ? 'Export failed — check backend logs'
      : (err.error?.error ?? err.message);
    return throwError(() => new Error(message));
  }
}
