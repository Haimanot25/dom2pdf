import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import type { Page } from "playwright";
import { lengthToPx } from "../capture/paper.js";
import type { NormalizedOptions } from "../config/normalize.js";
import { isDom2PdfError } from "../errors/index.js";
import { raceWithAbort } from "../utils/cancellation.js";
import { withTimeout } from "../utils/async.js";
import type { QualityCheck, QualityWarning } from "./report.js";
import {
  alignByCorrelation,
  boxBlur3,
  computeSsim,
  inkProfile,
  phash,
  phashDistance,
  resizeWindow,
  toGray,
} from "./similarity.js";

/**
 * Re-rasterizes sampled pages in-browser with pdf.js and compares them against live-page
 * screenshots; failures degrade to `{ status: "skipped" }`, cancellation propagates as-is.
 */

/** Vertical alignment search range around the nominal page boundary, in CSS px. */
const ALIGN_MARGIN_PX = 128;
/** Both images are compared at this width; aspect ratio derives the height. */
const COMPARE_WIDTH = 384;
/** Bound for each Playwright/pdf.js call inside the phase. */
const PER_CALL_TIMEOUT_MS = 30_000;
/** Individual patience for images that start loading after the capture viewport resize. */
const IMAGE_SETTLE_CAP_MS = 1_000;
/** Cap on expanded `pageRanges` length; larger ranges are rejected. */
const MAX_RANGE_PAGES = 10_000;

const VERIFY_ORIGIN = "http://dom2pdf-verify.test";

