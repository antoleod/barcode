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

function clamp(value, min = 0, max = 255) {
  return Math.max(min, Math.min(max, value));
}

function createCanvas(width, height) {
  const c = document.createElement("canvas");
  c.width = Math.max(1, Math.round(width));
  c.height = Math.max(1, Math.round(height));
  return c;
}

function imageToCanvas(img) {
  const canvas = createCanvas(img.naturalWidth || img.width, img.naturalHeight || img.height);
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  return canvas;
}

function grayFromImageData(data) {
  const out = new Float32Array(data.length / 4);
  for (let i = 0, p = 0; i < data.length; i += 4, p += 1) {
    out[p] = data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114;
  }
  return out;
}

function grayToCanvas(gray, width, height) {
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  const imageData = ctx.createImageData(width, height);
  for (let i = 0, p = 0; p < gray.length; i += 4, p += 1) {
    const v = clamp(Math.round(gray[p]));
    imageData.data[i] = v;
    imageData.data[i + 1] = v;
    imageData.data[i + 2] = v;
    imageData.data[i + 3] = 255;
  }
  ctx.putImageData(imageData, 0, 0);
  return canvas;
}

function boxBlur(gray, width, height, radius = 2) {
  if (radius <= 0) return new Float32Array(gray);
  const tmp = new Float32Array(gray.length);
  const out = new Float32Array(gray.length);
  const win = radius * 2 + 1;

  for (let y = 0; y < height; y += 1) {
    let sum = 0;
    for (let k = -radius; k <= radius; k += 1) {
      sum += gray[y * width + clamp(k, 0, width - 1)];
    }
    for (let x = 0; x < width; x += 1) {
      tmp[y * width + x] = sum / win;
      const a = clamp(x - radius, 0, width - 1);
      const b = clamp(x + radius + 1, 0, width - 1);
      sum += gray[y * width + b] - gray[y * width + a];
    }
  }

  for (let x = 0; x < width; x += 1) {
    let sum = 0;
    for (let k = -radius; k <= radius; k += 1) {
      sum += tmp[clamp(k, 0, height - 1) * width + x];
    }
    for (let y = 0; y < height; y += 1) {
      out[y * width + x] = sum / win;
      const a = clamp(y - radius, 0, height - 1);
      const b = clamp(y + radius + 1, 0, height - 1);
      sum += tmp[b * width + x] - tmp[a * width + x];
    }
  }

  return out;
}

function median3x3(gray, width, height) {
  const out = new Float32Array(gray.length);
  const values = [];
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      values.length = 0;
      for (let dy = -1; dy <= 1; dy += 1) {
        for (let dx = -1; dx <= 1; dx += 1) {
          const xx = clamp(x + dx, 0, width - 1);
          const yy = clamp(y + dy, 0, height - 1);
          values.push(gray[yy * width + xx]);
        }
      }
      values.sort((a, b) => a - b);
      out[y * width + x] = values[4];
    }
  }
  return out;
}

function unsharp(gray, width, height, radius = 2, amount = 1.5) {
  const blur = boxBlur(gray, width, height, radius);
  const out = new Float32Array(gray.length);
  for (let i = 0; i < gray.length; i += 1) {
    out[i] = clamp(gray[i] + (gray[i] - blur[i]) * amount);
  }
  return out;
}

function sobelX(gray, width, height) {
  const out = new Float32Array(gray.length);
  for (let y = 1; y < height - 1; y += 1) {
    for (let x = 1; x < width - 1; x += 1) {
      const i = y * width + x;
      const gx =
        -gray[(y - 1) * width + (x - 1)] - 2 * gray[y * width + (x - 1)] - gray[(y + 1) * width + (x - 1)] +
        gray[(y - 1) * width + (x + 1)] + 2 * gray[y * width + (x + 1)] + gray[(y + 1) * width + (x + 1)];
      out[i] = Math.abs(gx);
    }
  }
  return out;
}

