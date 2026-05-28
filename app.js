/* global GifConverter */
// UI controller: wires the stages (load → pick → convert → result) and
// delegates ffmpeg work to GifConverter.

const $ = (id) => document.getElementById(id);

const stages = {
  pick: $("stage-pick"),
  convert: $("stage-convert"),
  result: $("stage-result"),
};

const els = {
  dropzone: $("dropzone"),
  fileInput: $("file-input"),
  sourcePreview: $("source-preview"),
  sourceMeta: $("source-meta"),
  btnReset: $("btn-reset"),
  options: $("options"),
  estimate: $("estimate"),
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
  source: null, // { width, height, duration } populated when a file is loaded
  // Measured bytes-per-pixel for the current file, set by a single
  // long-window calibration after upload. Null while calibrating or on
  // failure (we fall back to formula constants in that case).
  contentBpp: null,
  calibrating: false,
  calibrationPromise: null,
};

state.converter.on("log", (msg) => {
  els.log.textContent += msg + "\n";
  els.log.scrollTop = els.log.scrollHeight;
});
state.converter.on("progress", ({ progress }) => {
  if (progress >= 0 && progress <= 1) setProgress(progress);
});

// Kick off the ffmpeg core download immediately so it's usually ready by the
// time the user picks a file. Errors are recorded for the convert handler to
// surface — we don't block the dropzone on this.
state.converter.load().catch((err) => {
  state.loadError = err;
});

// -- Stage 1: pick a file ---------------------------------------------------

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
  state.contentBpp = null;
  const url = URL.createObjectURL(file);
  els.sourcePreview.src = url;
  els.sourcePreview.onloadedmetadata = () => {
    state.source = {
      width: els.sourcePreview.videoWidth,
      height: els.sourcePreview.videoHeight,
      duration: isFinite(els.sourcePreview.duration)
        ? els.sourcePreview.duration
        : null,
    };
    els.sourceMeta.innerHTML = renderMeta({
      Name: file.name,
      Size: formatBytes(file.size),
      Type: file.type || "video",
      Duration: state.source.duration
        ? state.source.duration.toFixed(2) + " s"
        : "unknown",
      Dimensions: `${state.source.width} × ${state.source.height}`,
    });
    updateEstimate();
    // Kick off a tiny convert in the background to measure how compressible
    // this specific content is. Errors are non-fatal — we just fall back to
    // the formula constants.
    state.calibrationPromise = calibrateContent(file).catch((err) => {
      console.warn("calibration failed:", err);
    });
  };
  show("convert");
}

// Calibration width cap. We want to sample near the user's actual output
// width because per-pixel bpp varies with resolution for dithered/animated
// content (smaller frames have less LZW context, so bpp is ~30–40% higher
// at 320 px than at 1080 px for the same content). Cap at 1080 to keep
// calibration time bounded for huge output requests.
const CALIBRATION_MAX_WIDTH = 1080;

async function calibrateContent(file) {
  if (!state.source) return;
  state.calibrating = true;
  updateEstimate();

  // Wait for ffmpeg to finish its background load before sampling.
  if (!state.converter.loaded) await state.converter.load();

  // Sample at the user's *actual* settings — fps, quality, dither, and
  // palette colors all materially affect bpp. Quality is the biggest
  // factor: high (palettegen + paletteuse + dither) can produce ~4× the
  // bytes per pixel of medium for static/screen content. Width is capped
  // for speed; bpp scales approximately linearly with pixels.
  const opts = readOptions();
  const sampleWidth = Math.min(opts.width || 480, CALIBRATION_MAX_WIDTH);
  const sampleFps = opts.fps || 15;

  // Single long sample from the middle of the video. Short samples
  // overestimate bpp because (a) the GIF's first frame is fully encoded
  // and (b) ffmpeg's encoder seems to extract more compression efficiency
  // from longer streams (better palettes, frame-similarity detection). We
  // sample as much as 8 s when resolution allows, capped by a 50 M
  // pixel-frame budget that keeps calibration under ~5 s at any size.
  const sourceDur = state.source.duration || 4.0;
  const sampleHeight = Math.round(
    sampleWidth * state.source.height / state.source.width,
  );
  const budgetDuration =
    50_000_000 / (sampleWidth * sampleHeight * sampleFps);
  const sampleDuration = Math.min(
    sourceDur,
    Math.max(2.0, Math.min(8.0, budgetDuration)),
  );
  const sampleStart = Math.max(0, (sourceDur - sampleDuration) / 2);

  try {
    const sampleFrames = Math.max(1, Math.round(sampleFps * sampleDuration));
    const result = await state.converter.convert(file, {
      width: sampleWidth,
      fps: sampleFps,
      quality: opts.quality,
      dither: opts.dither,
      start: sampleStart,
      duration: sampleDuration,
      loop: 0,
      colors: opts.colors,
    });
    state.contentBpp =
      result.size / (sampleWidth * sampleHeight * sampleFrames);
    state.calibrationSettings = {
      width: sampleWidth,
      fps: sampleFps,
      quality: opts.quality,
      dither: opts.dither,
      colors: opts.colors,
    };
  } finally {
    state.calibrating = false;
    updateEstimate();
  }
}