/** Minimal HTML shell: loads pdf.js as a module and signals readiness. */
const VERIFY_HTML = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>dom2pdf verification</title>
</head>
<body>
<script type="module">
import * as pdfjsLib from "/pdfjs/pdf.mjs";
pdfjsLib.GlobalWorkerOptions.workerSrc = "/pdfjs/pdf.worker.mjs";
window.pdfjsLib = pdfjsLib;
window.__dom2pdfReady = true;
</script>
</body>
</html>`;

export interface FidelityPageScore {
  /** 1-based PDF page number. */
  page: number;
  /** Mean SSIM of the aligned page against its screen slice (0–1, heuristic). */
  ssim: number;
  /** pHash Hamming distance between the aligned page and its slice (0 = identical structure). */
  phashDistance: number;
  /** Vertical shift (px) that best aligned the slice to this page; 0 = nominal boundary. */
  alignmentOffsetPx: number;
  /** Ink-profile correlation at the chosen alignment (−1..1). */
  alignCorrelation: number;
}

export interface FidelityReport {
  status: "measured" | "skipped";
  /** Present when skipped: why verification could not run. */
  reason?: string;
  /** Mean SSIM across sampled pages when measured. */
  score?: number;
  /** Mean-SSIM threshold this result is meant to be judged against. */
  threshold: number;
  /** 1-based PDF pages that were verified (empty when skipped before sampling). */
  sampledPages: number[];
  /** Per-page measurements when measured. */
  pages?: FidelityPageScore[];
  /** Wall-clock time spent in the fidelity phase. */
  durationMs?: number;
}

export interface SliceGeometry {
  /** Document CSS px represented by one PDF page (print content height / scale). */
  sliceHeightCss: number;
  /** Viewport width to capture at: print content width (document mode) or the conversion viewport (screen mode). */
  captureWidthCss: number;
  /** Viewport height to capture at: slice height (document mode) or the conversion viewport (screen mode). */
  captureHeightCss: number;
  /** Content box (inside margins) in pt, used to crop the rasterized page. */
  contentBoxPt: { x: number; y: number; width: number; height: number };
  /** Raster width for pdf.js so the content box maps 1:1 onto the strip width. */
  rasterWidth: number;
}

/**
 * Derives slice geometry from the paper size measured in the produced PDF, so custom/CSS
 * sizes, landscape, and `preferCSSPageSize` are honored.
 */
export function computeSliceGeometry(input: {
  paperWidthPt: number;
  paperHeightPt: number;
  marginsPx: { top: number; right: number; bottom: number; left: number };
  scale: number;
  mode: "document" | "screen";
  viewport: { width: number; height: number };
}): SliceGeometry {
  const PT_TO_CSS_PX = 4 / 3;
  const paperWidthCss = input.paperWidthPt * PT_TO_CSS_PX;
  const paperHeightCss = input.paperHeightPt * PT_TO_CSS_PX;
  const contentWidthCss = paperWidthCss - input.marginsPx.left - input.marginsPx.right;
  const contentHeightCss = paperHeightCss - input.marginsPx.top - input.marginsPx.bottom;
  const sliceHeightCss = contentHeightCss / input.scale;
  return {
    sliceHeightCss,
    captureWidthCss:
      input.mode === "document"
        ? Math.max(1, Math.round(contentWidthCss / input.scale))
        : input.viewport.width,
    captureHeightCss:
      input.mode === "document"
        ? Math.max(1, Math.round(sliceHeightCss))
        : input.viewport.height,
    contentBoxPt: {
      x: input.marginsPx.left * 0.75,
      y: input.marginsPx.top * 0.75,
      width: contentWidthCss * 0.75,
      height: contentHeightCss * 0.75,
    },
    rasterWidth: Math.max(1, Math.round(paperWidthCss / input.scale)),
  };
}

/** Maps PDF page n to the document page it printed from (`result[n - 1]`). Returns an
 * empty array when the mapping cannot be established (Chromium drops out-of-range pages
 * silently, or the range does not cover the document 1:1). */
export function expandPageRanges(pageRanges: string | undefined, pdfPageCount: number): number[] {
  if (pageRanges === undefined) {
    return Array.from({ length: pdfPageCount }, (_value, index) => index + 1);
  }
  const pages: number[] = [];
  for (const token of pageRanges.split(",")) {
    const match = /^\s*(\d+)(?:\s*-\s*(\d+))?\s*$/.exec(token);
    if (match === null) return [];
    const from = Number.parseInt(match[1] ?? "0", 10);
    const to = match[2] === undefined ? from : Number.parseInt(match[2], 10);
    const lo = Math.min(from, to);
    const hi = Math.max(from, to);
    if (lo < 1) return [];
    for (let page = lo; page <= hi; page += 1) {
      pages.push(page);
      if (pages.length > MAX_RANGE_PAGES) return [];
    }
  }
  return pages.length === pdfPageCount ? pages : [];
}

interface ComparePageInput {
  shots: Array<{ b64: string; dy: number }>;
  stripWidth: number;
  stripHeight: number;
  pageNo: number;
  targetWidth: number;
  rasterWidth: number;
  contentBox: { x: number; y: number; width: number; height: number };
  bg: string;
  nominalRow: number;
}

interface ComparePageResult {
  ssim: number;
  phashDistance: number;
  alignmentOffsetPx: number;
  alignCorrelation: number;
}

declare global {
  interface Window {
    __dom2pdfReady?: boolean;
    __dom2pdfFidelity?: {
      loadPdf(b64: string): Promise<Array<{ width: number; height: number }>>;
      comparePage(input: ComparePageInput): Promise<ComparePageResult>;
    };
  }
}

/** In-page runtime injected as a classic script; the similarity primitives are the same
 * functions unit-tested in Node, stringified into the page (single source of truth). */
const DRIVER_SOURCE = `
async function pfDecodePng(b64) {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  const bitmap = await createImageBitmap(new Blob([bytes], { type: "image/png" }));
  const canvas = document.createElement("canvas");
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close();
  return ctx.getImageData(0, 0, canvas.width, canvas.height);
}

async function pfLoadPdf(b64) {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  const task = window.pdfjsLib.getDocument({ data: bytes, verbosity: 0 });
  const doc = await task.promise;
  window.__pfPdfDoc = doc;
  const sizes = [];
  for (let n = 1; n <= doc.numPages; n += 1) {
    const viewport = (await doc.getPage(n)).getViewport({ scale: 1 });
    sizes.push({ width: viewport.width, height: viewport.height });
  }
  return sizes;
}

