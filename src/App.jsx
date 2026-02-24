import React, { useEffect, useMemo, useRef, useState } from "react";
import { BrowserMultiFormatReader } from "@zxing/browser";
import { saveAs } from "file-saver";
import * as XLSX from "xlsx";
import "./app.css";

function nowIsoLocal() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function beep() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = "sine";
    o.frequency.value = 880;
    o.connect(g);
    g.connect(ctx.destination);
    g.gain.setValueAtTime(0.0001, ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.08, ctx.currentTime + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.12);
    o.start();
    o.stop(ctx.currentTime + 0.14);
    setTimeout(() => ctx.close().catch(() => {}), 250);
  } catch {
    // ignore
  }
}

const LS_KEY = "barcodeExcelScanner.rows.v1";

function loadRows() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed;
  } catch {
    return [];
  }
}

function saveRows(rows) {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(rows));
  } catch {
    // ignore
  }
}

function normalizeText(txt) {
  return String(txt ?? "").trim();
}

function isLikelyBarcode(value) {
  // barcode can be numeric/alphanum; we only filter out super short noise
  const v = normalizeText(value);
  return v.length >= 6; // conservative
}

function uniqueByRecent(rows, newValue, windowMs = 1200) {
  const v = normalizeText(newValue);
  const last = rows[0];
  if (!last) return true;
  if (normalizeText(last.barcode) !== v) return true;
  const lastT = Number(last._ts || 0);
  return Date.now() - lastT > windowMs;
}

