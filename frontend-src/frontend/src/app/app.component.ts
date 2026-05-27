import { Component, inject, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { HttpClient } from '@angular/common/http';

import { UploadZoneComponent }      from './components/upload-zone/upload-zone.component';
import { CanvasEditorComponent }    from './components/canvas-editor/canvas-editor.component';
import { TranscriptEditorComponent } from './components/transcript-editor/transcript-editor.component';
import { ChunkStateService }        from './services/chunk-state.service';
import { environment } from '../environments/environment';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [CommonModule, UploadZoneComponent, CanvasEditorComponent, TranscriptEditorComponent],
  templateUrl: './app.component.html',
  styleUrl: './app.component.css'
})
export class AppComponent implements OnInit {
  state = inject(ChunkStateService);
  private http = inject(HttpClient);

  isMockMode = true;

  ngOnInit() {
    this.http.get<{ status: string; mockMode: boolean }>(`${environment.apiBaseUrl}/health`).subscribe({
      next:  (res) => { this.isMockMode = res.mockMode; },
      error: ()    => { this.isMockMode = true; }
    });
  }

  get headerLabel(): string {
    const mt = this.state.mediaType();
    if (mt === 'audio')   return state_label('Audio', this.state.mediaFileName());
    if (mt === 'video')   return state_label('Video', this.state.mediaFileName());
    if (mt === 'webpage') return state_label('Webpage', this.state.pageTitle() || this.state.sourceUrl());
    return this.state.imageFile()?.name ?? '';
  }
}

function state_label(type: string, name: string | null | undefined): string {
  return name ? `${type}: ${name}` : type;
}