async function pfComparePage(input) {
  const doc = window.__pfPdfDoc;
  if (!doc) throw new Error("fidelity: PDF is not loaded in the verification page");

  const stripCanvas = document.createElement("canvas");
  stripCanvas.width = input.stripWidth;
  stripCanvas.height = input.stripHeight;
  const stripCtx = stripCanvas.getContext("2d", { willReadFrequently: true });
  stripCtx.fillStyle = input.bg;
  stripCtx.fillRect(0, 0, input.stripWidth, input.stripHeight);
  for (const shot of input.shots) {
    stripCtx.putImageData(await pfDecodePng(shot.b64), 0, shot.dy);
  }
  const stripData = stripCtx.getImageData(0, 0, input.stripWidth, input.stripHeight);

  const page = await doc.getPage(input.pageNo);
  const natural = page.getViewport({ scale: 1 });
  const viewport = page.getViewport({ scale: input.rasterWidth / natural.width });
  const pageCanvas = document.createElement("canvas");
  pageCanvas.width = Math.round(viewport.width);
  pageCanvas.height = Math.round(viewport.height);
  const pageCtx = pageCanvas.getContext("2d", { willReadFrequently: true });
  await page.render({ canvasContext: pageCtx, viewport }).promise;

  const cb = input.contentBox;
  const cropCanvas = document.createElement("canvas");
  cropCanvas.width = Math.max(1, Math.round(cb.width));
  cropCanvas.height = Math.max(1, Math.round(cb.height));
  const cropCtx = cropCanvas.getContext("2d", { willReadFrequently: true });
  cropCtx.drawImage(pageCanvas, cb.x, cb.y, cb.width, cb.height, 0, 0, cropCanvas.width, cropCanvas.height);
  const pdfData = cropCtx.getImageData(0, 0, cropCanvas.width, cropCanvas.height);

  const gStrip = boxBlur3(toGray(stripData));
  const gPdf = boxBlur3(toGray(pdfData));
  const maxOffset = Math.max(0, input.stripHeight - gPdf.height);
  const alignment = alignByCorrelation(gPdf, gStrip, maxOffset, input.nominalRow);
  const targetHeight = Math.max(1, Math.round((input.targetWidth * gPdf.height) / gPdf.width));
  const pdfSmall = resizeWindow(gPdf, 0, gPdf.height, input.targetWidth, targetHeight);
  let best = { ssim: Number.NEGATIVE_INFINITY, offset: alignment.offset };
  for (const delta of [-4, -2, -1, 0, 1, 2, 4]) {
    const row = alignment.offset + delta;
    if (row < 0 || row > maxOffset) continue;
    const stripSmall = resizeWindow(gStrip, row, gPdf.height, input.targetWidth, targetHeight);
    const score = computeSsim(pdfSmall, stripSmall);
    if (score > best.ssim) best = { ssim: score, offset: row };
  }
  const bestStrip = resizeWindow(gStrip, best.offset, gPdf.height, input.targetWidth, targetHeight);
  return {
    ssim: Math.round(best.ssim * 10000) / 10000,
    phashDistance: phashDistance(phash(pdfSmall), phash(bestStrip)),
    alignmentOffsetPx: best.offset - input.nominalRow,
    alignCorrelation: Math.round(alignment.score * 10000) / 10000,
  };
}

