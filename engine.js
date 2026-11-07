// ============================================================
//  KONFIGURACJA — wklej token tutaj albo zostaw puste i wpisz go w aplikacji.
//  Hugging Face: https://huggingface.co/settings/tokens  (uprawnienie: odczyt)
//  NIE commituj prawdziwego tokenu do publicznego repozytorium.
// ============================================================

/** @type {string} */
export const HF_TOKEN = "";

export const CONFIG = {
  /** @type {"huggingface" | "replicate"} */
  provider: "huggingface",
  /** Space z pojedynczą podmianą. CORS działa z GitHub Pages. */
  hfSpaceId: "tonyassi/face-swap",
  /** Nazwa endpointu Gradio, bez ukośnika. */
  hfApiName: "swap_faces",
  /** Zamiana całej głowy (włosy, uszy, szyja), nie samych rysów. */
  headSpaceId: "kailashjha123/head-swap-tool",
  headApiName: "head_swap",
  /** 0.3–1: ile kadru wokół twarzy objąć (włosy i szyja). */
  headExpand: 0.6,
  /** Opcjonalny token Replicate (r8_…). Z przeglądarki zadziała tylko przez proxy. */
  replicateToken: "",
  replicateVersion:
    "codeplugtech/face-swap:278a81e7ebb22db98bcba54de985d22cc1abeead2754eb1f2af717247be69b34",
  /** Pusty = wołanie wprost na api.replicate.com (zablokowane przez CORS w przeglądarce). */
  replicateProxy: "",
};

const VISION_URL =
  "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.32/vision_bundle.mjs";
const VISION_WASM =
  "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.32/wasm";
const FACE_MODEL =
  "https://storage.googleapis.com/mediapipe-models/face_detector/blaze_face_short_range/float16/1/blaze_face_short_range.tflite";

const MAX_EDGE = 2560;
const API_EDGE = 1024;

/**
 * @typedef {{ x: number, y: number, w: number, h: number, score: number }} Box
 * @typedef {{ x: number, y: number, w: number, h: number, score: number, thumb: string }} FaceBox
 * @typedef {{ width: number, height: number, faces: FaceBox[] }} Inspection
 * @typedef {{ blob: Blob, facesFound: number, swapped: number, width: number, height: number }} SwapResult
 */

/** @type {Promise<any> | null} */
let detectorPromise = null;

/**
 * @param {Blob} blob
 * @returns {Promise<HTMLCanvasElement>}
 */
export async function decodeImage(blob) {
  let bitmap;
  try {
    bitmap = await createImageBitmap(blob, { imageOrientation: "from-image" });
  } catch {
    throw new Error("Nie udało się odczytać zdjęcia. Zapisz je jako JPG lub PNG.");
  }
  const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Przeglądarka nie udostępniła płótna.");
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  return canvas;
}

/**
 * @param {HTMLCanvasElement} canvas
 * @param {number} maxEdge
 */
function downscale(canvas, maxEdge) {
  const max = Math.max(canvas.width, canvas.height);
  if (max <= maxEdge) return canvas;
  const scale = maxEdge / max;
  const next = document.createElement("canvas");
  next.width = Math.max(1, Math.round(canvas.width * scale));
  next.height = Math.max(1, Math.round(canvas.height * scale));
  const ctx = next.getContext("2d");
  if (!ctx) throw new Error("Przeglądarka nie udostępniła płótna.");
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(canvas, 0, 0, next.width, next.height);
  return next;
}

/**
 * @param {HTMLCanvasElement} canvas
 * @param {number} [quality]
 */
function canvasToBlob(canvas, quality = 0.92) {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (!blob) reject(new Error("Nie udało się zapisać obrazu."));
        else resolve(blob);
      },
      "image/jpeg",
      quality,
    );
  });
}

/** @returns {Promise<any>} */
async function getDetector() {
  if (!detectorPromise) {
    detectorPromise = (async () => {
      const vision = await import(/* @vite-ignore */ VISION_URL);
      const fileset = await vision.FilesetResolver.forVisionTasks(VISION_WASM);
      return vision.FaceDetector.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: FACE_MODEL, delegate: "CPU" },
        runningMode: "IMAGE",
        minDetectionConfidence: 0.5,
      });
    })().catch((error) => {
      detectorPromise = null;
      throw error;
    });
  }
  return detectorPromise;
}