function stretch(gray, low = 0.02, high = 0.98) {
  const hist = new Uint32Array(256);
  for (let i = 0; i < gray.length; i += 1) hist[clamp(Math.round(gray[i]))] += 1;
  const total = gray.length;
  const aT = total * low;
  const bT = total * high;
  let a = 0;
  let b = 255;
  let sum = 0;
  for (let i = 0; i < 256; i += 1) {
    sum += hist[i];
    if (sum >= aT) {
      a = i;
      break;
    }
  }
  sum = 0;
  for (let i = 0; i < 256; i += 1) {
    sum += hist[i];
    if (sum >= bT) {
      b = i;
      break;
    }
  }
  const den = Math.max(1, b - a);
  const out = new Float32Array(gray.length);
  for (let i = 0; i < gray.length; i += 1) {
    out[i] = clamp(((gray[i] - a) / den) * 255);
  }
  return out;
}

function histogramEqualize(gray) {
  const hist = new Uint32Array(256);
  for (let i = 0; i < gray.length; i += 1) hist[clamp(Math.round(gray[i]))] += 1;
  const cdf = new Float32Array(256);
  let sum = 0;
  for (let i = 0; i < 256; i += 1) {
    sum += hist[i];
    cdf[i] = sum;
  }
  let cdfMin = 0;
  for (let i = 0; i < 256; i += 1) {
    if (cdf[i] > 0) {
      cdfMin = cdf[i];
      break;
    }
  }
  const den = gray.length - cdfMin || 1;
  const out = new Float32Array(gray.length);
  for (let i = 0; i < gray.length; i += 1) {
    const v = clamp(Math.round(gray[i]));
    out[i] = clamp(((cdf[v] - cdfMin) / den) * 255);
  }
  return out;
}

function directionalSharpenVertical(gray, width, height, strength = 1.2) {
  const out = new Float32Array(gray.length);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const l = gray[y * width + clamp(x - 1, 0, width - 1)];
      const c = gray[y * width + x];
      const r = gray[y * width + clamp(x + 1, 0, width - 1)];
      out[y * width + x] = clamp(c * (1 + 2 * strength) - (l + r) * strength);
    }
  }
  return out;
}

function rotateCanvas(srcCanvas, angleDeg, fill = 255) {
  const angle = (angleDeg * Math.PI) / 180;
  const out = createCanvas(srcCanvas.width, srcCanvas.height);
  const ctx = out.getContext("2d", { willReadFrequently: true });
  ctx.fillStyle = `rgb(${fill},${fill},${fill})`;
  ctx.fillRect(0, 0, out.width, out.height);
  ctx.translate(out.width / 2, out.height / 2);
  ctx.rotate(angle);
  ctx.drawImage(srcCanvas, -srcCanvas.width / 2, -srcCanvas.height / 2);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  return out;
}

function estimateBestSkewAngle(canvas) {
  let bestAngle = 0;
  let bestScore = -Infinity;
  for (let angle = -12; angle <= 12; angle += 2) {
    const rotated = rotateCanvas(canvas, angle);
    const ctx = rotated.getContext("2d", { willReadFrequently: true });
    const data = ctx.getImageData(0, 0, rotated.width, rotated.height);
    const gray = grayFromImageData(data.data);
    const edge = sobelX(gray, rotated.width, rotated.height);
    const cols = new Float32Array(rotated.width);
    for (let y = 0; y < rotated.height; y += 1) {
      for (let x = 0; x < rotated.width; x += 1) {
        cols[x] += edge[y * rotated.width + x];
      }
    }
    let mean = 0;
    for (let i = 0; i < cols.length; i += 1) mean += cols[i];
    mean /= cols.length;
    let variance = 0;
    for (let i = 0; i < cols.length; i += 1) {
      const d = cols[i] - mean;
      variance += d * d;
    }
    if (variance > bestScore) {
      bestScore = variance;
      bestAngle = angle;
    }
  }
  return bestAngle;
}

