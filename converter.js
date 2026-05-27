/* global FFmpegWASM, FFmpegUtil */
// Thin wrapper around ffmpeg.wasm that builds GIF commands from a structured
// options object. The UI layer (app.js) is responsible for collecting options
// and rendering progress; this file owns ffmpeg interaction.

const FFMPEG_CORE_BASE = "https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.10/dist/umd";

class GifConverter {
  constructor() {
    this.ffmpeg = null;
    this.loaded = false;
    this.handlers = { log: () => {}, progress: () => {} };
  }

  on(event, handler) {
    this.handlers[event] = handler;
  }

  async load() {
    if (this.loaded) return;

    const { FFmpeg } = FFmpegWASM;
    const { toBlobURL } = FFmpegUtil;

    this.ffmpeg = new FFmpeg();
    this.ffmpeg.on("log", ({ message }) => this.handlers.log(message));
    this.ffmpeg.on("progress", ({ progress, time }) =>
      this.handlers.progress({ progress, time }),
    );

    // The worker (vendored ffmpeg.js → 814.ffmpeg.js) is same-origin, so it
    // can `importScripts` the CORS-enabled CDN core/wasm directly.
    await this.ffmpeg.load({
      coreURL: `${FFMPEG_CORE_BASE}/ffmpeg-core.js`,
      wasmURL: `${FFMPEG_CORE_BASE}/ffmpeg-core.wasm`,
    });

    this.loaded = true;
  }

  // Aborts the current exec. ffmpeg.terminate() destroys the worker, so we
  // null out the instance and require a fresh load() for the next run.
  async cancel() {
    if (!this.ffmpeg) return;
    try {
      await this.ffmpeg.terminate();
    } catch (_) {
      /* ignore */
    }
    this.ffmpeg = null;
    this.loaded = false;
  }

  /**
   * Convert a video File to a GIF.
   * @param {File} file
   * @param {object} opts
   * @param {number} opts.width            Output width in px (height auto).
   * @param {number} opts.fps              Frames per second.
   * @param {"low"|"medium"|"high"} opts.quality
   * @param {string} opts.dither           ffmpeg paletteuse dither name, or "none".
   * @param {number} opts.start            Trim start in seconds.
   * @param {number|null} opts.duration    Trim duration in seconds; null = full.
   * @param {number} opts.loop             0 = forever, -1 = no loop, N = loop N times.
   * @param {number} opts.colors           Max palette colors (≤ 256).
   * @returns {Promise<{blob: Blob, size: number, durationMs: number}>}
   */
  async convert(file, opts) {
    if (!this.loaded) throw new Error("ffmpeg not loaded — call load() first");

    const started = performance.now();
    const inputName = "input" + extFromName(file.name);
    const outputName = "output.gif";
    const paletteName = "palette.png";

    const { fetchFile } = FFmpegUtil;
    await this.ffmpeg.writeFile(inputName, await fetchFile(file));

    const trim = trimArgs(opts.start, opts.duration);
    const vf = videoFilter(opts);

    if (opts.quality === "high") {
      // Two-pass: build a palette tuned to this clip, then encode with it.
      await this.ffmpeg.exec([
        ...trim,
        "-i", inputName,
        "-vf", `${vf},palettegen=max_colors=${opts.colors}:stats_mode=diff`,
        "-y", paletteName,
      ]);

      const dither = opts.dither === "none" ? "none" : opts.dither;
      await this.ffmpeg.exec([
        ...trim,
        "-i", inputName,
        "-i", paletteName,
        "-filter_complex", `${vf}[x];[x][1:v]paletteuse=dither=${dither}`,
        "-loop", String(opts.loop),
        "-y", outputName,
      ]);
    } else {
      // Single-pass: faster, larger file, fewer colors.
      await this.ffmpeg.exec([
        ...trim,
        "-i", inputName,
        "-vf", vf,
        "-loop", String(opts.loop),
        "-y", outputName,
      ]);
    }

    const data = await this.ffmpeg.readFile(outputName);
    const blob = new Blob([data.buffer], { type: "image/gif" });

    // Clean up the virtual FS so repeated runs don't accumulate.
    await safeUnlink(this.ffmpeg, inputName);
    await safeUnlink(this.ffmpeg, outputName);
    await safeUnlink(this.ffmpeg, paletteName);

    return {
      blob,
      size: blob.size,
      durationMs: performance.now() - started,
    };
  }
}

function trimArgs(start, duration) {
  const args = [];
  if (start && start > 0) args.push("-ss", String(start));
  if (duration && duration > 0) args.push("-t", String(duration));
  return args;
}

function videoFilter({ fps, width, quality }) {
  // lanczos looks notably better than bilinear for downscaling, but costs
  // more CPU. "low" quality uses the default scaler for speed.
  const flags = quality === "low" ? "bilinear" : "lanczos";
  return `fps=${fps},scale=${width}:-1:flags=${flags}`;
}

function extFromName(name) {
  const i = name.lastIndexOf(".");
  return i >= 0 ? name.slice(i) : ".mp4";
}

async function safeUnlink(ffmpeg, name) {
  try {
    await ffmpeg.deleteFile(name);
  } catch (_) {
    /* file may not exist; ignore */
  }
}

window.GifConverter = GifConverter;