/**
 * @param {HTMLCanvasElement} canvas
 * @returns {Promise<Array<{ x: number, y: number, w: number, h: number, score: number }>>}
 */
async function detectBoxes(canvas) {
  const Builtin = /** @type {any} */ (globalThis).FaceDetector;
  if (typeof Builtin === "function") {
    try {
      const detector = new Builtin({ fastMode: false, maxDetectedFaces: 8 });
      const found = /** @type {any[]} */ (await detector.detect(canvas));
      const boxes = found
        .map((/** @type {any} */ face) => ({
          x: face.boundingBox.x,
          y: face.boundingBox.y,
          w: face.boundingBox.width,
          h: face.boundingBox.height,
          score: 1,
        }))
        .filter((/** @type {Box} */ box) => box.w > 12 && box.h > 12);
      if (boxes.length) return boxes.sort((a, b) => a.x - b.x);
    } catch {
      /* MediaPipe poniżej */
    }
  }

  const detector = await getDetector();
  const result = detector.detect(canvas);
  const detections = /** @type {any[]} */ (result?.detections || []);
  return detections
    .map((detection) => {
      const box = detection.boundingBox || {};
      const score = detection.categories?.[0]?.score ?? 0;
      return {
        x: Number(box.originX) || 0,
        y: Number(box.originY) || 0,
        w: Number(box.width) || 0,
        h: Number(box.height) || 0,
        score: Number(score) || 0,
      };
    })
    .filter((box) => box.w > 12 && box.h > 12)
    .sort((a, b) => a.x - b.x);
}

/**
 * @param {HTMLCanvasElement} canvas
 * @param {{ x: number, y: number, w: number, h: number }} box
 */
function thumbFor(canvas, box) {
  const pad = 0.35;
  const x = Math.max(0, box.x - box.w * pad);
  const y = Math.max(0, box.y - box.h * pad);
  const w = Math.min(canvas.width - x, box.w * (1 + pad * 2));
  const h = Math.min(canvas.height - y, box.h * (1 + pad * 2));
  const size = 112;
  const out = document.createElement("canvas");
  out.width = size;
  out.height = size;
  const ctx = out.getContext("2d");
  if (!ctx) return "";
  ctx.drawImage(canvas, x, y, w, h, 0, 0, size, size);
  return out.toDataURL("image/jpeg", 0.8);
}

/**
 * @param {Blob} blob
 * @returns {Promise<Inspection>}
 */
export async function inspectTarget(blob) {
  const canvas = await decodeImage(blob);
  /** @type {Box[]} */
  let boxes = [];
  try {
    boxes = await detectBoxes(canvas);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Detektor twarzy niedostępny.";
    throw new Error(message);
  }
  return {
    width: canvas.width,
    height: canvas.height,
    faces: boxes.map((box) => ({ ...box, thumb: thumbFor(canvas, box) })),
  };
}

/**
 * @param {HTMLCanvasElement} src
 * @param {{ x: number, y: number, w: number, h: number }} box
 * @param {number} [scale]
 */
function cropAround(src, box, scale = 2.6) {
  const cx = box.x + box.w / 2;
  const cy = box.y + box.h / 2;
  let side = Math.max(box.w, box.h) * scale;
  side = Math.min(side, src.width, src.height);
  side = Math.max(32, Math.round(side));
  let x = Math.round(cx - side / 2);
  let y = Math.round(cy - side / 2);
  x = Math.max(0, Math.min(x, src.width - side));
  y = Math.max(0, Math.min(y, src.height - side));
  const canvas = document.createElement("canvas");
  canvas.width = side;
  canvas.height = side;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Przeglądarka nie udostępniła płótna.");
  ctx.drawImage(src, x, y, side, side, 0, 0, side, side);
  return { canvas, rect: { x, y, w: side, h: side } };
}

