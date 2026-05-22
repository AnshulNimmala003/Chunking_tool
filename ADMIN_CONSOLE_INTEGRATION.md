# Admin Console Integration Plan

**Goal:** Connect the HITL Chunking tool to the Admin Console's File Management section so that chunks can be saved directly as images on a file record, replacing the manual "Zoomed-In Images" upload step.

---

## Systems Involved

| System | Stack | Location |
|---|---|---|
| HITL Chunking Tool | Node.js backend + Angular 17 frontend | `~/Desktop/human in loop chunkng /` |
| Admin Console Frontend | Angular 9 | `~/Downloads/gsk-admin-console-fe-test/` |
| Admin Console Backend | Hapi.js + MySQL + AWS S3 | `~/Downloads/gsk-adminconsole-be-test-2/` |

---

## How the Admin Console Currently Works

### File lifecycle
```
User uploads PDF
    → POST /api/file-urls/upload
    → File saved to S3 (AI_files/{client_id}/...)
    → DB record created: file_sync_status = 0  ("Non Vectorized")

User clicks "Sync AI"
    → POST /api/file-urls/{id}/sync-ai
    → File sent to OpenAI vector store OR Gemini file search store
    → DB updated: file_sync_status = 1  ("Vectorized")
```

### Image (chunk) storage
Each file can have multiple associated images stored in the `file_image` table, uploaded via:
```
POST /api/file-urls/{id}/images
```

These images are what appear as "Zoomed-In Images" and "Zoomed-Out Images" in the Add New File form.

---

## Data Mapping — HITL Chunks → Admin Console Images

Every chunk produced by the HITL tool maps directly to an existing `file_image` field:

| HITL Chunk Field | Admin Console `file_image` Field | Notes |
|---|---|---|
| chunk `.jpeg` screenshot | `image_s3_url` (uploaded file) | The visual snapshot of the chunk region |
| `description` / `.txt` text | `image_description` | Extracted text from the PDF region |
| `title` | `image_url_title` | Human-readable label |
| `type` (Text / Chart / etc.) | `image_type` | Already uses same vocabulary |
| `locationInPage` (e.g. `"top-right"`) | `image_source_document_location` | Coarse grid position |
| `pageNumber` | `image_source_document_name` | Page reference |
| `paragraphNumber` | `image_source_document_url` | Paragraph reference (repurposed field) |
| fixed: `"zoom_in"` | `zoom_level` | All chunks are zoom-in images |

---

## Recommended Integration: "Chunk" Button → New Tab Flow

### Why this approach
- **Zero backend changes** — uses existing `POST /api/file-urls/{id}/images` endpoint
- **No CORS issues** — new tab avoids cross-origin iframe restrictions
- **Minimal risk** — both tools continue to work independently; integration is additive
- **Auth is simple** — token passed as URL param, no `postMessage` coordination needed

### User flow
```
File Management table
    → User clicks "✂ Chunk" on a file row
    → New tab opens: http://localhost:4201?fileId=123&s3Url=...&token=...&apiBase=...
    → HITL tool loads the file directly from S3 (no re-upload)
    → User analyzes, draws boxes, edits metadata
    → User clicks "Save Chunks to Console" (replaces "Finalize & Export" in this mode)
    → Each chunk JPEG + metadata POSTed to /api/file-urls/{fileId}/images
    → Tab closes / user returns to admin console
    → File's images now contain all chunks
    → User clicks "Sync AI" to vectorize
```

---

## Implementation Plan

### Phase 1 — Admin Console Frontend (Angular 9)

**File:** `src/app/file-management/file-management.component.html`

Add a "Chunk" button to each row in the file table, next to the existing action buttons:
```html
<button class="btn btn-sm btn-outline-primary" (click)="openChunker(file)" title="Open HITL Chunking Tool">
  ✂ Chunk
</button>
```

**File:** `src/app/file-management/file-management.component.ts`

Add the `openChunker` method:
```typescript
openChunker(file: any): void {
  const token = this.authService.currentUserValue.token;
  const params = new URLSearchParams({
    fileId:   file.file_urls_id,
    s3Url:    file.file_s3_url,
    token:    token,
    apiBase:  environment.apiUrl,
    fileName: file.file_name
  });
  window.open(`http://localhost:4201?${params.toString()}`, '_blank');
}
```

**No other admin console changes needed** — no backend, no new routes, no new services.

---

### Phase 2 — HITL Tool: URL Param Detection

**File:** `frontend-src/frontend/src/app/components/canvas-editor/canvas-editor.component.ts`

On `ngOnInit`, check for URL params:
```typescript
const params = new URLSearchParams(window.location.search);
const fileId  = params.get('fileId');
const s3Url   = params.get('s3Url');
const token   = params.get('token');
const apiBase = params.get('apiBase');

