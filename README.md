# HITL Visual Chunking Tool

Gemini-assisted Human-in-the-Loop visual chunking for RAG pipelines.

---

## System Architecture

```
┌─────────────────────────────────────────────────────────────┐
│  Angular Frontend (port 4200)                               │
│  ┌──────────────┐   ┌─────────────────────────────────────┐ │
│  │ UploadZone   │   │ CanvasEditorComponent               │ │
│  │ Component    │   │  ┌──────────────┐  ┌─────────────┐  │ │
│  └──────────────┘   │  │ Fabric.js    │  │  Sidebar    │  │ │
│                     │  │ Canvas       │  │  + Metadata │  │ │
│                     │  └──────────────┘  └─────────────┘  │ │
│                     └─────────────────────────────────────┘ │
│  Services: ChunkStateService (signals) · ApiService (HTTP)   │
└─────────────────────────────────────────────────────────────┘
                           │ REST
┌─────────────────────────────────────────────────────────────┐
│  Node.js Backend (port 3001)                                │
│  POST /api/analyze  →  GeminiService  →  Mock / Real API    │
│  POST /api/export   →  ImageService   →  Sharp (crop+ZIP)   │
└─────────────────────────────────────────────────────────────┘
```

---

## Quick Start

### 1. Backend

```bash
cd backend
npm install
npm run dev
```

Backend runs at http://localhost:3001

Default: **MOCK mode** (no Gemini key needed). Set `MOCK_GEMINI=false` in `.env` to use real API.

### 2. Frontend

```bash
# One-time: scaffold Angular workspace
cd ..
npx @angular/cli@17 new frontend --standalone --style=css --routing=false --skip-tests --ssr=false
cd frontend

# Install Fabric.js
npm install fabric@5.3.0
npm install --save-dev @types/fabric@5.3.6

# Copy source files from frontend-src/ into the Angular workspace
cp -r ../frontend-src/src/. ./src/
```

Then start:
```bash
npm start
# or: ng serve --open
```

Frontend runs at http://localhost:4200

---

## Workflow

1. **Upload** — drop a dashboard/report/infographic image
2. **Analyze with Gemini** — backend sends to Gemini (mock or real), returns bounding boxes
3. **Edit boxes** — on the canvas:
   - **Drag** to move a box
   - **Drag corners** to resize
   - **Red × button** to delete
   - **Add Box** button + drag to draw a new box
4. **Add metadata** — click a chunk in the sidebar, fill in Title / Description / Type
5. **Finalize & Export** — downloads a ZIP containing:
   - `{sessionId}_{chunkId}.png` — cropped image per chunk
   - `metadata.json` — RAG-ready JSON

---

## RAG Export Format (metadata.json)

```json
[
  {
    "chunk_id": "box_1",
    "title": "Q3 Sales Chart",
    "description": "Bar chart comparing quarterly sales by product line",
    "type": "chart",
    "image_path": "abc123_box_1.png",
    "coordinates": [0.03, 0.18, 0.47, 0.55],
    "pixel_coordinates": [27, 162, 423, 495],
    "original_image_size": { "width": 900, "height": 900 }
  }
]
```

---

## Switching to Real Gemini

1. Get a key from https://ai.google.dev/
2. Edit `backend/.env`:
   ```
   MOCK_GEMINI=false
   GEMINI_API_KEY=your_key_here
   ```
3. Restart the backend

The Gemini prompt is in `backend/services/gemini.service.js` — tunable for your domain.

---

## Integrating into your Angular Admin Console

The frontend is built as standalone Angular 17 components. To integrate:

1. Copy `frontend/src/app/components/`, `services/`, `models/` into your admin console
2. Add `provideHttpClient()` to your app's providers if not already present
3. Add `<app-canvas-editor>` or `<app-upload-zone>` to any route's template
4. Update `API_BASE_URL` in `api.service.ts` to your admin console API gateway
5. The backend routes (`/api/analyze`, `/api/export`) can be mounted directly in your existing Express server:
   ```js
   // In your existing server.js / app.js
   app.use('/api/hitl/analyze', require('./hitl/routes/analyze'));
   app.use('/api/hitl/export',  require('./hitl/routes/export'));
   ```

---

## Box Visual States

| Color  | Meaning                        |
|--------|--------------------------------|
| Red    | AI-generated (from Gemini)     |
| Blue   | User-modified or manually drawn |

---

## Coordinate System

All coordinates are stored as **normalized float [0–1]**:
- `[x1, y1, x2, y2]` where top-left is `(0,0)`, bottom-right is `(1,1)`
- Frontend converts: `normalized × canvas_display_size` for rendering
- Backend converts: `normalized × original_image_size` for cropping

This decouples display resolution from crop resolution.