function deglare(imageData) {
  const gray = grayFromImageData(imageData.data);
  const smooth = boxBlur(gray, imageData.width, imageData.height, 7);
  for (let i = 0, p = 0; i < imageData.data.length; i += 4, p += 1) {
    const r = imageData.data[i];
    const g = imageData.data[i + 1];
    const b = imageData.data[i + 2];
    const sat = Math.max(r, g, b) - Math.min(r, g, b);
    if (gray[p] > 228 && sat < 35) {
      const target = clamp(smooth[p] + 10);
      imageData.data[i] = Math.min(r, target);
      imageData.data[i + 1] = Math.min(g, target);
      imageData.data[i + 2] = Math.min(b, target);
    }
  }
  return imageData;
}

function autoCropLabel(canvas) {
  const scale = Math.min(1, 360 / Math.max(canvas.width, canvas.height));
  const w = Math.max(1, Math.round(canvas.width * scale));
  const h = Math.max(1, Math.round(canvas.height * scale));
  const down = createCanvas(w, h);
  const ctx = down.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(canvas, 0, 0, w, h);

  const data = ctx.getImageData(0, 0, w, h);
  const gray = grayFromImageData(data.data);
  const edge = sobelX(gray, w, h);
  const row = new Float32Array(h);
  const col = new Float32Array(w);
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const v = edge[y * w + x];
      row[y] += v;
      col[x] += v;
    }
  }
  const rowMax = Math.max(...row);
  const colMax = Math.max(...col);
  let y0 = 0;
  let y1 = h - 1;
  let x0 = 0;
  let x1 = w - 1;
  while (y0 < h - 1 && row[y0] < rowMax * 0.45) y0 += 1;
  while (y1 > 0 && row[y1] < rowMax * 0.45) y1 -= 1;
  while (x0 < w - 1 && col[x0] < colMax * 0.35) x0 += 1;
  while (x1 > 0 && col[x1] < colMax * 0.35) x1 -= 1;

  const padX = Math.floor((x1 - x0 + 1) * 0.08);
  const padY = Math.floor((y1 - y0 + 1) * 0.18);
  x0 = clamp(x0 - padX, 0, w - 1);
  y0 = clamp(y0 - padY, 0, h - 1);
  x1 = clamp(x1 + padX, 0, w - 1);
  y1 = clamp(y1 + padY, 0, h - 1);

  const sx = Math.floor((x0 / w) * canvas.width);
  const sy = Math.floor((y0 / h) * canvas.height);
  const sw = Math.max(8, Math.floor(((x1 - x0 + 1) / w) * canvas.width));
  const sh = Math.max(8, Math.floor(((y1 - y0 + 1) / h) * canvas.height));
  const cropped = createCanvas(sw, sh);
  cropped.getContext("2d").drawImage(canvas, sx, sy, sw, sh, 0, 0, sw, sh);
  return cropped;
}

function otsu(gray) {
  const hist = new Uint32Array(256);
  for (let i = 0; i < gray.length; i += 1) hist[clamp(Math.round(gray[i]))] += 1;
  let sum = 0;
  for (let i = 0; i < 256; i += 1) sum += i * hist[i];
  let sumB = 0;
  let wB = 0;
  let maxVar = 0;
  let threshold = 127;
  for (let i = 0; i < 256; i += 1) {
    wB += hist[i];
    if (!wB) continue;
    const wF = gray.length - wB;
    if (!wF) break;
    sumB += i * hist[i];
    const mB = sumB / wB;
    const mF = (sum - sumB) / wF;
    const v = wB * wF * (mB - mF) * (mB - mF);
    if (v > maxVar) {
      maxVar = v;
      threshold = i;
    }
  }
  return threshold;
}