/**
 * @param {HTMLCanvasElement} base
 * @param {HTMLCanvasElement} swapped
 * @param {{ x: number, y: number, w: number, h: number }} rect
 * @param {number} [featherRatio]
 */
function pasteFeather(base, swapped, rect, featherRatio = 0.07) {
  const ctx = base.getContext("2d");
  if (!ctx) throw new Error("Przeglądarka nie udostępniła płótna.");
  const feather = Math.max(14, Math.round(Math.min(rect.w, rect.h) * featherRatio));
  const tmp = document.createElement("canvas");
  tmp.width = rect.w;
  tmp.height = rect.h;
  const tctx = tmp.getContext("2d");
  const mask = document.createElement("canvas");
  mask.width = rect.w;
  mask.height = rect.h;
  const mctx = mask.getContext("2d");
  if (!tctx || !mctx) throw new Error("Przeglądarka nie udostępniła płótna.");

  tctx.drawImage(swapped, 0, 0, rect.w, rect.h);
  mctx.fillStyle = "#fff";
  mctx.fillRect(feather, feather, Math.max(1, rect.w - feather * 2), Math.max(1, rect.h - feather * 2));

  /**
   * @param {CanvasGradient} gradient
   * @param {number} x
   * @param {number} y
   * @param {number} w
   * @param {number} h
   */
  const paint = (gradient, x, y, w, h) => {
    mctx.fillStyle = gradient;
    mctx.fillRect(x, y, w, h);
  };
  let gradient = mctx.createLinearGradient(0, 0, 0, feather);
  gradient.addColorStop(0, "rgba(255,255,255,0)");
  gradient.addColorStop(1, "#fff");
  paint(gradient, 0, 0, rect.w, feather);
  gradient = mctx.createLinearGradient(0, rect.h, 0, rect.h - feather);
  gradient.addColorStop(0, "rgba(255,255,255,0)");
  gradient.addColorStop(1, "#fff");
  paint(gradient, 0, rect.h - feather, rect.w, feather);
  gradient = mctx.createLinearGradient(0, 0, feather, 0);
  gradient.addColorStop(0, "rgba(255,255,255,0)");
  gradient.addColorStop(1, "#fff");
  paint(gradient, 0, 0, feather, rect.h);
  gradient = mctx.createLinearGradient(rect.w, 0, rect.w - feather, 0);
  gradient.addColorStop(0, "rgba(255,255,255,0)");
  gradient.addColorStop(1, "#fff");
  paint(gradient, rect.w - feather, 0, feather, rect.h);

  tctx.globalCompositeOperation = "destination-in";
  tctx.drawImage(mask, 0, 0);
  ctx.drawImage(tmp, rect.x, rect.y);
}

/**
 * @param {string} spaceId
 */
function spaceOrigin(spaceId) {
  const id = spaceId.trim().toLowerCase();
  if (!id.includes("/")) {
    throw new Error("Identyfikator Space powinien mieć postać użytkownik/nazwa.");
  }
  return `https://${id.replaceAll("/", "-")}.hf.space`;
}

/**
 * @param {number} status
 * @param {string} body
 */
function friendlyHttp(status, body) {
  const clean = body
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 280);
  if (status === 401 || status === 403) {
    return "Token został odrzucony. Sprawdź, czy jest aktualny i ma uprawnienie do odczytu.";
  }
  if (status === 429) return "Limit zapytań. Wklej token albo odczekaj chwilę.";
  if (status === 404) return "Nie znaleziono tego endpointu. Sprawdź nazwę Space.";
  if (status >= 500) return "Usługa jest przeciążona albo dopiero się budzi. Spróbuj za minutę.";
  return clean || `Błąd API (HTTP ${status}).`;
}

/**
 * @param {string} message
 */
function translateModelError(message) {
  const text = message.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  const lower = text.toLowerCase();
  if (lower.includes("face nahi") || lower.includes("nahi mila") || lower.includes("source me face")) {
    return "Nie znaleziono głowy na jednym ze zdjęć. Użyj wyraźnego, frontalnego kadru.";
  }
  if (lower.includes("no face") || lower.includes("faces detected") || lower.includes("face not")) {
    return "Model nie znalazł twarzy. Użyj wyraźniejszego, frontalnego zdjęcia.";
  }
  if (lower.includes("please upload")) return "API nie dostało obu zdjęć.";
  return text.slice(0, 400) || "Space zwrócił błąd bez opisu.";
}