// Debounced recalibration when any option that affects bpp changes. Width
// and fps change pixel/frame counts directly; quality, dither, and colors
// each change the per-pixel byte cost.
let recalibrationTimer = null;
function scheduleRecalibration() {
  clearTimeout(recalibrationTimer);
  recalibrationTimer = setTimeout(async () => {
    if (!state.currentFile) return;
    // If the initial calibration is still in flight, wait for it before
    // deciding whether to recalibrate — otherwise we'd compare against
    // a null `calibrationSettings` and silently skip.
    if (state.calibrationPromise) {
      try {
        await state.calibrationPromise;
      } catch (_) {
        /* non-fatal */
      }
    }
    if (!state.calibrationSettings) return;
    const opts = readOptions();
    const newSampleWidth = Math.min(opts.width || 480, CALIBRATION_MAX_WIDTH);
    const last = state.calibrationSettings;
    const changed =
      newSampleWidth !== last.width ||
      opts.fps !== last.fps ||
      opts.quality !== last.quality ||
      opts.dither !== last.dither ||
      opts.colors !== last.colors;
    if (changed) {
      state.calibrationPromise = calibrateContent(state.currentFile).catch(
        (err) => console.warn("recalibration failed:", err),
      );
    }
  }, 800);
}

els.btnReset.addEventListener("click", () => {
  resetSource();
  show("pick");
});

// Recompute the size estimate whenever any option changes; if width or fps
// changes meaningfully, also kick off a fresh calibration in the background.
els.options.addEventListener("input", onOptionChange);
els.options.addEventListener("change", onOptionChange);

function onOptionChange() {
  updateEstimate();
  scheduleRecalibration();
}

/**
 * GIF size estimate based on width × height × frames × bytes/pixel.
 * When we've measured a calibration bpp for this file, we use that directly
 * (much more accurate). Otherwise we fall back to content-agnostic constants
 * that assume photo-realistic content — these can be 20× off for screen
 * recordings or cartoon-like material.
 */
function estimateGifBytes(source, opts, contentBpp) {
  if (!source) return null;
  const aspect = source.height / source.width;
  const outW = Math.max(1, opts.width);
  const outH = Math.max(1, Math.round(outW * aspect));
  const clipDuration =
    opts.duration && opts.duration > 0
      ? Math.min(opts.duration, (source.duration ?? Infinity) - opts.start)
      : (source.duration ?? 0) - opts.start;
  if (clipDuration <= 0) return null;
  const frames = Math.max(1, Math.round(opts.fps * clipDuration));

  // When we have a calibrated bpp, it was measured at the user's actual
  // quality/dither/colors — no additional factors needed.
  if (contentBpp != null) {
    const bytes = outW * outH * frames * contentBpp;
    return { bytes, outW, outH, frames };
  }

  // Fallback used in the brief window before calibration completes.
  const baseBpp =
    opts.quality === "high" ? 0.40 : opts.quality === "low" ? 0.32 : 0.45;
  const ditherFactor = opts.dither && opts.dither !== "none" ? 1.10 : 1.0;
  const paletteFactor =
    opts.colors >= 256 ? 1.0 : opts.colors >= 128 ? 0.93 : 0.85;
  const bytes = outW * outH * frames * baseBpp * ditherFactor * paletteFactor;
  return { bytes, outW, outH, frames };
}

function updateEstimate() {
  if (!state.source) {
    els.estimate.innerHTML = "Estimated output: —";
    return;
  }
  const opts = readOptions();
  const est = estimateGifBytes(state.source, opts, state.contentBpp);
  if (!est) {
    els.estimate.innerHTML = "Estimated output: —";
    return;
  }

  const dimsStr = `${est.outW}×${est.outH}, ${est.frames} frames`;

  // While calibrating with no measurement yet, the formula-based fallback
  // can be very wrong — better to hide it and explain what's happening.
  if (state.contentBpp == null) {
    if (state.calibrating) {
      els.estimate.innerHTML =
        `<span class="muted">Calibrating estimated output size…</span> · ${dimsStr}`;
    } else {
      els.estimate.innerHTML = `Estimated output: — · ${dimsStr}`;
    }
    return;
  }

  // ±20 % range covers residual calibration error — empirically, long-
  // sample calibration still tends to slightly overestimate because
  // ffmpeg extracts more compression from a 440-frame stream than from
  // even a 120-frame sample.
  const lowBytes = est.bytes * 0.8;
  const highBytes = est.bytes * 1.2;
  const sizeStr = `<strong>${formatBytes(lowBytes)} – ${formatBytes(highBytes)}</strong>`;
  const suffix = state.calibrating
    ? ' <span class="muted">(updating…)</span>'
    : "";
  els.estimate.innerHTML = `Estimated output: ${sizeStr} · ${dimsStr}${suffix}`;
}

// -- Stage 2: convert -------------------------------------------------------

els.btnConvert.addEventListener("click", async () => {
  if (!state.currentFile) return;
  if (state.loadError) {
    els.progressText.textContent = "Converter failed to load: " + state.loadError.message;
    els.progress.classList.remove("hidden");
    return;
  }
  const opts = readOptions();
  startProgress();
  els.btnConvert.disabled = true;
  els.btnCancel.classList.remove("hidden");
  try {
    // If the background load() is still running, this awaits it.
    if (!state.converter.loaded) {
      els.progressText.textContent = "Preparing converter (~31 MB)…";
      await state.converter.load();
    }
    // Calibration shares the single ffmpeg worker — wait for it to finish
    // so the real convert can run cleanly. Adds at most ~1s.
    if (state.calibrationPromise) {
      els.progressText.textContent = "Finishing calibration…";
      try {
        await state.calibrationPromise;
      } catch (_) {
        /* non-fatal */
      }
    }
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

// -- Stage 3: result --------------------------------------------------------

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
  state.source = null;
  state.contentBpp = null;
  state.calibrating = false;
  state.calibrationPromise = null;
  state.calibrationSettings = null;
  if (els.sourcePreview.src) URL.revokeObjectURL(els.sourcePreview.src);
  els.sourcePreview.removeAttribute("src");
  els.fileInput.value = "";
  els.progress.classList.add("hidden");
  els.log.textContent = "";
  els.estimate.innerHTML = "Estimated output: —";
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
