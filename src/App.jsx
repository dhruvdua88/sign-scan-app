import { useCallback, useEffect, useRef, useState } from 'react'
import { jsPDF } from 'jspdf'
import * as pdfjsLib from 'pdfjs-dist'
import pdfWorker from 'pdfjs-dist/build/pdf.worker.min.mjs?url'

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorker

// render PDF pages at ~200 dpi (good-scanner resolution)
const TARGET_DPI = 200
const PT_PER_INCH = 72

export default function App() {
  const [pages, setPages] = useState([])      // [{canvas, ptW, ptH}]
  const [loading, setLoading] = useState(false)
  const [status, setStatus] = useState('')
  const [stamps, setStamps] = useState([])    // [{id, img, x, y, w, h}] document px, relative to pages stack
  const [selId, setSelId] = useState(null)
  const [intensity, setIntensity] = useState(35)
  const [skew, setSkew] = useState(true)
  const [exporting, setExporting] = useState(false)

  const stackRef = useRef(null)
  const pageRefs = useRef([])
  const stampRefs = useRef({})   // id -> DOM el
  const idRef = useRef(0)
  const dragState = useRef(null)

  // ---------- load PDF ----------
  const loadPdf = useCallback(async (file) => {
    if (!file) return
    if (file.type !== 'application/pdf' && !file.name.toLowerCase().endsWith('.pdf')) {
      setStatus('Not a PDF file.')
      return
    }
    setLoading(true)
    setStatus('Rendering PDF…')
    try {
      const buf = await file.arrayBuffer()
      const pdf = await pdfjsLib.getDocument({ data: buf }).promise
      const out = []
      for (let i = 1; i <= pdf.numPages; i++) {
        const page = await pdf.getPage(i)
        const vp1 = page.getViewport({ scale: 1 })           // points
        const scale = TARGET_DPI / PT_PER_INCH
        const vp = page.getViewport({ scale })
        const canvas = document.createElement('canvas')
        canvas.width = Math.floor(vp.width)
        canvas.height = Math.floor(vp.height)
        const ctx = canvas.getContext('2d')
        ctx.fillStyle = '#ffffff'
        ctx.fillRect(0, 0, canvas.width, canvas.height)
        await page.render({ canvasContext: ctx, viewport: vp }).promise
        out.push({ canvas, ptW: vp1.width, ptH: vp1.height })
      }
      pageRefs.current = []
      setPages(out)
      setStatus(`Loaded ${out.length} page${out.length > 1 ? 's' : ''}.`)
    } catch (e) {
      console.error(e)
      setStatus('Failed to read PDF: ' + e.message)
    } finally {
      setLoading(false)
    }
  }, [])

  // paint rendered canvases into the visible <canvas> elements
  useEffect(() => {
    pages.forEach((p, i) => {
      const el = pageRefs.current[i]
      if (!el) return
      el.width = p.canvas.width
      el.height = p.canvas.height
      el.getContext('2d').drawImage(p.canvas, 0, 0)
    })
  }, [pages])

  // ---------- add one or more signature PNGs (each becomes its own stamp) ----------
  const addSigns = useCallback((files) => {
    const list = [...files].filter((f) => f.type.startsWith('image/'))
    list.forEach((file) => {
      const url = URL.createObjectURL(file)
      const img = new Image()
      img.onload = () => {
        const firstPage = pageRefs.current[0]
        const stack = stackRef.current
        const baseW = firstPage ? firstPage.getBoundingClientRect().width : 300
        const w = baseW * 0.28
        const h = w * (img.height / img.width)
        const sRect = stack?.getBoundingClientRect()
        const pRect = firstPage?.getBoundingClientRect()
        const x0 = pRect && sRect ? pRect.left - sRect.left + baseW * 0.1 : 20
        const id = ++idRef.current
        setStamps((prev) => {
          const k = prev.length
          return [...prev, { id, img, x: x0 + k * 26, y: 40 + k * 26, w, h, allPages: false }]
        })
        setSelId(id)
      }
      img.src = url
    })
  }, [])

  const delStamp = useCallback((id) => {
    setStamps((prev) => prev.filter((s) => s.id !== id))
    setSelId((cur) => (cur === id ? null : cur))
  }, [])

  const toggleAll = useCallback((id) => {
    setStamps((prev) => prev.map((s) => (s.id === id ? { ...s, allPages: !s.allPages } : s)))
  }, [])

  // ---------- drag / resize a specific stamp ----------
  const onDown = (e, id, mode) => {
    e.preventDefault()
    e.stopPropagation()
    setSelId(id)
    const s = stamps.find((x) => x.id === id)
    if (!s) return
    dragState.current = {
      id, mode,
      startX: e.clientX, startY: e.clientY,
      box: { ...s }, aspect: s.w / s.h,
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }

  const onMove = (e) => {
    const d = dragState.current
    if (!d) return
    const dx = e.clientX - d.startX
    const dy = e.clientY - d.startY
    setStamps((prev) => prev.map((s) => {
      if (s.id !== d.id) return s
      if (d.mode === 'move') return { ...s, x: d.box.x + dx, y: d.box.y + dy }
      const w = Math.max(24, d.box.w + dx)
      return { ...s, w, h: w / d.aspect }
    }))
  }

  const onUp = () => {
    dragState.current = null
    window.removeEventListener('pointermove', onMove)
    window.removeEventListener('pointerup', onUp)
  }

  // ---------- scan effect on a finished page canvas ----------
  const applyScan = (srcCanvas) => {
    const k = intensity / 100
    const w = srcCanvas.width
    const h = srcCanvas.height
    const out = document.createElement('canvas')
    out.width = w
    out.height = h
    const ctx = out.getContext('2d')
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, w, h)

    if (skew && k > 0) {
      const ang = (Math.random() - 0.5) * 0.012 * (0.4 + k)
      ctx.save()
      ctx.translate(w / 2, h / 2)
      ctx.rotate(ang)
      ctx.translate(-w / 2, -h / 2)
      ctx.drawImage(srcCanvas, 0, 0)
      ctx.restore()
    } else {
      ctx.drawImage(srcCanvas, 0, 0)
    }

    const contrast = 1 + 0.22 * k
    const bright = 4 * k
    const noiseAmt = 14 * k
    const id = ctx.getImageData(0, 0, w, h)
    const px = id.data
    for (let i = 0; i < px.length; i += 4) {
      const n = (Math.random() - 0.5) * noiseAmt
      for (let c = 0; c < 3; c++) {
        let v = px[i + c]
        v = (v - 128) * contrast + 128 + bright + n
        px[i + c] = v < 0 ? 0 : v > 255 ? 255 : v
      }
    }
    ctx.putImageData(id, 0, 0)

    if (k > 0) {
      const g = ctx.createLinearGradient(0, 0, 0, h)
      g.addColorStop(0, `rgba(0,0,0,${0.05 * k})`)
      g.addColorStop(0.04, 'rgba(0,0,0,0)')
      g.addColorStop(0.96, 'rgba(0,0,0,0)')
      g.addColorStop(1, `rgba(0,0,0,${0.05 * k})`)
      ctx.fillStyle = g
      ctx.fillRect(0, 0, w, h)
    }
    return out
  }

  // ---------- export flattened PDF ----------
  const exportPdf = async () => {
    if (!pages.length) return
    setExporting(true)
    setStatus('Flattening & exporting…')
    try {
      const SCALE = TARGET_DPI / PT_PER_INCH
      const pageEls = pageRefs.current.map((el) => el.getBoundingClientRect())
      // resolve how each stamp prints: single-page (live rect) or all-pages (page-relative)
      const plans = stamps.map((s) => {
        const el = stampRefs.current[s.id]
        if (!el) return null
        const r = el.getBoundingClientRect()
        if (!s.allPages) return { img: s.img, all: false, r }
        // anchor = page with largest vertical overlap (or nearest if outside all)
        let bi = 0, best = -Infinity
        pageEls.forEach((pr, idx) => {
          const ov = Math.min(r.bottom, pr.bottom) - Math.max(r.top, pr.top)
          const score = ov > 0 ? ov : -Math.min(Math.abs(r.top - pr.bottom), Math.abs(pr.top - r.bottom))
          if (score > best) { best = score; bi = idx }
        })
        const ar = pageEls[bi], ap = pages[bi]
        return {
          img: s.img, all: true,
          fracX: (r.left - ar.left) / ar.width,
          fracY: (r.top - ar.top) / ar.height,
          wPx: (r.width / ar.width) * ap.ptW * SCALE,   // physical size, constant on every page
          hPx: (r.height / ar.height) * ap.ptH * SCALE,
        }
      }).filter(Boolean)

      let doc = null
      for (let i = 0; i < pages.length; i++) {
        const p = pages[i]
        const el = pageRefs.current[i]
        const pageRect = el.getBoundingClientRect()
        const renderScale = p.canvas.width / pageRect.width // px per display-px

        const comp = document.createElement('canvas')
        comp.width = p.canvas.width
        comp.height = p.canvas.height
        const cx = comp.getContext('2d')
        cx.drawImage(p.canvas, 0, 0)

        // draw stamps onto this page
        for (const pl of plans) {
          if (pl.all) {
            cx.drawImage(pl.img, pl.fracX * comp.width, pl.fracY * comp.height, pl.wPx, pl.hPx)
          } else {
            const r = pl.r
            const ovTop = Math.max(r.top, pageRect.top)
            const ovBot = Math.min(r.bottom, pageRect.bottom)
            if (ovBot <= ovTop) continue
            cx.drawImage(pl.img, (r.left - pageRect.left) * renderScale, (r.top - pageRect.top) * renderScale,
              r.width * renderScale, r.height * renderScale)
          }
        }

        const scanned = applyScan(comp)
        const jpeg = scanned.toDataURL('image/jpeg', 0.85)

        const orient = p.ptW > p.ptH ? 'l' : 'p'
        if (i === 0) doc = new jsPDF({ orientation: orient, unit: 'pt', format: [p.ptW, p.ptH] })
        else doc.addPage([p.ptW, p.ptH], orient)
        doc.addImage(jpeg, 'JPEG', 0, 0, p.ptW, p.ptH)
      }
      doc.save('signed-scanned.pdf')
      setStatus('Done — downloaded signed-scanned.pdf')
    } catch (e) {
      console.error(e)
      setStatus('Export failed: ' + e.message)
    } finally {
      setExporting(false)
    }
  }

  // ---------- global drag-drop + paste ----------
  useEffect(() => {
    const onDrop = (e) => {
      e.preventDefault()
      const f = [...(e.dataTransfer?.files || [])]
      const pdf = f.find((x) => x.type === 'application/pdf' || x.name.toLowerCase().endsWith('.pdf'))
      const imgs = f.filter((x) => x.type.startsWith('image/'))
      if (pdf) loadPdf(pdf)
      if (imgs.length) addSigns(imgs)
    }
    const onDragOver = (e) => e.preventDefault()
    const onPaste = (e) => {
      const items = [...(e.clipboardData?.items || [])]
      const imgs = []
      for (const it of items) {
        if (it.type === 'application/pdf') loadPdf(it.getAsFile())
        else if (it.type.startsWith('image/')) imgs.push(it.getAsFile())
      }
      if (imgs.length) addSigns(imgs)
    }
    window.addEventListener('drop', onDrop)
    window.addEventListener('dragover', onDragOver)
    window.addEventListener('paste', onPaste)
    return () => {
      window.removeEventListener('drop', onDrop)
      window.removeEventListener('dragover', onDragOver)
      window.removeEventListener('paste', onPaste)
    }
  }, [loadPdf, addSigns])

  return (
    <div className="app">
      <header>
        <h1>Sign &amp; Scan</h1>
        <p className="sub">Affix one or more transparent signatures / stamps on a PDF, download it looking like a clean scan. 100% in your browser — nothing is uploaded.</p>
      </header>

      <div className="toolbar">
        <label className="btn">
          Open PDF
          <input type="file" accept="application/pdf" hidden
            onClick={(e) => { e.target.value = null }}
            onChange={(e) => loadPdf(e.target.files[0])} />
        </label>
        <label className="btn">
          Add signature PNG{stamps.length ? ` (${stamps.length})` : ''}
          <input type="file" accept="image/png,image/*" multiple hidden
            onClick={(e) => { e.target.value = null }}
            onChange={(e) => addSigns(e.target.files)} />
        </label>
        {stamps.length > 0 && (
          <button className="btn" onClick={() => { setStamps([]); setSelId(null) }}>Clear all</button>
        )}
        <div className="slider">
          <span>Scan look</span>
          <input type="range" min="0" max="100" value={intensity}
            onChange={(e) => setIntensity(+e.target.value)} />
          <span className="val">{intensity}</span>
        </div>
        <label className="chk">
          <input type="checkbox" checked={skew} onChange={(e) => setSkew(e.target.checked)} />
          slight skew
        </label>
        <button className="btn primary" disabled={!pages.length || exporting} onClick={exportPdf}>
          {exporting ? 'Exporting…' : 'Download flattened PDF'}
        </button>
      </div>

      <div className="status">{loading ? 'Loading… ' : ''}{status}
        {' '}
        {!pages.length && !loading && <span className="hint">Tip: drag-drop or paste a PDF and PNGs anywhere. Add as many signatures as you like.</span>}
      </div>

      <div className="viewer">
        <div className="stack" ref={stackRef}>
          {pages.map((p, i) => (
            <div className="page" key={i}>
              <canvas ref={(el) => (pageRefs.current[i] = el)} />
            </div>
          ))}

          {stamps.map((s) => (
            <div
              key={s.id}
              className={'signbox' + (s.id === selId ? ' sel' : '') + (s.allPages ? ' allon' : '')}
              ref={(el) => { if (el) stampRefs.current[s.id] = el; else delete stampRefs.current[s.id] }}
              style={{ left: s.x, top: s.y, width: s.w, height: s.h }}
              onPointerDown={(e) => onDown(e, s.id, 'move')}
            >
              <img src={s.img.src} alt="signature" draggable={false} />
              <div className="handle" onPointerDown={(e) => onDown(e, s.id, 'resize')} />
              <button
                className="del"
                title="Remove this signature"
                onPointerDown={(e) => e.stopPropagation()}
                onClick={(e) => { e.stopPropagation(); delStamp(s.id) }}
              >×</button>
              <button
                className={'allpg' + (s.allPages ? ' on' : '')}
                title="Place this signature on every page (same size & position)"
                onPointerDown={(e) => e.stopPropagation()}
                onClick={(e) => { e.stopPropagation(); toggleAll(s.id) }}
              >{s.allPages ? '✓ All pages' : 'All pages'}</button>
            </div>
          ))}
        </div>
      </div>

      <footer>
        <span>Add multiple signatures · click one to select · drag to move · corner handle to resize · × to remove · whole page flattened to image on export (text/images not selectable).</span>
      </footer>
    </div>
  )
}