/**
 * @param {string} text
 */
function parseGradioSse(text) {
  /** @type {string | null} */
  let error = null;
  /** @type {string | null} */
  let data = null;
  for (const block of text.split(/\n\n+/)) {
    const eventName = /(?:^|\n)event:\s*(\S+)/.exec(block)?.[1];
    const dataLines = block
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trim());
    if (!eventName || !dataLines.length) continue;
    const payload = dataLines.join("\n");
    if (eventName === "error") error = payload;
    if (eventName === "complete") data = payload;
  }
  if (!data) {
    let message = error || "Space zakończył pracę bez obrazu. Darmowa instancja bywa uśpiona — spróbuj ponownie.";
    try {
      if (error) {
        const parsed = JSON.parse(error);
        message = String(parsed?.error || parsed?.message || message);
      }
    } catch {
      /* zostaw tekst */
    }
    throw new Error(translateModelError(message));
  }
  const parsed = JSON.parse(data);
  if (Array.isArray(parsed) && (parsed[0] == null || parsed[0] === "") && typeof parsed[1] === "string") {
    throw new Error(translateModelError(parsed[1]));
  }
  const item = Array.isArray(parsed) ? parsed[0] : parsed;
  const url = item?.url || item?.path || (typeof item === "string" ? item : "");
  if (!url) throw new Error("Odpowiedź API nie zawiera obrazu.");
  return String(url);
}

/**
 * @param {string} host
 * @param {Blob} blob
 * @param {string} token
 * @param {AbortSignal | undefined} signal
 */
async function uploadToSpace(host, blob, token, signal) {
  const body = new FormData();
  body.append("files", blob, "frame.jpg");
  /** @type {Record<string, string>} */
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  const response = await fetch(`${host}/gradio_api/upload`, {
    method: "POST",
    headers,
    body,
    signal,
  });
  if (!response.ok) throw new Error(friendlyHttp(response.status, await response.text()));
  const json = await response.json();
  const path = Array.isArray(json) ? json[0] : json;
  if (typeof path !== "string" || !path) throw new Error("Nie udało się wgrać zdjęcia na Space.");
  return {
    path,
    meta: { _type: "gradio.FileData" },
    orig_name: "frame.jpg",
    mime_type: "image/jpeg",
  };
}

/**
 * @param {string} host
 * @param {string} url
 */
function absoluteSpaceUrl(host, url) {
  if (url.startsWith("data:") || url.startsWith("http://") || url.startsWith("https://")) return url;
  if (url.startsWith("/")) return `${host}${url}`;
  return `${host}/gradio_api/file=${url}`;
}

/**
 * @param {string} host
 * @param {string} apiName
 * @param {unknown[]} data
 * @param {string} token
 * @param {AbortSignal | undefined} signal
 * @returns {Promise<HTMLCanvasElement>}
 */