function preprocessForScanner(sourceCanvas) {
  const cropped = autoCropLabel(sourceCanvas);
  const angle = estimateBestSkewAngle(cropped);
  const straight = rotateCanvas(cropped, -angle);
  const ctx = straight.getContext("2d", { willReadFrequently: true });
  const imageData = deglare(ctx.getImageData(0, 0, straight.width, straight.height));
  const base = grayFromImageData(imageData.data);

  let barcode = median3x3(base, straight.width, straight.height);
  barcode = unsharp(barcode, straight.width, straight.height, 2, 1.8);
  barcode = directionalSharpenVertical(barcode, straight.width, straight.height, 1.2);
  barcode = histogramEqualize(barcode);
  barcode = stretch(barcode, 0.02, 0.98);

  let ocr = median3x3(base, straight.width, straight.height);
  ocr = unsharp(ocr, straight.width, straight.height, 1, 1.2);
  ocr = stretch(histogramEqualize(boxBlur(ocr, straight.width, straight.height, 1)), 0.03, 0.97);

  const strongContrast = unsharp(stretch(barcode, 0.01, 0.99), straight.width, straight.height, 1, 1.6);
  const edgeBoost = stretch(sobelX(barcode, straight.width, straight.height), 0.02, 0.98);
  const th = otsu(barcode);
  const binary = new Float32Array(barcode.length);
  for (let i = 0; i < barcode.length; i += 1) binary[i] = barcode[i] >= th ? 255 : 0;

  return {
    cropped,
    versionA: grayToCanvas(barcode, straight.width, straight.height),
    versionB: grayToCanvas(ocr, straight.width, straight.height),
    fallbackA: grayToCanvas(strongContrast, straight.width, straight.height),
    fallbackB: grayToCanvas(edgeBoost, straight.width, straight.height),
    fallbackC: grayToCanvas(binary, straight.width, straight.height),
  };
}

