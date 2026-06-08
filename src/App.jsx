import { useCallback, useEffect, useRef, useState } from 'react'
import { jsPDF } from 'jspdf'
import * as pdfjsLib from 'pdfjs-dist'
import pdfWorker from 'pdfjs-dist/build/pdf.worker.min.mjs?url'

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorker

// render PDF pages at ~200 dpi (good-scanner resolution)
const TARGET_DPI = 200
const PT_PER_INCH = 72

export default function App() {
  const [pages, setPages] = useState([])      // [{canvas, ptW, ptH, displayW, displayH}]
  const [loading, setLoading] = useState(false)
  const [status, setStatus] = useState('')
  const [signImg, setSignImg] = useState(null)
  const [signBox, setSignBox] = useState(null) // {x, y, w, h} in document px (relative to pages stack)
  const [intensity, setIntensity] = useState(35)
  const [skew, setSkew] = useState(true)
  const [exporting, setExporting] = useState(false)

  const stackRef = useRef(null)
  const pageRefs = useRef([])
  const signRef = useRef(null)
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
    setSignBox(null)
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

  // ---------- load signature PNG ----------
  const loadSign = useCallback((file) => {
    if (!file) return
    const url = URL.createObjectURL(file)
    const img = new Image()
    img.onload = () => {
      setSignImg(img)
      setSignBox((prev) => {
        // swapping an existing signature: keep position + width, refit height
        if (prev) return { ...prev, h: prev.w * (img.height / img.width) }
        // first signature: default place ~28% of first page width, near top-left
        const stack = stackRef.current
        const firstPage = pageRefs.current[0]
        const baseW = firstPage ? firstPage.getBoundingClientRect().width : 300
        const w = baseW * 0.28
        const h = w * (img.height / img.width)
        const sRect = stack?.getBoundingClientRect()
        const pRect = firstPage?.getBoundingClientRect()
        const x = pRect && sRect ? pRect.left - sRect.left + baseW * 0.1 : 20
        return { x, y: 40, w, h }
      })
    }
    img.src = url
  }, [])

  const removeSign = useCallback(() => {
    setSignImg(null)
    setSignBox(null)
  }, [])

  // ---------- drag / resize ----------
  const onSignPointerDown = (e, mode) => {
    e.preventDefault()
    e.stopPropagation()
    const stack = stackRef.current.getBoundingClientRect()
    dragState.current = {
      mode,
      startX: e.clientX,
      startY: e.clientY,
      box: { ...signBox },
      aspect: signBox.w / signBox.h,
      stackLeft: stack.left,
      stackTop: stack.top,
    }
    window.addEventListener('pointermove', onPointerMove)
    window.addEventListener('pointerup', onPointerUp)
  }

  const onPointerMove = (e) => {
    const d = dragState.current
    if (!d) return
    const dx = e.clientX - d.startX
    const dy = e.clientY - d.startY
    if (d.mode === 'move') {
      setSignBox({ ...d.box, x: d.box.x + dx, y: d.box.y + dy })
    } else {
      let w = Math.max(24, d.box.w + dx)
      let h = w / d.aspect
      setSignBox({ ...d.box, w, h })
    }
  }

  const onPointerUp = () => {
    dragState.current = null
    window.removeEventListener('pointermove', onPointerMove)
    window.removeEventListener('pointerup', onPointerUp)
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

    // subtle skew like a sheet fed slightly crooked
    if (skew && k > 0) {
      const ang = (Math.random() - 0.5) * 0.012 * (0.4 + k) // radians, tiny
      ctx.save()
      ctx.translate(w / 2, h / 2)
      ctx.rotate(ang)
      ctx.translate(-w / 2, -h / 2)
      ctx.drawImage(srcCanvas, 0, 0)
      ctx.restore()
    } else {
      ctx.drawImage(srcCanvas, 0, 0)
    }

    // pixel pass: contrast + grain, color preserved
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

    // faint scanner edge shadow
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
      const stackRect = stackRef.current.getBoundingClientRect()
      const signRect = signBox && signRef.current ? signRef.current.getBoundingClientRect() : null
      let doc = null
      for (let i = 0; i < pages.length; i++) {
        const p = pages[i]
        const el = pageRefs.current[i]
        const pageRect = el.getBoundingClientRect()
        const renderScale = p.canvas.width / pageRect.width // px per display-px

        // composite page + signature at render resolution
        const comp = document.createElement('canvas')
        comp.width = p.canvas.width
        comp.height = p.canvas.height
        const cx = comp.getContext('2d')
        cx.drawImage(p.canvas, 0, 0)

        if (signImg && signRect) {
          // overlap test between signature box and this page (viewport coords)
          const ovTop = Math.max(signRect.top, pageRect.top)
          const ovBot = Math.min(signRect.bottom, pageRect.bottom)
          if (ovBot > ovTop) {
            const localX = (signRect.left - pageRect.left) * renderScale
            const localY = (signRect.top - pageRect.top) * renderScale
            const localW = signRect.width * renderScale
            const localH = signRect.height * renderScale
            cx.drawImage(signImg, localX, localY, localW, localH)
          }
        }

        const scanned = applyScan(comp)
        const jpeg = scanned.toDataURL('image/jpeg', 0.85)

        const orient = p.ptW > p.ptH ? 'l' : 'p'
        if (i === 0) {
          doc = new jsPDF({ orientation: orient, unit: 'pt', format: [p.ptW, p.ptH] })
        } else {
          doc.addPage([p.ptW, p.ptH], orient)
        }
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
      const png = f.find((x) => x.type.startsWith('image/'))
      if (pdf) loadPdf(pdf)
      if (png) loadSign(png)
    }
    const onDragOver = (e) => e.preventDefault()
    const onPaste = (e) => {
      const items = [...(e.clipboardData?.items || [])]
      for (const it of items) {
        if (it.type === 'application/pdf') loadPdf(it.getAsFile())
        else if (it.type.startsWith('image/')) loadSign(it.getAsFile())
      }
    }
    window.addEventListener('drop', onDrop)
    window.addEventListener('dragover', onDragOver)
    window.addEventListener('paste', onPaste)
    return () => {
      window.removeEventListener('drop', onDrop)
      window.removeEventListener('dragover', onDragOver)
      window.removeEventListener('paste', onPaste)
    }
  }, [loadPdf, loadSign])

  return (
    <div className="app">
      <header>
        <h1>Sign &amp; Scan</h1>
        <p className="sub">Affix a transparent signature on a PDF, download it looking like a clean scan. 100% in your browser — nothing is uploaded.</p>
      </header>

      <div className="toolbar">
        <label className="btn">
          Open PDF
          <input type="file" accept="application/pdf" hidden
            onChange={(e) => loadPdf(e.target.files[0])} />
        </label>
        <label className="btn">
          {signImg ? 'Change signature' : 'Upload signature PNG'}
          <input type="file" accept="image/png,image/*" hidden
            onClick={(e) => { e.target.value = null }}
            onChange={(e) => loadSign(e.target.files[0])} />
        </label>
        {signImg && (
          <button className="btn" onClick={removeSign}>Remove signature</button>
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
        {!pages.length && !loading && <span className="hint">Tip: you can also drag-drop or paste a PDF / PNG anywhere.</span>}
      </div>

      <div className="viewer">
        <div className="stack" ref={stackRef}>
          {pages.map((p, i) => (
            <div className="page" key={i}>
              <canvas ref={(el) => (pageRefs.current[i] = el)} />
            </div>
          ))}

          {signImg && signBox && (
            <div
              className="signbox"
              ref={signRef}
              style={{ left: signBox.x, top: signBox.y, width: signBox.w, height: signBox.h }}
              onPointerDown={(e) => onSignPointerDown(e, 'move')}
            >
              <img src={signImg.src} alt="signature" draggable={false} />
              <div className="handle" onPointerDown={(e) => onSignPointerDown(e, 'resize')} />
            </div>
          )}
        </div>
      </div>

      <footer>
        <span>One signature per document · drag to move · corner handle to resize · whole page flattened to image on export (text/images not selectable).</span>
      </footer>
    </div>
  )
}