async function gradioPredict(host, apiName, data, token, signal) {
  const name = apiName.replace(/^\//, "");
  /** @type {Record<string, string>} */
  const headers = { "Content-Type": "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  const posted = await fetch(`${host}/gradio_api/call/${name}`, {
    method: "POST",
    headers,
    body: JSON.stringify({ data }),
    signal,
  });
  if (!posted.ok) throw new Error(friendlyHttp(posted.status, await posted.text()));
  const started = await posted.json();
  const eventId = started?.event_id;
  if (typeof eventId !== "string" || !eventId) {
    throw new Error("Space nie przyjął zadania. Sprawdź nazwę endpointu.");
  }
  const streamed = await fetch(`${host}/gradio_api/call/${name}/${eventId}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    signal,
  });
  if (!streamed.ok) throw new Error(friendlyHttp(streamed.status, await streamed.text()));
  const resultUrl = absoluteSpaceUrl(host, parseGradioSse(await streamed.text()));
  const imageResponse = await fetch(resultUrl, { signal });
  if (!imageResponse.ok) throw new Error("Nie udało się pobrać obrazu z Space.");
  return decodeImage(await imageResponse.blob());
}

/**
 * @param {string} host
 * @param {HTMLCanvasElement} source
 * @param {HTMLCanvasElement} target
 * @param {string} token
 * @param {AbortSignal | undefined} signal
 */
async function uploadPair(host, source, target, token, signal) {
  const srcFile = await uploadToSpace(host, await canvasToBlob(downscale(source, API_EDGE), 0.9), token, signal);
  const dstFile = await uploadToSpace(host, await canvasToBlob(downscale(target, API_EDGE), 0.9), token, signal);
  return [srcFile, dstFile];
}

/**
 * @param {HTMLCanvasElement} source
 * @param {HTMLCanvasElement} target
 * @param {string} token
 * @param {typeof CONFIG} config
 * @param {AbortSignal | undefined} signal
 * @returns {Promise<HTMLCanvasElement>}
 */
async function huggingfaceSwap(source, target, token, config, signal) {
  const host = spaceOrigin(config.hfSpaceId);
  const files = await uploadPair(host, source, target, token, signal);
  return gradioPredict(host, config.hfApiName, files, token, signal);
}

/**
 * Wysyła parametr expand_ratio: wycięcie i wtopienie całej głowy ze włosami.
 * @param {HTMLCanvasElement} source
 * @param {HTMLCanvasElement} target
 * @param {string} token
 * @param {typeof CONFIG} config
 * @param {number} expandRatio
 * @param {AbortSignal | undefined} signal
 * @returns {Promise<HTMLCanvasElement>}
 */
async function headSwap(source, target, token, config, expandRatio, signal) {
  const host = spaceOrigin(config.headSpaceId);
  const files = await uploadPair(host, source, target, token, signal);
  const ratio = Math.min(1, Math.max(0.3, Number(expandRatio) || config.headExpand));
  return gradioPredict(host, config.headApiName, [...files, ratio], token, signal);
}

/**
 * @param {HTMLCanvasElement} source
 * @param {HTMLCanvasElement} target
 * @param {string} token
 * @param {typeof CONFIG} config
 * @param {AbortSignal | undefined} signal
 * @returns {Promise<HTMLCanvasElement>}
 */
async function replicateSwap(source, target, token, config, signal) {
  if (!token) throw new Error("Replicate wymaga tokenu zaczynającego się od r8_.");
  const root = (config.replicateProxy || "https://api.replicate.com").replace(/\/$/, "");
  const version = config.replicateVersion.includes(":")
    ? config.replicateVersion.split(":").pop()
    : config.replicateVersion;
  const srcUrl = await blobToDataUrl(await canvasToBlob(downscale(source, API_EDGE), 0.9));
  const dstUrl = await blobToDataUrl(await canvasToBlob(downscale(target, API_EDGE), 0.9));
  let response;
  try {
    response = await fetch(`${root}/v1/predictions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        Prefer: "wait",
      },
      body: JSON.stringify({
        version,
        input: { input_image: dstUrl, swap_image: srcUrl },
      }),
      signal,
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    throw new Error(
      "Przeglądarka zablokowała Replicate (CORS). Zostań przy Hugging Face albo wpisz adres własnego proxy.",
    );
  }
  if (!response.ok) throw new Error(friendlyHttp(response.status, await response.text()));
  const prediction = await response.json();
  let output = prediction?.output;
  if (prediction?.status && prediction.status !== "succeeded") {
    const poll = prediction?.urls?.get;
    if (!poll) throw new Error(prediction?.error || "Replicate nie zwrócił wyniku.");
    output = await pollReplicate(poll, token, signal);
  }
  const url = Array.isArray(output) ? output[0] : output;
  if (typeof url !== "string") throw new Error("Replicate nie zwrócił adresu obrazu.");
  const imageResponse = await fetch(url, { signal });
  if (!imageResponse.ok) throw new Error("Nie udało się pobrać obrazu z Replicate.");
  return decodeImage(await imageResponse.blob());
}

