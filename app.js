/* global GifConverter */
// UI controller: wires the stages (load → pick → convert → result) and
// delegates ffmpeg work to GifConverter.

const $ = (id) => document.getElementById(id);

const stages = {
  load: $("stage-load"),
  pick: $("stage-pick"),
  convert: $("stage-convert"),
  result: $("stage-result"),
};

const els = {
  btnLoad: $("btn-load"),
  loadStatus: $("load-status"),
  dropzone: $("dropzone"),
  fileInput: $("file-input"),
  sourcePreview: $("source-preview"),
  sourceMeta: $("source-meta"),
  btnReset: $("btn-reset"),
  options: $("options"),
  btnConvert: $("btn-convert"),
  btnCancel: $("btn-cancel"),
  progress: $("progress"),
  progressFill: $("progress-fill"),
  progressText: $("progress-text"),
  resultImg: $("result-img"),
  resultMeta: $("result-meta"),
  btnDownload: $("btn-download"),
  btnAgain: $("btn-again"),
  log: $("log"),
};

const state = {
  converter: new GifConverter(),
  currentFile: null,
  currentResultUrl: null,
};

state.converter.on("log", (msg) => {
  els.log.textContent += msg + "\n";
  els.log.scrollTop = els.log.scrollHeight;
});
state.converter.on("progress", ({ progress }) => {
  if (progress >= 0 && progress <= 1) setProgress(progress);
});

// -- Stage 1: load ffmpeg ---------------------------------------------------

els.btnLoad.addEventListener("click", async () => {
  els.btnLoad.disabled = true;
  els.loadStatus.textContent = "Downloading ffmpeg core…";
  try {
    await state.converter.load();
    show("pick");
  } catch (err) {
    els.loadStatus.textContent = "Failed to load: " + err.message;
    els.btnLoad.disabled = false;
  }
});

// -- Stage 2: pick a file ---------------------------------------------------

els.fileInput.addEventListener("change", (e) => {
  const file = e.target.files && e.target.files[0];
  if (file) selectFile(file);
});

els.dropzone.addEventListener("dragover", (e) => {
  e.preventDefault();
  els.dropzone.classList.add("is-drag");
});
els.dropzone.addEventListener("dragleave", () => {
  els.dropzone.classList.remove("is-drag");
});
els.dropzone.addEventListener("drop", (e) => {
  e.preventDefault();
  els.dropzone.classList.remove("is-drag");
  const file = e.dataTransfer.files && e.dataTransfer.files[0];
  if (file && file.type.startsWith("video/")) selectFile(file);
});

function selectFile(file) {
  state.currentFile = file;
  const url = URL.createObjectURL(file);
  els.sourcePreview.src = url;
  els.sourcePreview.onloadedmetadata = () => {
    els.sourceMeta.innerHTML = renderMeta({
      Name: file.name,
      Size: formatBytes(file.size),
      Type: file.type || "video",
      Duration: isFinite(els.sourcePreview.duration)
        ? els.sourcePreview.duration.toFixed(2) + " s"
        : "unknown",
      Dimensions: `${els.sourcePreview.videoWidth} × ${els.sourcePreview.videoHeight}`,
    });
  };
  show("convert");
}

els.btnReset.addEventListener("click", () => {
  resetSource();
  show("pick");
});

// -- Stage 3: convert -------------------------------------------------------

els.btnConvert.addEventListener("click", async () => {
  if (!state.currentFile) return;
  const opts = readOptions();
  startProgress();
  els.btnConvert.disabled = true;
  els.btnCancel.classList.remove("hidden");
  try {
    const result = await state.converter.convert(state.currentFile, opts);
    showResult(result);
  } catch (err) {
    els.progressText.textContent = "Error: " + err.message;
  } finally {
    els.btnConvert.disabled = false;
    els.btnCancel.classList.add("hidden");
  }
});

els.btnCancel.addEventListener("click", async () => {
  els.progressText.textContent = "Cancelling…";
  await state.converter.cancel();
  // After terminate(), the worker is gone — reload it for the next run.
  await state.converter.load();
  els.progress.classList.add("hidden");
  els.btnConvert.disabled = false;
  els.btnCancel.classList.add("hidden");
});

function readOptions() {
  const f = new FormData(els.options);
  const num = (key, fallback) => {
    const v = f.get(key);
    return v === null || v === "" ? fallback : Number(v);
  };
  return {
    width: num("width", 480),
    fps: num("fps", 15),
    quality: f.get("quality") || "medium",
    dither: f.get("dither") || "sierra2_4a",
    start: num("start", 0),
    duration: num("duration", null),
    loop: num("loop", 0),
    colors: num("colors", 256),
  };
}

function startProgress() {
  els.progress.classList.remove("hidden");
  setProgress(0);
  els.progressText.textContent = "Working…";
}

function setProgress(p) {
  const pct = Math.max(0, Math.min(100, p * 100));
  els.progressFill.style.width = pct.toFixed(1) + "%";
  els.progressText.textContent = pct.toFixed(0) + "%";
}

// -- Stage 4: result --------------------------------------------------------

function showResult({ blob, size, durationMs }) {
  if (state.currentResultUrl) URL.revokeObjectURL(state.currentResultUrl);
  state.currentResultUrl = URL.createObjectURL(blob);
  els.resultImg.src = state.currentResultUrl;
  els.btnDownload.href = state.currentResultUrl;
  els.btnDownload.download = suggestFilename(state.currentFile.name);
  els.resultMeta.innerHTML = renderMeta({
    Size: formatBytes(size),
    "Conversion time": (durationMs / 1000).toFixed(2) + " s",
  });
  show("result");
}

els.btnAgain.addEventListener("click", () => {
  resetSource();
  show("pick");
});

// -- Helpers ---------------------------------------------------------------

function show(stageName) {
  for (const [name, el] of Object.entries(stages)) {
    el.classList.toggle("hidden", name !== stageName);
  }
}

function resetSource() {
  state.currentFile = null;
  if (els.sourcePreview.src) URL.revokeObjectURL(els.sourcePreview.src);
  els.sourcePreview.removeAttribute("src");
  els.fileInput.value = "";
  els.progress.classList.add("hidden");
  els.log.textContent = "";
}

function renderMeta(obj) {
  return Object.entries(obj)
    .map(([k, v]) => `<dt>${escapeHtml(k)}</dt><dd>${escapeHtml(String(v))}</dd>`)
    .join("");
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[c]);
}

function formatBytes(n) {
  if (n < 1024) return n + " B";
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + " KB";
  return (n / 1024 / 1024).toFixed(2) + " MB";
}

function suggestFilename(srcName) {
  const base = srcName.replace(/\.[^.]+$/, "");
  return `${base || "output"}.gif`;
}
