import { CONFIG, HF_TOKEN, inspectTarget, runFaceSwap } from "./engine.js";

const TOKEN_KEY = "oblicze.hfToken";
const HINTS = {
  single: "Dwa zdjęcia. Podmieniam rysy największej twarzy.",
  multi: "Dwa zdjęcia, nawet grupowe. Nie wgrywasz twarzy osobno — wybierasz je palcem na miniaturkach.",
  head: "Dwa zdjęcia. Wycinam i wtapiam całą głowę: włosy, uszy i szyję, nie same rysy.",
};

const $ = (id) => document.querySelector(id);

/** @type {"single" | "multi" | "head"} */
let mode = "single";
/** @type {File | null} */
let source = null;
/** @type {File | null} */
let target = null;
/** @type {Array<{ thumb: string }>} */
let sourceFaces = [];
/** @type {Array<{ thumb: string }>} */
let targetFaces = [];
/** @type {number[]} */
let assign = [];
/** @type {number | null} */
let armed = null;
let headSource = 0;
let headTarget = 0;
/** @type {Blob | null} */
let resultBlob = null;
/** @type {AbortController | null} */
let abortCtrl = null;
let scanGen = 0;

const els = {
  hint: $("#hint"),
  sourceSlot: $("#source-slot"),
  targetSlot: $("#target-slot"),
  sourceFaces: $("#source-faces"),
  targetFaces: $("#target-faces"),
  pairNote: $("#pair-note"),
  expandBox: $("#expand-box"),
  zasieg: $("#zasieg"),
  zasiegValue: $("#zasieg-value"),
  consent: $("#consent"),
  token: $("#token"),
  space: $("#space"),
  error: $("#error"),
  progressWrap: $("#progress-wrap"),
  progressBar: $("#progress-bar"),
  progressLabel: $("#progress-label"),
  cancel: $("#cancel"),
  go: $("#go"),
  result: $("#result"),
  resultEmpty: $("#result-empty"),
  resultMeta: $("#result-meta"),
  download: $("#download"),
};

els.space.value = CONFIG.hfSpaceId;
const stored = localStorage.getItem(TOKEN_KEY) || HF_TOKEN || "";
if (stored) els.token.value = stored;

function dropzone(label, hint, onFile) {
  const labelEl = document.createElement("label");
  labelEl.className = "relative block min-h-40 overflow-hidden rounded-card border border-dashed border-line bg-surface";
  const input = document.createElement("input");
  input.type = "file";
  input.accept = "image/*";
  input.className = "sr-only";
  const empty = document.createElement("span");
  empty.className = "flex h-40 flex-col items-center justify-center px-4 text-center";
  empty.innerHTML = `<span class="text-sm">${label}</span><span class="mt-1 text-xs text-muted">${hint}</span>`;
  const preview = document.createElement("img");
  preview.alt = "";
  preview.className = "hidden h-52 w-full object-cover";
  const clear = document.createElement("button");
  clear.type = "button";
  clear.className = "absolute right-2 top-2 hidden size-11 rounded-full bg-bg/80";
  clear.textContent = "×";
  clear.setAttribute("aria-label", `Usuń ${label}`);
  labelEl.append(input, empty, preview, clear);
  labelEl.addEventListener("dragover", (event) => event.preventDefault());
  labelEl.addEventListener("drop", (event) => {
    event.preventDefault();
    const file = event.dataTransfer?.files?.[0];
    if (file && file.type.startsWith("image/")) onFile(file);
  });
  input.addEventListener("change", () => {
    const file = input.files?.[0];
    if (file) onFile(file);
    input.value = "";
  });
  return {
    root: labelEl,
    /** @param {File | null} file @param {() => void} onClear */
    show(file, onClear) {
      if (!file) {
        preview.classList.add("hidden");
        empty.classList.remove("hidden");
        clear.classList.add("hidden");
        return;
      }
      preview.src = URL.createObjectURL(file);
      preview.classList.remove("hidden");
      empty.classList.add("hidden");
      clear.classList.remove("hidden");
      clear.onclick = (event) => {
        event.preventDefault();
        event.stopPropagation();
        onClear();
      };
    },
  };
}

const sourceZone = dropzone("1 · Zdjęcie źródłowe", "jedno zdjęcie, może być grupowe", (file) => {
  source = file;
  sourceZone.show(file, () => {
    source = null;
    sourceZone.show(null, () => {});
    void scan();
  });
  void scan();
});
const targetZone = dropzone("2 · Zdjęcie docelowe", "jedno zdjęcie, może być grupowe", (file) => {
  target = file;
  targetZone.show(file, () => {
    target = null;
    targetZone.show(null, () => {});
    void scan();
  });
  void scan();
});
els.sourceSlot.append(sourceZone.root);
els.targetSlot.append(targetZone.root);

