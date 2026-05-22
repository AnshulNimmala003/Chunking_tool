import { Component, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { UploadZoneComponent } from './components/upload-zone/upload-zone.component';
import { CanvasEditorComponent } from './components/canvas-editor/canvas-editor.component';
import { ChunkStateService } from './services/chunk-state.service';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [CommonModule, UploadZoneComponent, CanvasEditorComponent],
  templateUrl: './app.component.html',
  styleUrl: './app.component.css'
})
export class AppComponent {
  state = inject(ChunkStateService);
}