/**
 * @param {string} url
 * @param {string} token
 * @param {AbortSignal | undefined} signal
 */
async function pollReplicate(url, token, signal) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    await delay(2000, signal);
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
      signal,
    });
    if (!response.ok) throw new Error(friendlyHttp(response.status, await response.text()));
    const prediction = await response.json();
    if (prediction.status === "succeeded") return prediction.output;
    if (prediction.status === "failed" || prediction.status === "canceled") {
      throw new Error(prediction.error || "Replicate przerwał zadanie.");
    }
  }
  throw new Error("Replicate nie zdążył odpowiedzieć. Spróbuj ponownie.");
}

/**
 * @param {Blob} blob
 */
function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error("Nie udało się zakodować zdjęcia."));
    reader.readAsDataURL(blob);
  });
}

/**
 * @param {number} ms
 * @param {AbortSignal | undefined} signal
 */
function delay(ms, signal) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(new DOMException("Przerwano.", "AbortError"));
      },
      { once: true },
    );
  });
}

/**
 * Jedno wywołanie chmurowe: twarz ze źródła ląduje na kadrze docelowym.
 * @param {HTMLCanvasElement} source
 * @param {HTMLCanvasElement} target
 * @param {{ token?: string, config?: typeof CONFIG, signal?: AbortSignal }} [options]
 */
export async function swapImages(source, target, options = {}) {
  const config = options.config || CONFIG;
  const token = (options.token || "").trim();
  if (config.provider === "replicate") {
    return replicateSwap(source, target, token || CONFIG.replicateToken, config, options.signal);
  }
  return huggingfaceSwap(source, target, token || HF_TOKEN, config, options.signal);
}

/**
 * @param {Box[]} boxes
 * @param {number | undefined} index
 */
function pickBox(boxes, index) {
  if (!boxes.length) return null;
  if (typeof index === "number" && index >= 0 && index < boxes.length) return boxes[index];
  return [...boxes].sort((a, b) => b.w * b.h - a.w * a.h)[0];
}

/**
 * @param {object} options
 * @param {"single" | "multi" | "head"} options.mode
 * @param {Blob[]} options.sources
 * @param {Blob} options.target
 * @param {Array<{ sourceIndex: number, targetIndex: number }>} [options.pairs]
 * @param {number} [options.sourceIndex]
 * @param {number} [options.targetIndex]
 * @param {number} [options.expandRatio]
 * @param {string} [options.token]
 * @param {typeof CONFIG} [options.config]
 * @param {AbortSignal} [options.signal]
 * @param {(percent: number, label: string) => void} [options.onProgress]
 * @returns {Promise<SwapResult>}
 */