window.__dom2pdfFidelity = { loadPdf: pfLoadPdf, comparePage: pfComparePage };
`;

function buildDriverSource(): string {
  return [
    toGray.toString(),
    boxBlur3.toString(),
    resizeWindow.toString(),
    computeSsim.toString(),
    inkProfile.toString(),
    alignByCorrelation.toString(),
    phash.toString(),
    phashDistance.toString(),
    DRIVER_SOURCE,
  ].join("\n");
}

const require_ = createRequire(import.meta.url);

/** Bounded wait for images kicked off by the capture-viewport resize, so screenshots do not
 * catch a half-loaded reflow. */
async function settleImages(page: Page): Promise<void> {
  await page.evaluate(async (capMs) => {
    const pending = Array.from(document.images)
      .filter((image) => !image.complete)
      .map(
        (image) =>
          new Promise<void>((resolve) => {
            const timer = setTimeout(() => resolve(), capMs);
            const done = (): void => {
              clearTimeout(timer);
              resolve();
            };
            image.addEventListener("load", done, { once: true });
            image.addEventListener("error", done, { once: true });
          }),
      );
    await Promise.all(pending);
    await Promise.race([
      document.fonts.ready,
      new Promise<void>((resolve) => setTimeout(() => resolve(), 1000)),
    ]);
  }, IMAGE_SETTLE_CAP_MS);
}

export interface MeasureFidelityInput {
  /** The converted page (still open inside the conversion context). */
  page: Page;
  /** The generated PDF. */
  bytes: Uint8Array;
  options: NormalizedOptions;
  /** Screen-mode paper-fit scale from the render metadata. */
  screenScale: number | undefined;
  signal: AbortSignal | undefined;
}

/** Never throws except on cancellation; every other failure degrades to `{ status: "skipped" }`. */
export async function measureFidelity(input: MeasureFidelityInput): Promise<FidelityReport> {
  const { page, bytes, options, signal } = input;
  const startedAt = Date.now();
  const threshold = options.fidelity.threshold;

  const skippedReport = (reason: string): FidelityReport => ({
    status: "skipped",
    reason,
    threshold,
    sampledPages: [],
    durationMs: Date.now() - startedAt,
  });

  let verify: Page | undefined;
  const originalViewport = page.viewportSize();
  let viewportChanged = false;

  try {
    if (options.pdf.displayHeaderFooter) {
      return skippedReport(
        "pdf.displayHeaderFooter adds per-page chrome (header/footer) that screen captures cannot reproduce",
      );
    }
    const scale = options.mode === "screen" ? input.screenScale : options.pdf.scale;
    if (scale === undefined || !(scale > 0)) {
      return skippedReport("the effective print scale is unknown, so page geometry cannot be derived");
    }

    const pdfjsSource = readFileSync(require_.resolve("pdfjs-dist/build/pdf.mjs"), "utf8");
    const workerSource = readFileSync(require_.resolve("pdfjs-dist/build/pdf.worker.mjs"), "utf8");

    verify = await page.context().newPage();
    await verify.route(`${VERIFY_ORIGIN}/**`, async (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path === "/pdfjs/pdf.mjs") {
        await route.fulfill({ contentType: "text/javascript", body: pdfjsSource });
      } else if (path === "/pdfjs/pdf.worker.mjs") {
        await route.fulfill({ contentType: "text/javascript", body: workerSource });
      } else if (path === "/verify.html") {
        await route.fulfill({ contentType: "text/html", body: VERIFY_HTML });
      } else {
        await route.fulfill({ status: 404, contentType: "text/plain", body: "not found" });
      }
    });
    await verify.goto(`${VERIFY_ORIGIN}/verify.html`);
    await verify.waitForFunction(() => window.__dom2pdfReady === true, null, {
      timeout: PER_CALL_TIMEOUT_MS,
    });
    await verify.addScriptTag({ content: buildDriverSource() });

    const pdfB64 = Buffer.from(bytes).toString("base64");
    const sizes = await withTimeout(
      raceWithAbort(
        verify.evaluate((b64) => {
          const runtime = window.__dom2pdfFidelity;
          if (runtime === undefined) throw new Error("fidelity runtime did not load");
          return runtime.loadPdf(b64);
        }, pdfB64),
        signal,
      ),
      PER_CALL_TIMEOUT_MS,
      () => new Error(`pdf.js did not finish loading the PDF within ${PER_CALL_TIMEOUT_MS}ms`),
    );

    const paper = sizes[0];
    if (paper === undefined) {
      return skippedReport("the generated PDF has no pages");
    }
    if (sizes.some((size) => size.width !== paper.width || size.height !== paper.height)) {
      return skippedReport("the PDF has pages of differing sizes, which cannot be mapped onto one slice height");
    }

    const margin = options.pdf.margin;
    const marginsPx = {
      top: margin?.top !== undefined ? lengthToPx(margin.top) : 0,
      right: margin?.right !== undefined ? lengthToPx(margin.right) : 0,
      bottom: margin?.bottom !== undefined ? lengthToPx(margin.bottom) : 0,
      left: margin?.left !== undefined ? lengthToPx(margin.left) : 0,
    };
    const geometry = computeSliceGeometry({
      paperWidthPt: paper.width,
      paperHeightPt: paper.height,
      marginsPx,
      scale,
      mode: options.mode,
      viewport: options.viewport,
    });
    if (!(geometry.sliceHeightCss > 0) || !(geometry.contentBoxPt.width > 0) || !(geometry.contentBoxPt.height > 0)) {
      return skippedReport("the configured margins leave no printable content area on the paper");
    }

    const documentPages = expandPageRanges(options.pdf.pageRanges, sizes.length);
    if (documentPages.length !== sizes.length) {
      return skippedReport(
        "pdf.pageRanges cannot be mapped onto the document flow (out-of-range or oversized ranges)",
      );
    }

    const sampleCount =
      options.fidelity.samplePages === "all"
        ? sizes.length
        : Math.min(options.fidelity.samplePages, sizes.length);
    const sampledPages: number[] = [];
    for (let page = 1; page <= sampleCount; page += 1) sampledPages.push(page);

    // Capture at the print layout width so live layout matches what `page.pdf()` printed;
    // screen mode keeps the conversion viewport (its PDF is the screen layout, scaled).
    const captureViewport = { width: geometry.captureWidthCss, height: geometry.captureHeightCss };
    if (
      originalViewport !== null &&
      (originalViewport.width !== captureViewport.width || originalViewport.height !== captureViewport.height)
    ) {
      await raceWithAbort(page.setViewportSize(captureViewport), signal);
      viewportChanged = true;
      await raceWithAbort(settleImages(page), signal);
    }

    const probe = await raceWithAbort(
      page.evaluate(() => {
        const root = document.documentElement;
        const body = document.body;
        const pick = (element: Element | null): string | null => {
          if (element === null) return null;
          const color = getComputedStyle(element).backgroundColor;
          return color !== "" && color !== "transparent" && color !== "rgba(0, 0, 0, 0)" ? color : null;
        };
        return {
          scrollHeight: Math.max(root.scrollHeight, body === null ? 0 : body.scrollHeight),
          background: pick(root) ?? pick(body) ?? "rgb(255, 255, 255)",
        };
      }),
      signal,
    );
    const maxScroll = Math.max(0, probe.scrollHeight - captureViewport.height);

    const stripHeight = Math.ceil(geometry.sliceHeightCss) + 2 * ALIGN_MARGIN_PX;
    const rasterScale = geometry.rasterWidth / paper.width;
    const pages: FidelityPageScore[] = [];

    for (const pageNo of sampledPages) {
      const documentPage = documentPages[pageNo - 1] ?? 1;
      const sliceTopCss = (documentPage - 1) * geometry.sliceHeightCss;
      const stripOriginCss = sliceTopCss - ALIGN_MARGIN_PX;
      const shots: Array<{ b64: string; dy: number }> = [];
      let previousScroll = -1;
      for (
        let target = stripOriginCss;
        target < stripOriginCss + stripHeight;
        target += captureViewport.height
      ) {
        // Rows outside the document stay background-filled, matching the PDF's page tail.
        const scroll = Math.round(Math.min(Math.max(target, 0), maxScroll));
        if (scroll === previousScroll) continue;
        previousScroll = scroll;
        await raceWithAbort(
          page.evaluate(
            (top) =>
              new Promise<void>((resolve) => {
                window.scrollTo(0, top);
                requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
              }),
            scroll,
          ),
          signal,
        );
        const png = await raceWithAbort(page.screenshot(), signal);
        shots.push({ b64: png.toString("base64"), dy: Math.round(scroll - stripOriginCss) });
      }

      const comparison = await withTimeout(
        raceWithAbort(
          verify.evaluate((pageInput) => {
            const runtime = window.__dom2pdfFidelity;
            if (runtime === undefined) throw new Error("fidelity runtime did not load");
            return runtime.comparePage(pageInput);
          }, {
            shots,
            stripWidth: captureViewport.width,
            stripHeight,
            pageNo,
            targetWidth: COMPARE_WIDTH,
            rasterWidth: geometry.rasterWidth,
            contentBox: {
              x: geometry.contentBoxPt.x * rasterScale,
              y: geometry.contentBoxPt.y * rasterScale,
              width: geometry.contentBoxPt.width * rasterScale,
              height: geometry.contentBoxPt.height * rasterScale,
            },
            bg: probe.background,
            nominalRow: ALIGN_MARGIN_PX,
          } satisfies ComparePageInput),
          signal,
        ),
        PER_CALL_TIMEOUT_MS,
        () => new Error(`page ${pageNo} comparison exceeded ${PER_CALL_TIMEOUT_MS}ms`),
      );
      pages.push({ page: pageNo, ...comparison });
    }

    const score =
      Math.round((pages.reduce((sum, entry) => sum + entry.ssim, 0) / Math.max(1, pages.length)) * 10000) /
      10000;
    return {
      status: "measured",
      score,
      threshold,
      sampledPages,
      pages,
      durationMs: Date.now() - startedAt,
    };
  } catch (cause) {
    // Cancellation is a conversion-level outcome, not a fidelity skip.
    if (isDom2PdfError(cause) && cause.code === "CANCELLED") throw cause;
    return skippedReport(
      `verification infrastructure failed: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  } finally {
    if (verify !== undefined) {
      try {
        await verify.close();
      } catch {
        // The context may already be tearing down; nothing left to clean up.
      }
    }
    if (viewportChanged && originalViewport !== null) {
      try {
        await page.setViewportSize(originalViewport);
      } catch {
        // The converted page may already be closing; the result is unaffected.
      }
    }
  }
}

function previewPages(pages: string[]): string {
  const shown = pages.slice(0, 3).join(", ");
  return pages.length > 3 ? `${shown}, … (${pages.length} total)` : shown;
}

export function fidelityDiagnostics(fidelity: FidelityReport): {
  check: QualityCheck;
  warnings: QualityWarning[];
} {
  if (fidelity.status === "skipped") {
    const reason = fidelity.reason ?? "unknown reason";
    return {
      check: {
        id: "render.fidelity",
        status: "skipped",
        detail: `visual comparison did not run: ${reason}`,
      },
      warnings: [
        {
          code: "fidelity.skipped",
          source: "heuristic",
          message: `Render-fidelity verification was skipped: ${reason}`,
        },
      ],
    };
  }

  const score = fidelity.score ?? 0;
  const pages = fidelity.pages ?? [];
  const below = pages.filter((page) => page.ssim < fidelity.threshold);
  const worst = pages.reduce<FidelityPageScore | null>(
    (accumulator, page) => (accumulator === null || page.ssim < accumulator.ssim ? page : accumulator),
    null,
  );
  const detail =
    `mean SSIM ${score.toFixed(3)} across ${pages.length} sampled page(s) ` +
    `(worst: page ${worst === null ? "?" : `${worst.page} at ${worst.ssim.toFixed(3)}`}; threshold ${fidelity.threshold.toFixed(3)})`;

  if (score >= fidelity.threshold) {
    return { check: { id: "render.fidelity", status: "pass", detail }, warnings: [] };
  }
  return {
    check: {
      id: "render.fidelity",
      status: "warn",
      detail: `${detail} — below threshold`,
      recommendation:
        "Review the PDF for content that differs from the page (print-only CSS, pagination moving blocks, media that failed to rasterize). If the difference is expected, tune fidelity.threshold or disable fidelity.",
    },
    warnings: [
      {
        code: "fidelity.low-score",
        source: "heuristic",
        message:
          below.length > 0
            ? `page(s) ${previewPages(below.map((page) => String(page.page)))} scored below the fidelity threshold ${fidelity.threshold.toFixed(3)} (visual heuristic, not a pixel-perfectness claim)`
            : `mean visual similarity ${score.toFixed(3)} is below the fidelity threshold ${fidelity.threshold.toFixed(3)} (visual heuristic, not a pixel-perfectness claim)`,
      },
    ],
  };
}
