import { useCallback, useEffect, useRef, useState } from 'react'
import { jsPDF } from 'jspdf'
import * as pdfjsLib from 'pdfjs-dist'
import pdfWorker from 'pdfjs-dist/build/pdf.worker.min.mjs?url'

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorker

// render PDF pages at ~200 dpi (good-scanner resolution)
const TARGET_DPI = 200
const PT_PER_INCH = 72
const DEFAULT_W = 0.28          // new stamp width, as a fraction of its page's width

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v)

export default function App() {
  const [pages, setPages] = useState([])      // [{canvas, ptW, ptH}]
  const [loading, setLoading] = useState(false)
  const [status, setStatus] = useState('')
  // stamps are anchored to a page: fx/fy/fw are fractions of that page's box
  const [stamps, setStamps] = useState([])    // [{id, img, aspect, page, fx, fy, fw}]
  const [selId, setSelId] = useState(null)
  const [intensity, setIntensity] = useState(35)
  const [skew, setSkew] = useState(true)
  const [exporting, setExporting] = useState(false)

  const pageRefs = useRef([])    // index -> page <canvas> (its rect is the page box)
  const idRef = useRef(0)
  const dragState = useRef(null)
  const hoverRef = useRef(null)  // last {page, fx, fy} the pointer was over
  const clipRef = useRef(null)   // Ctrl+C'd stamp

  // ---------- page geometry helpers ----------
  const pageRect = (i) => pageRefs.current[i]?.getBoundingClientRect() || null

  // page under a viewport point; falls back to the vertically nearest page
  const pointToPage = (clientX, clientY) => {
    let best = null, bestScore = -Infinity
    pageRefs.current.forEach((el, i) => {
      if (!el) return
      const r = el.getBoundingClientRect()
      const inside = clientY >= r.top && clientY <= r.bottom
      const score = inside ? 0 : -Math.min(Math.abs(clientY - r.top), Math.abs(clientY - r.bottom))
      if (score > bestScore) {
        bestScore = score
        best = { page: i, fx: (clientX - r.left) / r.width, fy: (clientY - r.top) / r.height }
      }
    })
    return best
  }

  // where a new stamp should land: the pointer if it is over a page that's on screen,
  // otherwise the middle of whichever page currently fills most of the viewport
  const dropPoint = () => {
    const h = hoverRef.current
    if (h) {
      const r = pageRect(h.page)
      if (r && r.bottom > 0 && r.top < window.innerHeight) return h
    }
    let best = 0, bestOv = -Infinity
    pageRefs.current.forEach((el, i) => {
      if (!el) return
      const r = el.getBoundingClientRect()
      const ov = Math.min(r.bottom, window.innerHeight) - Math.max(r.top, 0)
      if (ov > bestOv) { bestOv = ov; best = i }
    })
    return { page: best, fx: 0.5, fy: 0.5 }
  }

  // centre a box of the given aspect on `at`, kept inside the page
  const boxAt = (at, aspect, fw = DEFAULT_W) => {
    const r = pageRect(at.page)
    if (!r) return null
    const fh = (fw * r.width / aspect) / r.height
    return {
      page: at.page, fw,
      fx: clamp(at.fx - fw / 2, 0, Math.max(0, 1 - fw)),
      fy: clamp(at.fy - fh / 2, 0, Math.max(0, 1 - fh)),
    }
  }

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
      hoverRef.current = null
      setStamps((prev) => prev.filter((s) => s.page < out.length))
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

  // ---------- add signature PNGs at a point (each file becomes its own stamp) ----------
  const addSigns = useCallback((files, at) => {
    const list = [...files].filter((f) => f.type.startsWith('image/'))
    if (!list.length) return
    if (!pageRefs.current.length) {
      setStatus('Open a PDF first, then add signatures.')
      return
    }
    const target = at || dropPoint()
    list.forEach((file, k) => {
      const img = new Image()
      img.onload = () => {
        const aspect = img.width / img.height
        // nudge each extra file so a multi-drop doesn't land in one pile
        const box = boxAt({ ...target, fx: target.fx + k * 0.03, fy: target.fy + k * 0.03 }, aspect)
        if (!box) return
        const id = ++idRef.current
        setStamps((prev) => [...prev, { id, img, aspect, ...box }])
        setSelId(id)
      }
      img.src = URL.createObjectURL(file)
    })
  }, [])

  const delStamp = useCallback((id) => {
    setStamps((prev) => prev.filter((s) => s.id !== id))
    setSelId((cur) => (cur === id ? null : cur))
  }, [])

  // put a copy of this stamp on every other page, at the same relative spot.
  // each copy is an ordinary stamp, so it can be dragged/resized per page afterwards.
  const copyToAllPages = useCallback((id) => {
    setStamps((prev) => {
      const src = prev.find((s) => s.id === id)
      if (!src) return prev
      const copies = []
      for (let i = 0; i < pageRefs.current.length; i++) {
        if (i === src.page) continue
        copies.push({ ...src, id: ++idRef.current, page: i })
      }
      return [...prev, ...copies]
    })
  }, [])

  // ---------- drag / resize ----------
  const onDown = (e, s, mode) => {
    e.preventDefault()
    e.stopPropagation()
    setSelId(s.id)
    dragState.current = {
      id: s.id, mode, page: s.page, box: { fx: s.fx, fy: s.fy, fw: s.fw }, aspect: s.aspect,
      startX: e.clientX, startY: e.clientY,
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }

  const onMove = (e) => {
    const d = dragState.current
    if (!d) return
    const r = pageRect(d.page)
    if (!r) return

    if (d.mode === 'resize') {
      const fw = clamp((d.box.fw * r.width + (e.clientX - d.startX)) / r.width, 0.02, 3)
      setStamps((prev) => prev.map((s) => (s.id === d.id ? { ...s, fw } : s)))
      return
    }

    // move in viewport px from the original anchor, then re-anchor to the page under the box centre
    const w = d.box.fw * r.width
    const h = w / d.aspect
    const left = r.left + d.box.fx * r.width + (e.clientX - d.startX)
    const top = r.top + d.box.fy * r.height + (e.clientY - d.startY)
    const hit = pointToPage(left + w / 2, top + h / 2)
    const tp = hit ? hit.page : d.page
    const tr = pageRect(tp)
    if (!tr) return
    setStamps((prev) => prev.map((s) => (s.id === d.id
      ? { ...s, page: tp, fx: (left - tr.left) / tr.width, fy: (top - tr.top) / tr.height, fw: w / tr.width }
      : s)))
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
      let doc = null
      for (let i = 0; i < pages.length; i++) {
        const p = pages[i]
        const comp = document.createElement('canvas')
        comp.width = p.canvas.width
        comp.height = p.canvas.height
        const cx = comp.getContext('2d')
        cx.drawImage(p.canvas, 0, 0)

        // stamps carry page-relative fractions, so this is the same geometry the user sees
        for (const s of stamps) {
          if (s.page !== i) continue
          const w = s.fw * comp.width
          cx.drawImage(s.img, s.fx * comp.width, s.fy * comp.height, w, w / s.aspect)
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

  // ---------- global drag-drop, copy / paste ----------
  useEffect(() => {
    const onDrop = (e) => {
      e.preventDefault()
      const f = [...(e.dataTransfer?.files || [])]
      const pdf = f.find((x) => x.type === 'application/pdf' || x.name.toLowerCase().endsWith('.pdf'))
      const imgs = f.filter((x) => x.type.startsWith('image/'))
      if (pdf) loadPdf(pdf)
      if (imgs.length) addSigns(imgs, pointToPage(e.clientX, e.clientY))
    }
    const onDragOver = (e) => e.preventDefault()

    const onCopy = (e) => {
      if (e.target.closest?.('input, textarea')) return
      const s = stamps.find((x) => x.id === selId)
      if (!s) return
      clipRef.current = s
      setStatus('Signature copied — Ctrl+V pastes it where the pointer is.')
    }

    const onPaste = (e) => {
      const items = [...(e.clipboardData?.items || [])]
      const imgs = []
      for (const it of items) {
        if (it.type === 'application/pdf') loadPdf(it.getAsFile())
        else if (it.type.startsWith('image/')) imgs.push(it.getAsFile())
      }
      if (imgs.length) { addSigns(imgs, dropPoint()); return }
      // nothing pasteable in the OS clipboard — fall back to our own Ctrl+C'd stamp
      const src = clipRef.current
      if (!src || !pageRefs.current.length) return
      const box = boxAt(dropPoint(), src.aspect, src.fw)
      if (!box) return
      const id = ++idRef.current
      setStamps((prev) => [...prev, { id, img: src.img, aspect: src.aspect, ...box }])
      setSelId(id)
    }

    window.addEventListener('drop', onDrop)
    window.addEventListener('dragover', onDragOver)
    window.addEventListener('copy', onCopy)
    window.addEventListener('paste', onPaste)
    return () => {
      window.removeEventListener('drop', onDrop)
      window.removeEventListener('dragover', onDragOver)
      window.removeEventListener('copy', onCopy)
      window.removeEventListener('paste', onPaste)
    }
  }, [loadPdf, addSigns, stamps, selId])

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
        <div
          className="stack"
          onPointerMove={(e) => { hoverRef.current = pointToPage(e.clientX, e.clientY) }}
        >
          {pages.map((p, i) => (
            <div className="page" key={i}>
              <div className="pagebox">
                <canvas ref={(el) => (pageRefs.current[i] = el)} />
                {stamps.filter((s) => s.page === i).map((s) => (
                  <div
                    key={s.id}
                    className={'signbox' + (s.id === selId ? ' sel' : '')}
                    style={{ left: `${s.fx * 100}%`, top: `${s.fy * 100}%`, width: `${s.fw * 100}%` }}
                    onPointerDown={(e) => onDown(e, s, 'move')}
                  >
                    <img src={s.img.src} alt="signature" draggable={false} />
                    <div className="handle" onPointerDown={(e) => onDown(e, s, 'resize')} />
                    <button
                      className="del"
                      title="Remove this signature"
                      onPointerDown={(e) => e.stopPropagation()}
                      onClick={(e) => { e.stopPropagation(); delStamp(s.id) }}
                    >×</button>
                    <button
                      className="allpg"
                      title="Put a copy on every page — each copy can then be moved separately"
                      onPointerDown={(e) => e.stopPropagation()}
                      onClick={(e) => { e.stopPropagation(); copyToAllPages(s.id) }}
                    >Copy to all pages</button>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>

      <footer>
        <span>Drop / paste a signature where you want it · drag to move (across pages too) · corner handle to resize · Ctrl+C then Ctrl+V to copy one under the pointer · “Copy to all pages” drops an independent copy on every page · × removes.</span>
      </footer>
    </div>
  )
}