export default function App() {
  const videoRef = useRef(null);
  const readerRef = useRef(null);
  const controlsRef = useRef(null);

  const [rows, setRows] = useState(() => loadRows());
  const [status, setStatus] = useState("Listo. Dale permiso a la cámara y escanea.");
  const [error, setError] = useState("");
  const [devices, setDevices] = useState([]);
  const [deviceId, setDeviceId] = useState("");
  const [torchSupported, setTorchSupported] = useState(false);
  const [torchOn, setTorchOn] = useState(false);
  const [scanMode, setScanMode] = useState("deep"); // deep | fast
  const [autoCommit, setAutoCommit] = useState(true);
  const [manual, setManual] = useState("");
  const [cooldownMs, setCooldownMs] = useState(1200);

  const count = rows.length;

  useEffect(() => {
    saveRows(rows);
  }, [rows]);

  const orderedRows = useMemo(() => [...rows].reverse(), [rows]);

  async function ensureReader() {
    if (!readerRef.current) {
      readerRef.current = new BrowserMultiFormatReader();
    }
    return readerRef.current;
  }

  async function refreshDevices() {
    setError("");
    try {
      const reader = await ensureReader();
      const list = await reader.listVideoInputDevices();
      setDevices(list);
      if (!deviceId) {
        // Prefer back camera if possible
        const back = list.find((d) => /back|rear|environment/i.test(d.label));
        setDeviceId((back || list[0] || {}).deviceId || "");
      }
    } catch (e) {
      setError(`No pude listar cámaras: ${e?.message || e}`);
    }
  }

  useEffect(() => {
    refreshDevices();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function stopCamera() {
    try {
      controlsRef.current?.stop?.();
    } catch {
      // ignore
    }
    controlsRef.current = null;
    setTorchSupported(false);
    setTorchOn(false);
  }

  async function startCamera({ attempt = 1 } = {}) {
    setError("");
    setStatus(`Iniciando cámara (intento ${attempt}/4)…`);

    await stopCamera();

    const video = videoRef.current;
    if (!video) {
      setError("Video element no disponible.");
      return;
    }

    const reader = await ensureReader();

    // Attempt strategy (deep scan):
    // 1) Standard constraints
    // 2) Higher resolution + focus hints
    // 3) Switch device (if available)
    // 4) Recreate reader and retry

    const constraintsByAttempt = [
      { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: { ideal: "environment" } },
      { width: { ideal: 1920 }, height: { ideal: 1080 }, facingMode: { ideal: "environment" } },
      { width: { ideal: 2560 }, height: { ideal: 1440 }, facingMode: { ideal: "environment" } },
      { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: { ideal: "environment" } },
    ];

    const shouldSwitchDevice = scanMode === "deep" && attempt === 3 && devices.length > 1;

    let useDeviceId = deviceId;
    if (shouldSwitchDevice) {
      const idx = devices.findIndex((d) => d.deviceId === deviceId);
      const next = devices[(idx + 1) % devices.length];
      useDeviceId = next.deviceId;
      setDeviceId(useDeviceId);
      setStatus(`Cambiando de cámara para mejorar lectura…`);
    }

    if (scanMode === "deep" && attempt === 4) {
      // recreate reader (rare cases)
      try {
        readerRef.current = new BrowserMultiFormatReader();
      } catch {
        // ignore
      }
    }

    const constraints = constraintsByAttempt[Math.min(attempt - 1, constraintsByAttempt.length - 1)];

    try {
      // decodeFromVideoDevice: continuous scanning; callback for each result
      controlsRef.current = await reader.decodeFromVideoDevice(
        useDeviceId || null,
        video,
        (result, err, controls) => {
          // keep controls reference in case lib returns a new one
          controlsRef.current = controlsRef.current || controls;

          if (result) {
            const text = normalizeText(result.getText());
            const format = result.getBarcodeFormat?.() ?? "";
            setStatus(`Detectado: ${text}`);

            if (autoCommit && isLikelyBarcode(text)) {
              setRows((prev) => {
                if (!uniqueByRecent(prev, text, cooldownMs)) return prev;
                const next = [
                  ...prev,
                  { _ts: Date.now(), timestamp: nowIsoLocal(), barcode: text, format: String(format) },
                ];
                return next;
              });
              beep();
            }
          }

          // Ignore "NotFoundException" etc. We use retry loop separately.
          if (err && err?.name && !/NotFoundException/i.test(err.name)) {
            // show only meaningful errors
            setError((prev) => prev || `Scanner: ${err?.message || err}`);
          }
        },
        constraints
      );

      setStatus("Cámara lista. Escanea ahora.");

      // Try to detect torch capability
      setTimeout(async () => {
        try {
          const stream = video.srcObject;
          if (!stream) return;
          const track = stream.getVideoTracks?.()[0];
          if (!track) return;
          const caps = track.getCapabilities?.();
          const torchCap = !!caps?.torch;
          setTorchSupported(torchCap);
        } catch {
          setTorchSupported(false);
        }
      }, 350);

      // Deep scan retry watchdog: if nothing is committed for some time, restart with stronger attempts
      if (scanMode === "deep") {
        startRetryWatchdog();
      }
    } catch (e) {
      setError(`No pude iniciar cámara: ${e?.message || e}`);
      setStatus("Error iniciando cámara.");
      if (scanMode === "deep" && attempt < 4) {
        // immediate retry
        setTimeout(() => startCamera({ attempt: attempt + 1 }), 600);
      }
    }
  }

  const watchdogRef = useRef({ timer: null, lastCount: 0, streak: 0 });

  function startRetryWatchdog() {
    stopRetryWatchdog();
    watchdogRef.current.lastCount = rows.length;
    watchdogRef.current.streak = 0;

    watchdogRef.current.timer = window.setInterval(async () => {
      const currentCount = loadRows().length; // localStorage is the source of truth across tab refresh
      const stale = currentCount === watchdogRef.current.lastCount;
      watchdogRef.current.lastCount = currentCount;

      if (!stale) {
        watchdogRef.current.streak = 0;
        return;
      }

      watchdogRef.current.streak += 1;

      // Every ~6 seconds without new row: bump attempt
      if (watchdogRef.current.streak === 3) {
        setStatus("No veo lectura estable… mejorando búsqueda (intento 2/4)…");
        startCamera({ attempt: 2 });
      }
      if (watchdogRef.current.streak === 6) {
        setStatus("Sigo sin lectura… mejorando búsqueda (intento 3/4)…");
        startCamera({ attempt: 3 });
      }
      if (watchdogRef.current.streak === 9) {
        setStatus("Último intento: reinicio profundo del lector (4/4)…");
        startCamera({ attempt: 4 });
      }
    }, 2000);
  }

  function stopRetryWatchdog() {
    if (watchdogRef.current.timer) {
      clearInterval(watchdogRef.current.timer);
      watchdogRef.current.timer = null;
    }
  }

  useEffect(() => {
    return () => {
      stopRetryWatchdog();
      stopCamera();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function toggleTorch() {
    setError("");
    try {
      const video = videoRef.current;
      const stream = video?.srcObject;
      const track = stream?.getVideoTracks?.()[0];
      if (!track) throw new Error("No video track.");

      const next = !torchOn;
      await track.applyConstraints({ advanced: [{ torch: next }] });
      setTorchOn(next);
    } catch (e) {
      setError(`Torch no disponible: ${e?.message || e}`);
    }
  }

  function exportXlsx() {
    const data = rows.map((r, idx) => ({
      "#": idx + 1,
      Timestamp: r.timestamp,
      Barcode: r.barcode,
      Format: r.format,
    }));

    const ws = XLSX.utils.json_to_sheet(data);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Scans");

    // column widths
    ws["!cols"] = [
      { wch: 6 },
      { wch: 20 },
      { wch: 26 },
      { wch: 14 },
    ];

    const bytes = XLSX.write(wb, { bookType: "xlsx", type: "array" });
    const blob = new Blob([bytes], {
      type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    });

    const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    saveAs(blob, `barcode-scans-${stamp}.xlsx`);
  }

  function clearAll() {
    if (!confirm("¿Seguro que quieres borrar todo el historial?") ) return;
    setRows([]);
    saveRows([]);
    setStatus("Historial borrado.");
  }

  function commitManual() {
    const v = normalizeText(manual);
    if (!isLikelyBarcode(v)) {
      setError("Código muy corto. Intenta de nuevo.");
      return;
    }
    setRows((prev) => [
      ...prev,
      { _ts: Date.now(), timestamp: nowIsoLocal(), barcode: v, format: "MANUAL" },
    ]);
    setManual("");
    beep();
    setStatus(`Agregado manual: ${v}`);
  }

  async function decodeFromImage(file) {
    setError("");
    try {
      const reader = await ensureReader();
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = async () => {
        try {
          const res = await reader.decodeFromImageElement(img);
          const text = normalizeText(res.getText());
          const format = res.getBarcodeFormat?.() ?? "";
          if (!isLikelyBarcode(text)) {
            setError("Leí algo, pero no parece un código válido (muy corto). Prueba otra foto.");
            URL.revokeObjectURL(url);
            return;
          }
          setRows((prev) => [
            ...prev,
            { _ts: Date.now(), timestamp: nowIsoLocal(), barcode: text, format: String(format) },
          ]);
          beep();
          setStatus(`Detectado desde imagen: ${text}`);
        } catch (e) {
          setError(`No pude leer el código desde la imagen: ${e?.message || e}`);
        } finally {
          URL.revokeObjectURL(url);
        }
      };
      img.onerror = () => {
        setError("No pude cargar la imagen.");
        URL.revokeObjectURL(url);
      };
      img.src = url;
    } catch (e) {
      setError(`Fallo al decodificar imagen: ${e?.message || e}`);
    }
  }

  return (
    <div className="wrap">
      <header className="top">
        <div>
          <h1>Barcode → Excel</h1>
          <div className="sub">Escanea con la cámara y exporta a .xlsx (sin servidor). Robusto con “Deep Scan”.</div>
        </div>
        <div className="right">
          <div className="pill">Total: <strong>{count}</strong></div>
          <button className="btn" onClick={exportXlsx} disabled={rows.length === 0}>Exportar Excel</button>
        </div>
      </header>

      <section className="grid">
        <div className="card">
          <div className="cardHead">
            <h2>Scanner</h2>
            <div className="status">{status}</div>
          </div>

          <div className="controls">
            <button className="btn" onClick={() => startCamera({ attempt: 1 })}>▶ Iniciar</button>
            <button className="btn ghost" onClick={stopCamera}>⏹ Detener</button>
            <button className="btn ghost" onClick={refreshDevices}>↻ Cámaras</button>
          </div>

          <div className="row">
            <label className="label">Modo</label>
            <select className="input" value={scanMode} onChange={(e) => setScanMode(e.target.value)}>
              <option value="deep">Deep Scan (reintentos 1→4)</option>
              <option value="fast">Fast (sin watchdog)</option>
            </select>
          </div>

          <div className="row">
            <label className="label">Cámara</label>
            <select className="input" value={deviceId} onChange={(e) => setDeviceId(e.target.value)}>
              {devices.length === 0 ? (
                <option value="">(no detectada)</option>
              ) : (
                devices.map((d) => (
                  <option key={d.deviceId} value={d.deviceId}>
                    {d.label || `Camera ${d.deviceId.slice(0, 6)}…`}
                  </option>
                ))
              )}
            </select>
          </div>

          <div className="row two">
            <label className="check">
              <input type="checkbox" checked={autoCommit} onChange={(e) => setAutoCommit(e.target.checked)} />
              Auto-guardar cada lectura
            </label>
            <label className="check">
              <input
                type="number"
                min={300}
                max={5000}
                step={100}
                value={cooldownMs}
                onChange={(e) => setCooldownMs(Number(e.target.value || 1200))}
              />
              <span className="muted">ms anti-duplicado</span>
            </label>
          </div>

          <div className="row">
            <label className="label">Linterna (si tu móvil lo soporta)</label>
            <button className="btn" onClick={toggleTorch} disabled={!torchSupported}>
              {torchOn ? "💡 Apagar" : "🔦 Encender"}
            </button>
            {!torchSupported && <div className="muted">(no disponible)</div>}
          </div>

          <div className="videoBox">
            <video ref={videoRef} className="video" muted playsInline />
          </div>

          {error && <div className="error">{error}</div>}

          <div className="divider" />

          <h3>Fallbacks (por si la cámara falla)</h3>
          <div className="row">
            <label className="label">Manual</label>
            <div className="inline">
              <input
                className="input"
                value={manual}
                placeholder="Pega/escribe el código y Enter"
                onChange={(e) => setManual(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") commitManual();
                }}
              />
              <button className="btn" onClick={commitManual}>➕ Añadir</button>
            </div>
          </div>

          <div className="row">
            <label className="label">Leer desde foto</label>
            <input
              className="input"
              type="file"
              accept="image/*"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) decodeFromImage(f);
                e.target.value = "";
              }}
            />
            <div className="muted">Tip: foto bien enfocada, sin reflejos.</div>
          </div>

        </div>

        <div className="card">
          <div className="cardHead">
            <h2>Tabla</h2>
            <div className="muted">Cada lectura agrega una línea nueva. Se guarda localmente.</div>
          </div>

          <div className="tableActions">
            <button className="btn ghost" onClick={clearAll} disabled={rows.length === 0}>🧹 Borrar todo</button>
          </div>

          <div className="tableWrap">
            <table className="table">
              <thead>
                <tr>
                  <th>#</th>
                  <th>Timestamp</th>
                  <th>Barcode</th>
                  <th>Format</th>
                </tr>
              </thead>
              <tbody>
                {orderedRows.length === 0 ? (
                  <tr><td colSpan="4" className="muted">No hay lecturas aún.</td></tr>
                ) : (
                  orderedRows.map((r, i) => (
                    <tr key={`${r._ts}-${i}`}>
                      <td>{orderedRows.length - i}</td>
                      <td className="mono">{r.timestamp}</td>
                      <td className="mono">{r.barcode}</td>
                      <td className="mono">{r.format}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>

          <div className="note">
            <strong>Excel:</strong> Exporta un .xlsx listo. Si quieres “llenar un Excel existente”, puedes importar una plantilla
            y exportar de nuevo (lo dejo listo para ampliar en <code>exportXlsx()</code>).
          </div>
        </div>
      </section>

      <footer className="foot">
        <div className="muted">
          Deep Scan hace reintentos automáticos (hasta 4) si no detecta nada: resolución↑ → cambio de cámara → reinicio lector.
        </div>
      </footer>
    </div>
  );
}