if (fileId && s3Url && token && apiBase) {
  this.consoleMode = { fileId, s3Url, token, apiBase };
  this.loadFileFromUrl(s3Url);   // fetch blob → feed into existing upload handler
}
```

When `consoleMode` is set:
- Skip the upload screen — go straight to canvas with the file pre-loaded
- Change "Finalize & Export" button label to "Save Chunks to Console"

---

### Phase 3 — HITL Tool: Console Export Mode

**File:** `frontend-src/frontend/src/app/services/api.service.ts`

Add a new method:
```typescript
saveChunkToConsole(
  apiBase: string,
  token:   string,
  fileId:  string,
  chunkJpeg: Blob,
  metadata: {
    title:       string;
    description: string;
    type:        string;
    pageNumber:  number;
    locationInPage: string;
    paragraphNumber: number | null;
  }
): Observable<any> {
  const form = new FormData();
  form.append('zoom_in_file',                    chunkJpeg, `${metadata.title}.jpeg`);
  form.append('zoom_in_file_name',               `${metadata.title}.jpeg`);
  form.append('zoom_in_title',                   metadata.title);
  form.append('image_type',                      metadata.type);
  form.append('image_description',               metadata.description);
  form.append('image_source_document_location',  metadata.locationInPage || '');
  form.append('image_source_document_name',      String(metadata.pageNumber));
  form.append('image_source_document_url',       String(metadata.paragraphNumber ?? ''));
  form.append('zoom_level',                      'zoom_in');

  const headers = new HttpHeaders({ Authorization: `Bearer ${token}` });
  return this.http.post(`${apiBase}file-urls/${fileId}/images`, form, { headers });
}
```

**File:** `frontend-src/frontend/src/app/components/canvas-editor/canvas-editor.component.ts`

Replace `exportChunks()` behaviour when in console mode:
```typescript
async exportChunks(): Promise<void> {
  if (this.consoleMode) {
    await this.saveChunksToConsole();
  } else {
    await this.exportAsZip();   // existing behaviour unchanged
  }
}

private async saveChunksToConsole(): Promise<void> {
  const { fileId, token, apiBase } = this.consoleMode;
  for (const chunk of this.state.chunks()) {
    const jpeg = await this.getChunkJpeg(chunk);   // existing screenshot logic
    await this.api.saveChunkToConsole(apiBase, token, fileId, jpeg, {
      title:           chunk.title,
      description:     chunk.description,
      type:            chunk.type,
      pageNumber:      chunk.pageNumber,
      locationInPage:  chunk.locationInPage,
      paragraphNumber: chunk.paragraphNumber
    }).toPromise();
  }
  window.close();   // return user to admin console tab
}
```

---

## What Does NOT Change

| Component | Status |
|---|---|
| Admin Console backend (Hapi.js) | No changes — existing `/images` endpoint handles everything |
| Admin Console DB schema | No changes — `file_image` table fields already cover all chunk metadata |
| Admin Console vectorization flow | No changes — user still clicks "Sync AI" after chunking |
| HITL tool standalone mode | No changes — URL params absent → works exactly as today |
| HITL tool ZIP export | No changes — only replaced when `consoleMode` params are present |

---

## Environment / Deployment Notes

- During development: HITL tool runs on `http://localhost:4201`, Admin Console on `http://localhost:4200`
- The S3 URL passed in the URL param must be publicly accessible (or pre-signed) so the HITL tool can fetch the file without the admin console's auth
- In production both apps should share a domain (e.g. `tools.ypointsolutions.com/chunker`) so the S3 CORS policy and token handling stay clean
- The JWT token passed in the URL param has a 5-hour expiry (admin console default) — sufficient for a chunking session

---

## File Change Summary

| File | Change |
|---|---|
| `gsk-admin-console-fe-test/src/app/file-management/file-management.component.html` | Add "✂ Chunk" button per row |
| `gsk-admin-console-fe-test/src/app/file-management/file-management.component.ts` | Add `openChunker(file)` method |
| `frontend-src/.../canvas-editor.component.ts` | Read URL params, add `consoleMode`, `saveChunksToConsole()` |
| `frontend-src/.../api.service.ts` | Add `saveChunkToConsole()` method |
| `frontend-src/.../canvas-editor.component.html` | Change button label when in console mode |