function canvasToBlob(canvas) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (!blob) reject(new Error("Failed to export image"));
      else resolve(blob);
    }, "image/png");
  });
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
  const [processed, setProcessed] = useState(null);
  const [showSettings, setShowSettings] = useState(false);
  const [showFallbacks, setShowFallbacks] = useState(false);

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
      const allDevices = await navigator.mediaDevices.enumerateDevices();
      const list = allDevices.filter((d) => d.kind === "videoinput");
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

  async function tryDecodePasses(reader, passes) {
    for (const pass of passes) {
      try {
        const res = await reader.decodeFromCanvas(pass.canvas);
        const text = normalizeText(res.getText());
        const format = res.getBarcodeFormat?.() ?? "";
        if (isLikelyBarcode(text)) {
          return { ok: true, text, format: String(format), pass: pass.name };
        }
      } catch {
        // try next pass
      }
    }
    return { ok: false };
  }

  async function decodeFromImage(file) {
    setError("");
    setStatus("Preprocesando imagen para barcode y OCR...");
    try {
      const reader = await ensureReader();
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = async () => {
        try {
          const source = imageToCanvas(img);
          const pack = preprocessForScanner(source);
          const versionABlob = await canvasToBlob(pack.versionA);
          const versionBBlob = await canvasToBlob(pack.versionB);

          setProcessed({
            cropPreview: pack.cropped.toDataURL("image/png"),
            versionAPreview: pack.versionA.toDataURL("image/png"),
            versionBPreview: pack.versionB.toDataURL("image/png"),
            versionABlob,
            versionBBlob,
          });

          const decoded = await tryDecodePasses(reader, [
            { name: "Version A (1D optimized)", canvas: pack.versionA },
            { name: "Version B (OCR optimized)", canvas: pack.versionB },
            { name: "Fallback A (strong contrast)", canvas: pack.fallbackA },
            { name: "Fallback B (edge emphasis)", canvas: pack.fallbackB },
            { name: "Fallback C (threshold binarization)", canvas: pack.fallbackC },
          ]);

          if (!decoded.ok) {
            setError("No pude detectar barcode tras todas las pasadas de preprocesado.");
            setStatus("Imagen procesada. Descarga Version A/B para ZXing, QuaggaJS o Dynamsoft.");
            return;
          }

          setRows((prev) => [
            ...prev,
            { _ts: Date.now(), timestamp: nowIsoLocal(), barcode: decoded.text, format: decoded.format },
          ]);
          beep();
          setStatus(`Detectado en ${decoded.pass}: ${decoded.text}`);
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
          <h1>Barcode to Excel</h1>
          <div className="sub">Escanea y exporta a .xlsx.</div>
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

          <div className="videoBox">
            <video ref={videoRef} className="video" muted playsInline />
          </div>
          
          {error && <div className="error">{error}</div>}

          <div className="controls">
            <button className="btn" onClick={() => startCamera({ attempt: 1 })}>Iniciar</button>
            <button className="btn ghost" onClick={stopCamera}>Detener</button>
          </div>

          <div style={{ textAlign: 'center', marginTop: '1rem' }}>
            <button className="btn ghost small" style={{ fontSize: '0.85rem', padding: '4px 8px' }} onClick={() => setShowSettings(!showSettings)}>
              {showSettings ? "Ocultar Configuración" : "Configuración (Cámara / Modo)"}
            </button>
          </div>

          {showSettings && (
            <div style={{ background: 'rgba(0,0,0,0.03)', padding: '1rem', borderRadius: '8px', marginTop: '0.5rem' }}>
              <div className="row">
                <label className="label">Modo</label>
                <select className="input" value={scanMode} onChange={(e) => setScanMode(e.target.value)}>
                  <option value="deep">Deep Scan (reintentos 1-4)</option>
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
                <button className="btn ghost small" onClick={refreshDevices} style={{marginTop: '0.5rem'}}>Recargar lista</button>
              </div>

              <div className="row two">
                <label className="check">
                  <input type="checkbox" checked={autoCommit} onChange={(e) => setAutoCommit(e.target.checked)} />
                  Auto-guardar
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
                  <span className="muted">ms espera</span>
                </label>
              </div>

              <div className="row">
                <label className="label">Linterna</label>
                <button className="btn" onClick={toggleTorch} disabled={!torchSupported}>
                  {torchOn ? "Apagar" : "Encender"}
                </button>
                {!torchSupported && <div className="muted" style={{fontSize: '0.8rem'}}>(no disponible)</div>}
              </div>
            </div>
          )}

          <div className="divider" />

          <div style={{ textAlign: 'center' }}>
            <button className="btn ghost small" style={{ fontSize: '0.85rem', padding: '4px 8px' }} onClick={() => setShowFallbacks(!showFallbacks)}>
              {showFallbacks ? "Ocultar Manual / Foto" : "Problemas? Usar Manual / Foto"}
            </button>
          </div>

          {showFallbacks && (
            <div style={{ background: 'rgba(0,0,0,0.03)', padding: '1rem', borderRadius: '8px', marginTop: '0.5rem' }}>
              <div className="row">
                <label className="label">Manual</label>
                <div className="inline">
              <input
                className="input"
                value={manual}
                placeholder="Código..."
                onChange={(e) => setManual(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") commitManual();
                }}
              />
              <button className="btn" onClick={commitManual}>OK</button>
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

          {processed && (
            <div className="processedBlock">
              <div className="muted">Resultado de preprocesado listo para scanner automatico</div>
              <div className="processedGrid">
                <figure>
                  <figcaption>ROI recortado automaticamente</figcaption>
                  <img src={processed.cropPreview} alt="ROI" />
                </figure>
                <figure>
                  <figcaption>Version A: 1D barcode</figcaption>
                  <img src={processed.versionAPreview} alt="Version A" />
                </figure>
                <figure>
                  <figcaption>Version B: OCR</figcaption>
                  <img src={processed.versionBPreview} alt="Version B" />
                </figure>
              </div>
              <div className="controls">
                <button className="btn" onClick={() => saveAs(processed.versionABlob, "processed-barcode-vA.png")}>
                  Descargar Version A
                </button>
                <button className="btn" onClick={() => saveAs(processed.versionBBlob, "processed-ocr-vB.png")}>
                  Descargar Version B
                </button>
              </div>
            </div>
            </div>
          )}

        </div>

        <div className="card">
          <div className="cardHead">
            <h2>Tabla</h2>
            <div className="muted">Cada lectura agrega una línea nueva. Se guarda localmente.</div>
          </div>

          <div className="tableActions">
            <button className="btn ghost" onClick={clearAll} disabled={rows.length === 0}>Borrar todo</button>
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
          Deep Scan hace reintentos automaticos (hasta 4) si no detecta nada: resolucion, cambio de camara y reinicio lector.
        </div>
      </footer>
    </div>
  );
}
