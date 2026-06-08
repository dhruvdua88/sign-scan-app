# Sign & Scan

Affix a transparent PNG signature onto a PDF and download it looking like a clean scanner output. **Fully client-side** — the PDF and signature never leave your browser.

## Features
- Open a PDF: file picker, drag-and-drop, or paste (multi-page supported)
- Upload a transparent signature PNG: file picker, drag-drop, or paste
- Drag to position, corner handle to resize (aspect locked) — one signature per document, placeable on any page
- "Scan look" slider: subtle grain, contrast, slight skew + scanner edge shadow, original colour preserved
- Export: whole page is flattened to a JPEG image inside the PDF → **text and images are not selectable** in the output

## Develop
```bash
npm install
npm run dev
```

## Build
```bash
npm run build
```

## Deploy
Pushes to `main` auto-deploy to GitHub Pages via the included Actions workflow. Enable Pages → Source: **GitHub Actions** in repo settings.
