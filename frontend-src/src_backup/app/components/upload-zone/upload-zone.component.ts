import { Component, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ChunkStateService } from '../../services/chunk-state.service';

@Component({
  selector: 'app-upload-zone',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './upload-zone.component.html',
  styleUrl: './upload-zone.component.css'
})
export class UploadZoneComponent {
  state = inject(ChunkStateService);
  isDragging = false;

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
    if (file) this.loadFile(file);
  }

  onFileSelect(e: Event) {
    const file = (e.target as HTMLInputElement).files?.[0];
    if (file) this.loadFile(file);
  }

  private loadFile(file: File) {
    const allowed = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
    if (!allowed.includes(file.type)) {
      alert('Please upload a JPEG, PNG, WEBP, or GIF image.');
      return;
    }
    this.state.setImageFile(file);
  }
}