function setMode(next) {
  mode = next;
  for (const [id, key] of [
    ["#tab-single", "single"],
    ["#tab-multi", "multi"],
    ["#tab-head", "head"],
  ]) {
    const button = $(id);
    const on = key === next;
    button.className = on
      ? "flex min-h-14 items-center justify-center rounded-xl bg-ink px-1 text-center text-xs font-medium leading-tight text-bg"
      : "flex min-h-14 items-center justify-center rounded-xl px-1 text-center text-xs font-medium leading-tight text-muted";
  }
  els.hint.textContent = HINTS[next];
  els.expandBox.classList.toggle("hidden", next !== "head");
  els.go.textContent = next === "head" ? "Zamień głowę" : next === "multi" ? "Podmień wskazane" : "Podmień twarz";
  renderFaces();
  refresh();
}

function largest(faces) {
  let best = 0;
  faces.forEach((face, index) => {
    if ((face.w || 0) * (face.h || 0) > (faces[best].w || 0) * (faces[best].h || 0)) best = index;
  });
  return best;
}

async function scan() {
  const gen = ++scanGen;
  const [src, dst] = await Promise.all([
    source ? inspectTarget(source).catch(() => ({ faces: [] })) : { faces: [] },
    target ? inspectTarget(target).catch(() => ({ faces: [] })) : { faces: [] },
  ]);
  if (gen !== scanGen) return;
  sourceFaces = src.faces;
  targetFaces = dst.faces;
  const pairs = Math.min(sourceFaces.length, targetFaces.length);
  assign = targetFaces.map((_, index) => (index < pairs ? index : -1));
  armed = sourceFaces.length ? 0 : null;
  headSource = sourceFaces.length ? largest(sourceFaces) : 0;
  headTarget = targetFaces.length ? largest(targetFaces) : 0;
  renderFaces();
  refresh();
}

function renderStrip(container, title, faces, active, onPick, numberFor) {
  container.replaceChildren();
  const heading = document.createElement("p");
  heading.className = "text-xs uppercase tracking-widest text-muted";
  heading.textContent = title;
  container.append(heading);
  if (!faces.length) {
    const note = document.createElement("p");
    note.className = "mt-2 text-xs text-muted";
    note.textContent = "Nie widzę tu twarzy. Spróbuj wyraźniejszego, frontalnego zdjęcia.";
    container.append(note);
    return;
  }
  const row = document.createElement("div");
  row.className = "mt-2 flex gap-2 overflow-x-auto pb-1";
  faces.forEach((face, index) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "relative block size-16 shrink-0";
    button.setAttribute("aria-label", `${title}, osoba ${index + 1}`);
    const img = document.createElement("img");
    img.src = face.thumb;
    img.alt = "";
    img.className = `size-16 rounded-xl object-cover ${active(index) ? "ring-2 ring-copper" : "opacity-80 ring-1 ring-line"}`;
    const badge = document.createElement("span");
    badge.className = "absolute left-1 top-1 flex size-6 items-center justify-center rounded-full bg-bg/90 text-xs font-medium";
    badge.textContent = String(numberFor(index));
    button.append(img, badge);
    button.addEventListener("click", () => onPick(index));
    row.append(button);
  });
  container.append(row);
}

