import React, { useEffect, useMemo, useRef, useState } from "react";
import { BrowserMultiFormatReader } from "@zxing/browser";
import Quagga from "@ericblade/quagga2";
import { saveAs } from "file-saver";
import Tesseract from "tesseract.js";
import * as XLSX from "xlsx";
import "./app.css";

function nowIsoLocal() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function playSuccessSound() {
  // If you want to use a custom file, uncomment:
  // new Audio('/scan-beep.mp3').play().catch(() => {});

  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const t = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    
    osc.type = "sine";
    osc.frequency.setValueAtTime(1200, t);
    osc.frequency.exponentialRampToValueAtTime(600, t + 0.15);
    gain.gain.setValueAtTime(0.15, t);
    gain.gain.exponentialRampToValueAtTime(0.01, t + 0.15);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(t);
    osc.stop(t + 0.2);
    setTimeout(() => ctx.close().catch(() => {}), 300);
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

function binarizeCanvas(canvas, threshold) {
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const gray = grayFromImageData(imgData.data);
  const th = threshold || otsu(gray);
  for (let i = 0; i < gray.length; i++) {
    const val = gray[i] >= th ? 255 : 0;
    imgData.data[i * 4] = imgData.data[i * 4 + 1] = imgData.data[i * 4 + 2] = val;
  }
  ctx.putImageData(imgData, 0, 0);
}

function invertCanvas(canvas) {
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const data = imgData.data;
  for (let i = 0; i < data.length; i += 4) {
    data[i] = 255 - data[i];     // r
    data[i + 1] = 255 - data[i + 1]; // g
    data[i + 2] = 255 - data[i + 2]; // b
  }
  ctx.putImageData(imgData, 0, 0);
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

// --- Stability / Motion Detection ---
function calculateFrameDiff(dataA, dataB) {
  if (!dataA || !dataB || dataA.length !== dataB.length) return 100;
  let diff = 0;
  for (let i = 0; i < dataA.length; i += 4) { // sample pixels
    diff += Math.abs(dataA[i] - dataB[i]);
  }
  return diff / (dataA.length / 4);
}

function extractSerialFromText(text) {
  const cleaned = (text || "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");

  const matches = cleaned.match(/02PI20[A-Z0-9]+/g);
  if (!matches || matches.length === 0) return null;

  matches.sort((a, b) => b.length - a.length);
  return matches[0];
}

function getBBoxFromZXingResult(resultPoints) {
  if (!resultPoints || resultPoints.length === 0) return null;
  const xs = resultPoints.map((p) => p.getX?.() ?? p.x).filter((v) => Number.isFinite(v));
  const ys = resultPoints.map((p) => p.getY?.() ?? p.y).filter((v) => Number.isFinite(v));
  if (xs.length === 0 || ys.length === 0) return null;

  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);

  return {
    x: Math.max(0, Math.floor(minX)),
    y: Math.max(0, Math.floor(minY)),
    width: Math.max(8, Math.ceil(maxX - minX)),
    height: Math.max(8, Math.ceil(maxY - minY)),
  };
}

function expandBBox(bbox, expandDown = 0.2, expandX = 0.08) {
  const growX = bbox.width * expandX;
  return {
    x: bbox.x - growX,
    y: bbox.y,
    width: bbox.width + growX * 2,
    height: bbox.height * (1 + expandDown),
  };
}

function cropCanvas(sourceCanvas, bbox) {
  const x = clamp(Math.floor(bbox.x), 0, sourceCanvas.width - 1);
  const y = clamp(Math.floor(bbox.y), 0, sourceCanvas.height - 1);
  const maxW = sourceCanvas.width - x;
  const maxH = sourceCanvas.height - y;
  const width = clamp(Math.floor(bbox.width), 1, maxW);
  const height = clamp(Math.floor(bbox.height), 1, maxH);
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(sourceCanvas, x, y, width, height, 0, 0, width, height);
  return canvas;
}

function preprocessRoiCanvas(roiCanvas) {
  const out = createCanvas(roiCanvas.width, roiCanvas.height);
  const ctx = out.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(roiCanvas, 0, 0);
  const img = ctx.getImageData(0, 0, out.width, out.height);
  const gray = grayFromImageData(img.data);
  const th = otsu(gray);
  for (let i = 0; i < gray.length; i += 1) {
    const v = gray[i] >= th ? 255 : 0;
    img.data[i * 4] = v;
    img.data[i * 4 + 1] = v;
    img.data[i * 4 + 2] = v;
    img.data[i * 4 + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  return out;
}

export default function App() {
  const videoRef = useRef(null);
  const canvasRef = useRef(null); // Internal canvas for processing
  const readerRef = useRef(null);
  const workerRef = useRef(null);
  const workerPromiseRef = useRef(null);

  const [rows, setRows] = useState(() => loadRows());
  const [status, setStatus] = useState("Listo. Dale permiso a la cÃ¡mara y escanea.");
  const [error, setError] = useState("");
  const [devices, setDevices] = useState([]);
  const [deviceId, setDeviceId] = useState("");
  const [torchSupported, setTorchSupported] = useState(false);
  const [torchOn, setTorchOn] = useState(false);
  const [scanMode, setScanMode] = useState("deep"); 
  const [autoCommit, setAutoCommit] = useState(true);
  const [manual, setManual] = useState("");
  const [cooldownMs, setCooldownMs] = useState(1200);
  const [processed, setProcessed] = useState(null);
  const [showSettings, setShowSettings] = useState(false);
  const [showFallbacks, setShowFallbacks] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [scanPhase, setScanPhase] = useState(0); // 0: Normal, 1: Focus/Res, 2: Preprocess, 3: Deep
  const [roiStyle, setRoiStyle] = useState({});
  const [serialLocked, setSerialLocked] = useState(false);

  const count = rows.length;

  useEffect(() => {
    saveRows(rows);
  }, [rows]);

  const orderedRows = useMemo(() => [...rows].reverse(), [rows]);

  // Initialize ZXing Reader
  const getReader = () => {
    if (!readerRef.current) {
      readerRef.current = new BrowserMultiFormatReader();
    }
    return readerRef.current;
  };

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
      setError(`No pude listar cÃ¡maras: ${e?.message || e}`);
    }
  }

  useEffect(() => {
    refreshDevices();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // --- Scanner Logic ---
  const scanState = useRef({
    active: false,
    lastFrameData: null,
    consecutiveStableFrames: 0,
    lastScanTime: 0,
    phaseStartTime: 0,
    stream: null,
    track: null,
    ocrBusy: false,
    lastOcrTime: 0
  });

  async function stopCamera() {
    scanState.current.active = false;
    if (scanState.current.stream) {
      scanState.current.stream.getTracks().forEach(t => t.stop());
      scanState.current.stream = null;
    }
    if (videoRef.current) {
      videoRef.current.srcObject = null;
    }
    setScanning(false);
    setTorchSupported(false);
    setTorchOn(false);
    setScanPhase(0);
  }

  async function startCamera() {
    await stopCamera();
    setError("");
    setStatus("Iniciando cÃ¡mara...");
    setSerialLocked(false);
    setScanning(true);
    scanState.current.active = true;
    scanState.current.phaseStartTime = Date.now();

    try {
      const constraints = {
        video: {
          deviceId: deviceId ? { exact: deviceId } : undefined,
          facingMode: deviceId ? undefined : { ideal: "environment" },
          width: { ideal: 1280 },
          height: { ideal: 720 },
          focusMode: { ideal: "continuous" }
        }
      };

      const stream = await navigator.mediaDevices.getUserMedia(constraints);
      scanState.current.stream = stream;
      
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        videoRef.current.onloadedmetadata = () => {
          videoRef.current.play().catch(e => console.warn("Play error", e));
          requestAnimationFrame(scanLoop);
        };
      }

      const track = stream.getVideoTracks()[0];
      scanState.current.track = track;
      
      // Capabilities check
      const caps = track.getCapabilities?.() || {};
      setTorchSupported(!!caps.torch);

      // Apply advanced constraints if possible
      if (track.applyConstraints) {
        const advanced = [];
        if (caps.focusMode?.includes('continuous')) advanced.push({ focusMode: 'continuous' });
        if (caps.exposureMode?.includes('continuous')) advanced.push({ exposureMode: 'continuous' });
        if (advanced.length > 0) {
          track.applyConstraints({ advanced }).catch(() => {});
        }
      }

      setStatus("Buscando cÃ³digo...");
    } catch (e) {
      console.error(e);
      setError("Error al acceder a la cÃ¡mara. Verifica permisos.");
      setScanning(false);
    }
  }

  // --- Main Scan Loop ---
  async function scanLoop() {
    if (!scanState.current.active || !videoRef.current) return;

    const video = videoRef.current;
    if (video.readyState !== video.HAVE_ENOUGH_DATA) {
      requestAnimationFrame(scanLoop);
      return;
    }

    // Prepare canvas
    if (!canvasRef.current) {
      canvasRef.current = document.createElement('canvas');
    }
    const canvas = canvasRef.current;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    
    // Resize canvas to video dimensions (or smaller for performance)
    if (canvas.width !== video.videoWidth || canvas.height !== video.videoHeight) {
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      // Update ROI style for UI
      const roiSize = Math.min(video.videoWidth, video.videoHeight) * 0.6;
      setRoiStyle({
        width: roiSize,
        height: roiSize * 0.6, // Rectangular for barcodes
        top: (video.videoHeight - roiSize * 0.6) / 2,
        left: (video.videoWidth - roiSize) / 2
      });
    }

    ctx.drawImage(video, 0, 0);
    
    // 1. Stability Check (Motion Gating)
    // We sample a small center area for stability to be fast
    const sampleSize = 32;
    const sx = (canvas.width - sampleSize) / 2;
    const sy = (canvas.height - sampleSize) / 2;
    const currentFrameData = ctx.getImageData(sx, sy, sampleSize, sampleSize).data;
    
    const diff = calculateFrameDiff(scanState.current.lastFrameData, currentFrameData);
    scanState.current.lastFrameData = currentFrameData;

    if (diff > 25) { // Threshold for motion
      scanState.current.consecutiveStableFrames = 0;
      // If moving too much, skip heavy decode, just wait
      requestAnimationFrame(scanLoop);
      return;
    }
    scanState.current.consecutiveStableFrames++;

    // Only decode if stable for a few frames (~100ms)
    if (scanState.current.consecutiveStableFrames > 3) {
      await attemptDecode(canvas, ctx);
    }

    requestAnimationFrame(scanLoop);
  }

  async function attemptDecode(canvas, ctx) {
    const now = Date.now();
    if (serialLocked) return;
    // Debounce scans
    if (now - scanState.current.lastScanTime < 100) return; 
    scanState.current.lastScanTime = now;

    // Determine Phase based on time since start without success
    const elapsed = now - scanState.current.phaseStartTime;
    let phase = 0;
    if (elapsed > 2000) phase = 1; // After 2s, try harder
    if (elapsed > 5000) phase = 2; // After 5s, preprocess
    if (elapsed > 8000) phase = 3; // After 8s, deep scan
    if (elapsed > 12000) phase = 4; // After 12s, desperate (OCR)
    
    if (phase !== scanPhase) {
      setScanPhase(phase);
      if (phase === 1) setStatus("Enfocando...");
      if (phase === 2) setStatus("Ajustando contraste...");
      if (phase === 3) setStatus("Probando inversiÃ³n y filtros...");
      if (phase === 4) setStatus("Intentando leer nÃºmeros (OCR)...");
    }

    // OCR only on ROI under barcode bbox (no full-frame OCR)
    if (phase >= 4 && !scanState.current.ocrBusy && (now - scanState.current.lastOcrTime > 1800 || !scanState.current.lastOcrTime)) {
      scanState.current.ocrBusy = true;
      scanState.current.lastOcrTime = now;
      
      detectBarcodeBBoxFromCanvas(canvas)
        .then((bbox) => tryOcrSerialFromRoi(canvas, bbox))
        .then((res) => {
          if (res.success && res.serial) {
            saveSerial(res.serial);
          }
        })
        .catch(err => console.warn("OCR error", err))
        .finally(() => {
          scanState.current.ocrBusy = false;
        });
    }

    // If we reach here in Phase 4 multiple times, show hint
    if (phase === 4 && scanState.current.consecutiveStableFrames % 60 === 0) {
      setStatus("Intenta acercar/alejar o mejorar la luz.");
    }
  }

  function hasSerial(serial) {
    return rows.some((r) => normalizeText(r.serial) === normalizeText(serial));
  }

  function saveSerial(serial) {
    if (!serial || hasSerial(serial)) return;
    playSuccessSound();
    setRows((prev) => [...prev, { _ts: Date.now(), timestamp: nowIsoLocal(), serial }]);
    setStatus(`Serial detectado: ${serial}`);
    setSerialLocked(true);
  }

  useEffect(() => {
    return () => {
      stopCamera();
      if (workerRef.current) {
        workerRef.current.terminate();
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function toggleTorch() {
    if (!scanState.current.track) return;
    try {
      const next = !torchOn;
      await scanState.current.track.applyConstraints({ advanced: [{ torch: next }] });
      setTorchOn(next);
    } catch (e) {
      // ignore
    }
  }

  function exportXlsx() {
    const data = rows.map((r, idx) => ({
      "#": idx + 1,
      Timestamp: r.timestamp,
      Serial: r.serial,
    }));

    const ws = XLSX.utils.json_to_sheet(data);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Scans");

    // column widths
    ws["!cols"] = [
      { wch: 6 },
      { wch: 20 },
      { wch: 30 },
    ];

    const bytes = XLSX.write(wb, { bookType: "xlsx", type: "array" });
    const blob = new Blob([bytes], {
      type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    });

    const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    saveAs(blob, `barcode-scans-${stamp}.xlsx`);
  }

  function clearAll() {
    if (!confirm("Â¿Seguro que quieres borrar todo el historial?") ) return;
    setRows([]);
    saveRows([]);
    setSerialLocked(false);
    setStatus("Historial borrado.");
  }

  function commitManual() {
    const serial = extractSerialFromText(manual);
    if (!serial) {
      setError("Serial invalido. Debe empezar por 02PI20.");
      return;
    }
    if (hasSerial(serial)) return;
    saveSerial(serial);
    setManual("");
  }

  async function getOcrWorker() {
    if (workerRef.current) return workerRef.current;
    if (workerPromiseRef.current) return workerPromiseRef.current;

    workerPromiseRef.current = (async () => {
      const w = await Tesseract.createWorker("eng");
      await w.setParameters({
        tessedit_char_whitelist: "02PI20ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789",
      });
      workerRef.current = w;
      workerPromiseRef.current = null;
      return w;
    })();
    return workerPromiseRef.current;
  }

  function getCenteredFallbackBBox(canvas) {
    const w = canvas.width * 0.7;
    const h = canvas.height * 0.2;
    return {
      x: (canvas.width - w) / 2,
      y: canvas.height * 0.58,
      width: w,
      height: h,
    };
  }

  function buildSerialRoiBBox(baseBbox, canvas) {
    const below = {
      x: baseBbox.x,
      y: baseBbox.y + baseBbox.height,
      width: baseBbox.width,
      height: Math.max(20, baseBbox.height * 0.95),
    };
    const expanded = expandBBox(below, 0.2, 0.08);
    return {
      x: clamp(expanded.x, 0, canvas.width - 1),
      y: clamp(expanded.y, 0, canvas.height - 1),
      width: clamp(expanded.width, 1, canvas.width - clamp(expanded.x, 0, canvas.width - 1)),
      height: clamp(expanded.height, 1, canvas.height - clamp(expanded.y, 0, canvas.height - 1)),
    };
  }

  async function detectBarcodeBBoxFromCanvas(frameCanvas) {
    try {
      const result = await getReader().decodeFromCanvas(frameCanvas);
      const bbox = getBBoxFromZXingResult(result?.getResultPoints?.());
      if (bbox) return bbox;
    } catch {
      // fallback to quagga
    }

    try {
      const quaggaResult = await new Promise((resolve) => {
        Quagga.decodeSingle(
          {
            src: frameCanvas.toDataURL("image/jpeg"),
            numOfWorkers: 0,
            locate: true,
            decoder: { readers: ["code_128_reader", "ean_reader", "code_39_reader", "i2of5_reader"] },
          },
          (res) => resolve(res || null)
        );
      });

      if (quaggaResult?.box?.length) {
        const xs = quaggaResult.box.map((p) => p.x);
        const ys = quaggaResult.box.map((p) => p.y);
        return {
          x: Math.min(...xs),
          y: Math.min(...ys),
          width: Math.max(...xs) - Math.min(...xs),
          height: Math.max(...ys) - Math.min(...ys),
        };
      }
    } catch {
      // ignore and use centered fallback
    }

    return getCenteredFallbackBBox(frameCanvas);
  }

  async function tryOcrSerialFromRoi(frameCanvas, bbox) {
    const resultBase = {
      success: false,
      serial: null,
      method: "fail",
      error: null,
    };

    try {
      const roiBbox = buildSerialRoiBBox(bbox, frameCanvas);
      const roiCanvas = cropCanvas(frameCanvas, roiBbox);
      const pre = preprocessRoiCanvas(roiCanvas);
      const worker = await getOcrWorker();

      const first = await worker.recognize(pre);
      let serial = extractSerialFromText(first?.data?.text);
      if (serial) {
        return { success: true, serial, method: "ocr-roi", error: null };
      }

      invertCanvas(pre);
      const second = await worker.recognize(pre);
      serial = extractSerialFromText(second?.data?.text);
      if (serial) {
        return { success: true, serial, method: "ocr-roi", error: null };
      }

      return { ...resultBase, error: "serial_not_found" };
    } catch (e) {
      return { ...resultBase, error: e?.message || "ocr_error" };
    }
  }

  async function decodeFromImage(file) {
    setError("");
    setStatus("Preprocesando imagen para barcode y OCR...");
    try {
      const reader = getReader();
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = async () => {
        try {
          const source = imageToCanvas(img);
          const bbox = await detectBarcodeBBoxFromCanvas(source);
          const ocrResult = await tryOcrSerialFromRoi(source, bbox);

          const roiPreview = cropCanvas(source, buildSerialRoiBBox(bbox, source));
          const roiBlob = await canvasToBlob(roiPreview);
          setProcessed({
            cropPreview: roiPreview.toDataURL("image/png"),
            versionAPreview: roiPreview.toDataURL("image/png"),
            versionBPreview: roiPreview.toDataURL("image/png"),
            versionABlob: roiBlob,
            versionBBlob: roiBlob,
          });

          if (!ocrResult.success || !ocrResult.serial) {
            setError("No se encontro serial valido con prefijo 02PI20.");
            setStatus("Fail: OCR ROI no encontro serial.");
            return;
          }

          saveSerial(ocrResult.serial);
        } catch (e) {
          setError(`No pude leer el cÃ³digo desde la imagen: ${e?.message || e}`);
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
        <div className="card scanCard">
          <div className="cardHead">
            <h2>Scanner</h2>
            <div className="status">{status}</div>
          </div>

          <div className="videoBox">
            <video ref={videoRef} className="video" muted playsInline autoPlay />
            {scanning && (
              <div 
                id="scanner-roi"
                className="scanner-roi" 
                style={{
                  position: 'absolute',
                  border: '2px solid rgba(255, 255, 255, 0.8)',
                  boxShadow: '0 0 0 9999px rgba(0, 0, 0, 0.5)',
                  borderRadius: '8px',
                  transition: 'all 0.2s ease',
                  ...roiStyle
                }}
              />
            )}
          </div>
          
          {error && <div className="error">{error}</div>}

          <div className="controls">
            <button className="btn" onClick={startCamera} disabled={scanning}>Iniciar</button>
            <button className="btn ghost" onClick={stopCamera}>Detener</button>
          </div>

          <div style={{ textAlign: 'center', marginTop: '1rem' }}>
            <button className="btn ghost small" style={{ fontSize: '0.85rem', padding: '4px 8px' }} onClick={() => setShowSettings(!showSettings)}>
              {showSettings ? "Ocultar ConfiguraciÃ³n" : "ConfiguraciÃ³n (CÃ¡mara / Modo)"}
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
                <label className="label">CÃ¡mara</label>
                <select className="input" value={deviceId} onChange={(e) => setDeviceId(e.target.value)}>
                  {devices.length === 0 ? (
                    <option value="">(no detectada)</option>
                  ) : (
                    devices.map((d) => (
                      <option key={d.deviceId} value={d.deviceId}>
                        {d.label || `Camera ${d.deviceId.slice(0, 6)}â€¦`}
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
                placeholder="CÃ³digo..."
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
          )}
            </div>
          )}

        </div>

        <div className="card listCard">
          <div className="cardHead">
            <h2>Tabla</h2>
            <div className="muted">Cada lectura agrega una lÃ­nea nueva. Se guarda localmente.</div>
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
                  <th>Serial</th>
                </tr>
              </thead>
              <tbody>
                {orderedRows.length === 0 ? (
                  <tr><td colSpan="3" className="muted">No hay lecturas aÃºn.</td></tr>
                ) : (
                  orderedRows.map((r, i) => (
                    <tr key={`${r._ts}-${i}`}>
                      <td>{orderedRows.length - i}</td>
                      <td className="mono">{r.timestamp}</td>
                      <td className="mono">{r.serial}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>

          <div className="note">
            <strong>Excel:</strong> Exporta un .xlsx listo. Si quieres â€œllenar un Excel existenteâ€, puedes importar una plantilla
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