export async function runFaceSwap(options) {
  const { mode, sources, target, signal, onProgress } = options;
  const config = options.config || CONFIG;
  const token = (options.token || HF_TOKEN || "").trim();
  /** @type {(percent: number, label: string) => void} */
  const report = (percent, label) => onProgress?.(percent, label);

  if (!sources.length || !sources[0]) throw new Error("Dodaj zdjęcie źródłowe z twarzą.");
  if (!target) throw new Error("Dodaj zdjęcie docelowe.");

  report(6, "Czytam zdjęcia…");
  const base = await decodeImage(target);
  const sourceCanvas = await decodeImage(sources[0]);

  if (mode === "head") {
    report(16, "Szukam głów…");
    /** @type {Box[]} */
    let srcBoxes = [];
    /** @type {Box[]} */
    let tgtBoxes = [];
    try {
      srcBoxes = await detectBoxes(sourceCanvas);
      tgtBoxes = await detectBoxes(base);
    } catch {
      /* Space wykryje twarz sam, gdy detektor lokalny zawiedzie. */
    }
    const srcBox = pickBox(srcBoxes, options.sourceIndex);
    const tgtBox = pickBox(tgtBoxes, options.targetIndex);
    const ratio = options.expandRatio ?? config.headExpand;
    if (srcBox && tgtBox) {
      report(28, "Wycinam głowę ze włosami i wysyłam do API…");
      const srcCrop = cropAround(sourceCanvas, srcBox, 3.8);
      const dstCrop = cropAround(base, tgtBox, 3.8);
      const swapped = await headSwap(srcCrop.canvas, dstCrop.canvas, token, config, ratio, signal);
      pasteFeather(base, swapped, dstCrop.rect, 0.14);
    } else {
      report(28, "Wysyłam całe kadry do zamiany głowy…");
      const swapped = await headSwap(sourceCanvas, base, token, config, ratio, signal);
      const ctx = base.getContext("2d");
      if (!ctx) throw new Error("Przeglądarka nie udostępniła płótna.");
      ctx.drawImage(swapped, 0, 0, base.width, base.height);
    }
    report(94, "Zapisuję pełną rozdzielczość…");
    const blob = await canvasToBlob(base, 0.95);
    report(100, "Gotowe");
    return { blob, facesFound: tgtBoxes.length, swapped: 1, width: base.width, height: base.height };
  }

  report(14, "Szukam twarzy…");
  /** @type {Box[]} */
  let srcBoxes = [];
  /** @type {Box[]} */
  let tgtBoxes = [];
  try {
    srcBoxes = await detectBoxes(sourceCanvas);
    tgtBoxes = await detectBoxes(base);
  } catch (error) {
    if (mode === "multi") {
      const message = error instanceof Error ? error.message : "Detektor twarzy niedostępny.";
      throw new Error(message);
    }
  }

  /** @type {Array<{ source: Box, target: Box }>} */
  const jobs = [];
  if (mode === "multi") {
    if (!srcBoxes.length || !tgtBoxes.length) {
      throw new Error("Nie widzę twarzy na obu zdjęciach. Użyj wyraźniejszych, frontalnych kadrów.");
    }
    const pairs = options.pairs || [];
    for (const pair of pairs) {
      const source = srcBoxes[pair.sourceIndex];
      const dest = tgtBoxes[pair.targetIndex];
      if (source && dest) jobs.push({ source, target: dest });
    }
    if (!jobs.length) {
      throw new Error("Dotknij twarz na źródle, a potem osobę na zdjęciu docelowym.");
    }
  } else {
    const source = pickBox(srcBoxes, options.sourceIndex);
    const dest = pickBox(tgtBoxes, options.targetIndex);
    if (source && dest) jobs.push({ source, target: dest });
  }

  if (!jobs.length) {
    report(28, "Wysyłam całe zdjęcie do modelu…");
    const swapped = await swapImages(sourceCanvas, base, { token, config, signal });
    const ctx = base.getContext("2d");
    if (!ctx) throw new Error("Przeglądarka nie udostępniła płótna.");
    ctx.drawImage(swapped, 0, 0, base.width, base.height);
    const blob = await canvasToBlob(base, 0.95);
    report(100, "Gotowe");
    return { blob, facesFound: 0, swapped: 1, width: base.width, height: base.height };
  }

  const total = jobs.length;
  for (let index = 0; index < total; index += 1) {
    if (signal?.aborted) throw new DOMException("Przerwano.", "AbortError");
    const faceNo = index + 1;
    report(
      18 + Math.round((index / total) * 70),
      total === 1 ? "Podmieniam twarz w chmurze…" : `Podmieniam twarz ${faceNo} z ${total}…`,
    );
    const srcCrop = cropAround(sourceCanvas, jobs[index].source, 2.4);
    const dstCrop = cropAround(base, jobs[index].target, 2.6);
    const swapped = await swapImages(srcCrop.canvas, dstCrop.canvas, { token, config, signal });
    pasteFeather(base, swapped, dstCrop.rect);
    report(18 + Math.round((faceNo / total) * 70), total === 1 ? "Składam wynik…" : `Twarz ${faceNo} gotowa`);
  }

  report(94, "Zapisuję pełną rozdzielczość…");
  const blob = await canvasToBlob(base, 0.95);
  report(100, "Gotowe");
  return {
    blob,
    facesFound: tgtBoxes.length,
    swapped: jobs.length,
    width: base.width,
    height: base.height,
  };
}