function renderFaces() {
  const show = mode !== "single";
  els.sourceFaces.classList.toggle("hidden", !show);
  els.targetFaces.classList.toggle("hidden", !show);
  if (!show) return;
  if (!source) {
    els.sourceFaces.replaceChildren();
    const title = document.createElement("p");
    title.className = "text-xs uppercase tracking-widest text-muted";
    title.textContent = mode === "head" ? "Którą głowę przenieść" : "Twarze na źródle";
    const note = document.createElement("p");
    note.className = "mt-2 text-xs text-muted";
    note.textContent = "Po wgraniu zdjęcia pojawią się tu kwadraty z twarzami.";
    els.sourceFaces.append(title, note);
  } else {
    renderStrip(
      els.sourceFaces,
      mode === "head" ? "Którą głowę przenieść" : "Twarze na źródle",
      sourceFaces,
      (index) => (mode === "head" ? index === headSource : index === armed),
      (index) => {
        if (mode === "head") headSource = index;
        else armed = index;
        renderFaces();
        refresh();
      },
      (index) => index + 1,
    );
  }
  if (!target) {
    els.targetFaces.replaceChildren();
    const title = document.createElement("p");
    title.className = "text-xs uppercase tracking-widest text-muted";
    title.textContent = mode === "head" ? "Na którą osobę" : "Twarze na celu";
    const note = document.createElement("p");
    note.className = "mt-2 text-xs text-muted";
    note.textContent = "Po wgraniu zdjęcia pojawią się tu kwadraty z twarzami.";
    els.targetFaces.append(title, note);
  } else {
    renderStrip(
      els.targetFaces,
      mode === "head" ? "Na którą osobę" : "Twarze na celu",
      targetFaces,
      (index) => (mode === "head" ? index === headTarget : assign[index] >= 0),
      (index) => {
        if (mode === "head") headTarget = index;
        else if (armed != null) assign[index] = assign[index] === armed ? -1 : armed;
        renderFaces();
        refresh();
      },
      (index) => (mode === "multi" && assign[index] >= 0 ? assign[index] + 1 : index + 1),
    );
  }
  const count = assign.filter((value) => value >= 0).length;
  els.pairNote.classList.toggle("hidden", mode !== "multi");
  els.pairNote.textContent =
    armed == null
      ? "Po wgraniu zdjęć dotknij kwadrat na źródle, potem osobę na celu."
      : `Wybrana twarz ${armed + 1}. Dotknij osobę na celu, żeby ją przypisać. Par: ${count}.`;
}

function refresh() {
  const count = assign.filter((value) => value >= 0).length;
  const ready = Boolean(source && target && els.consent.checked && (mode !== "multi" || count > 0));
  els.go.disabled = !ready;
}

els.consent.addEventListener("change", refresh);
els.zasieg.addEventListener("input", () => {
  els.zasiegValue.textContent = Number(els.zasieg.value).toFixed(1);
});
els.token.addEventListener("change", () => {
  const value = els.token.value.trim();
  if (value) localStorage.setItem(TOKEN_KEY, value);
  else localStorage.removeItem(TOKEN_KEY);
});
$("#tab-single").addEventListener("click", () => setMode("single"));
$("#tab-multi").addEventListener("click", () => setMode("multi"));
$("#tab-head").addEventListener("click", () => setMode("head"));

els.go.addEventListener("click", async () => {
  if (!source || !target || els.go.disabled) return;
  abortCtrl = new AbortController();
  els.go.classList.add("hidden");
  els.progressWrap.classList.remove("hidden");
  els.error.classList.add("hidden");
  try {
    const pairs = assign.flatMap((sourceIndex, targetIndex) =>
      sourceIndex >= 0 ? [{ sourceIndex, targetIndex }] : [],
    );
    const result = await runFaceSwap({
      mode,
      sources: [source],
      target,
      pairs,
      sourceIndex: mode === "head" ? headSource : undefined,
      targetIndex: mode === "head" ? headTarget : undefined,
      expandRatio: Number(els.zasieg.value),
      token: els.token.value.trim() || HF_TOKEN,
      config: { ...CONFIG, hfSpaceId: els.space.value.trim() || CONFIG.hfSpaceId },
      signal: abortCtrl.signal,
      onProgress: (percent, label) => {
        els.progressBar.style.width = `${percent}%`;
        els.progressLabel.textContent = label;
      },
    });
    resultBlob = result.blob;
    els.result.src = URL.createObjectURL(result.blob);
    els.result.classList.remove("hidden");
    els.resultEmpty.classList.add("hidden");
    els.download.disabled = false;
    const size = `${result.width}×${result.height} px`;
    els.resultMeta.textContent = mode === "head" ? `Głowa · ${size}` : `${result.swapped} · ${size}`;
    document.querySelector("#wynik")?.scrollIntoView({ behavior: "smooth", block: "start" });
  } catch (error) {
    if (!(error instanceof DOMException && error.name === "AbortError")) {
      els.error.textContent = error instanceof Error ? error.message : "Nie udało się podmienić twarzy.";
      els.error.classList.remove("hidden");
    }
  } finally {
    els.go.classList.remove("hidden");
    els.progressWrap.classList.add("hidden");
    abortCtrl = null;
    refresh();
  }
});

els.cancel.addEventListener("click", () => abortCtrl?.abort());
els.download.addEventListener("click", () => {
  if (!resultBlob) return;
  const href = URL.createObjectURL(resultBlob);
  const link = document.createElement("a");
  link.href = href;
  link.download = "oblicze-podmiana.jpg";
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  setTimeout(() => URL.revokeObjectURL(href), 2000);
});


setMode("single");
