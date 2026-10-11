import type { NormalizedPdfOptions, NormalizedViewport } from "../config/normalize.js";
import type { PaperFormat } from "../config/schema.js";
import { PageForgeError } from "../errors/index.js";

/**
 * Paper-fit computation for screen mode.
 *
 * All paper sizes are CSS pixels at the 96dpi reference (the same basis
 * Chromium uses for `px`), derived from their millimeter/inch definitions.
 */

const MM_TO_PX = 96 / 25.4;

/** [widthMm, heightMm]; US formats are given in mm (1in = 25.4mm). */
const PAPER_SIZES_MM: Record<PaperFormat, readonly [number, number]> = {
  A0: [841, 1189],
  A1: [594, 841],
  A2: [420, 594],
  A3: [297, 420],
  A4: [210, 297],
  A5: [148, 210],
  A6: [105, 148],
  Letter: [215.9, 279.4],
  Legal: [215.9, 355.6],
  Tabloid: [279.4, 431.8],
  Ledger: [431.8, 279.4],
};

/** Chromium's default paper width/height when only one dimension is given (Letter). */
const FALLBACK_PAPER_WIDTH_PX = 8.5 * 96;
const FALLBACK_PAPER_HEIGHT_PX = 11 * 96;

/** Parses a validated length (number = px, or px/in/cm/mm string) to CSS pixels. */
export function lengthToPx(value: string | number): number {
  if (typeof value === "number") return value;
  const match = /^\s*(\d+(?:\.\d+)?)\s*(px|in|cm|mm)?\s*$/i.exec(value);
  if (match === null) {
    throw new PageForgeError({
      code: "INVALID_INPUT",
      message: `Unsupported length "${value}"; use a number (px) or a string with units px, in, cm, or mm`,
      details: { value },
    });
  }
  const amount = Number.parseFloat(match[1] ?? "0");
  switch ((match[2] ?? "px").toLowerCase()) {
    case "in":
      return amount * 96;
    case "cm":
      return amount * MM_TO_PX * 10;
    case "mm":
      return amount * MM_TO_PX;
    default:
      return amount;
  }
}

export interface PaperFit {
  /** Effective render scale for `page.pdf()` (0.1 … 1: never upscales). */
  scale: number;
  /** Paper width in CSS px after orientation. */
  paperWidthPx: number;
  /** Paper height in CSS px after orientation (may be a Letter-based fallback). */
  paperHeightPx: number;
  /** Content width available after margins, in CSS px. */
  contentWidthPx: number;
  /** Human-readable paper description for diagnostics, e.g. `A4`. */
  paperLabel: string;
}

/**
 * Computes the `paper-fit` scale: the viewport width (plus margins) is scaled
 * exactly onto the paper's content width. Content narrower than the paper is
 * never enlarged past 100%.
 */
export function computePaperFit(pdf: NormalizedPdfOptions, viewport: NormalizedViewport): PaperFit {
  let widthPx: number;
  let heightPx: number;
  let label: string;

  if (pdf.width !== undefined || pdf.height !== undefined) {
    widthPx = pdf.width !== undefined ? lengthToPx(pdf.width) : FALLBACK_PAPER_WIDTH_PX;
    heightPx = pdf.height !== undefined ? lengthToPx(pdf.height) : FALLBACK_PAPER_HEIGHT_PX;
    label = `${Math.round(widthPx)}×${Math.round(heightPx)}px`;
  } else {
    const format: PaperFormat = pdf.format ?? "A4";
    const mm = PAPER_SIZES_MM[format];
    widthPx = mm[0] * MM_TO_PX;
    heightPx = mm[1] * MM_TO_PX;
    label = format;
  }

  if (pdf.landscape) {
    [widthPx, heightPx] = [heightPx, widthPx];
    label = `${label} (landscape)`;
  }

  const marginLeft = pdf.margin?.left !== undefined ? lengthToPx(pdf.margin.left) : 0;
  const marginRight = pdf.margin?.right !== undefined ? lengthToPx(pdf.margin.right) : 0;
  const contentWidthPx = Math.max(1, widthPx - marginLeft - marginRight);

  const fitScale = viewport.width > 0 ? contentWidthPx / viewport.width : 1;
  const scale = Math.min(1, Math.max(0.1, fitScale));

  return { scale, paperWidthPx: widthPx, paperHeightPx: heightPx, contentWidthPx, paperLabel: label };
}
