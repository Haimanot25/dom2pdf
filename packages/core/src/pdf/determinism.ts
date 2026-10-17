import { createHash } from "node:crypto";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { Dom2PdfError } from "../errors/index.js";

/**
 * Date spans are the only byte-level difference between runs of one build; zeroing them in place
 * preserves byte length (xref stays valid). Holds for the same machine and Chromium build only.
 */

/** Report of what the deterministic rewrite did, carried on the quality report. */
export interface DeterminismReport {
  /** sha256 hex over page count + per-page extracted text (whitespace-normalized). */
  contentDigest: string;
  /** Date spans zeroed in place. */
  normalizedSpans: number;
  /** Date-key spans found but not normalizable (value was not a literal string). */
  residual: number;
}

export interface PdfDateNormalization {
  /** A copy with dates normalized; the input is never mutated. */
  bytes: Uint8Array;
  normalizedSpans: number;
  residual: number;
}

const DATE_KEYS = ["/CreationDate", "/ModDate"] as const;

function isWhitespaceByte(byte: number | undefined): boolean {
  return byte === 0x00 || byte === 0x09 || byte === 0x0a || byte === 0x0c || byte === 0x0d || byte === 0x20;
}

/** PDF name-delimiter context: a key starts after whitespace or another delimiter. */
function isDelimiterByte(byte: number | undefined): boolean {
  return (
    isWhitespaceByte(byte) ||
    byte === 0x2f /* / */ ||
    byte === 0x3c /* < */ ||
    byte === 0x3e /* > */ ||
    byte === 0x28 /* ( */ ||
    byte === 0x29 /* ) */
  );
}

function indexOfAscii(bytes: Uint8Array, needle: string, from: number): number {
  const first = needle.charCodeAt(0);
  const length = needle.length;
  for (let i = from; i <= bytes.length - length; i += 1) {
    if (bytes[i] !== first) continue;
    let matched = true;
    for (let j = 1; j < length; j += 1) {
      if (bytes[i + j] !== needle.charCodeAt(j)) {
        matched = false;
        break;
      }
    }
    if (matched) return i;
  }
  return -1;
}

/** Finds the closing `)` of a PDF literal string, honoring backslash escapes. */
function findClosingParen(bytes: Uint8Array, open: number): number {
  for (let i = open + 1; i < bytes.length; i += 1) {
    const byte = bytes[i];
    if (byte === 0x5c) {
      i += 1; // skip the escaped character
      continue;
    }
    if (byte === 0x29) return i;
  }
  return -1;
}

/** Zeroes `/CreationDate` and `/ModDate` literal-string values in place (digits become `0`,
 * a `-` UTC-offset sign becomes `+`), preserving byte length. Non-literal values count as `residual`. */
export function normalizePdfDates(input: Uint8Array): PdfDateNormalization {
  const bytes = new Uint8Array(input); // copy: never mutate the caller's buffer
  let normalizedSpans = 0;
  let residual = 0;

  for (const key of DATE_KEYS) {
    let from = 0;
    for (;;) {
      const at = indexOfAscii(bytes, key, from);
      if (at < 0) break;
      from = at + key.length;
      // Only match a real name token: reject `...ModDate` glued to a longer name.
      if (at > 0 && !isDelimiterByte(bytes[at - 1])) continue;

      let valueStart = from;
      while (valueStart < bytes.length && isWhitespaceByte(bytes[valueStart])) valueStart += 1;
      if (bytes[valueStart] !== 0x28) {
        residual += 1; // value is not a literal string: cannot rewrite safely
        continue;
      }
      const close = findClosingParen(bytes, valueStart);
      if (close < 0) {
        residual += 1; // unterminated literal string
        continue;
      }
      for (let i = valueStart + 1; i < close; i += 1) {
        const byte = bytes[i];
        if (byte !== undefined && byte >= 0x30 && byte <= 0x39) {
          bytes[i] = 0x30; // digit → '0'
        } else if (byte === 0x2d) {
          bytes[i] = 0x2b; // '-' offset sign → '+'
        }
      }
      normalizedSpans += 1;
    }
  }

  return { bytes, normalizedSpans, residual };
}

/** sha256 over `pageCount` plus per-page text with whitespace collapsed, independent of the
 * date stamps; the version tag keeps future format changes from colliding with old digests. */
export function digestFromPages(pageCount: number, pageTexts: readonly string[]): string {
  const normalized = pageTexts.map((text) => text.replace(/\s+/g, " ").trim());
  const payload = `dom2pdf-text-digest-v1\n${pageCount}\n${normalized.join("\u241e")}`;
  return createHash("sha256").update(payload, "utf8").digest("hex");
}

/** Per-page text via pdf.js (same engine as structural inspection); runs only when
 * `deterministic: true`. A parse failure surfaces as a typed error, not a missing digest. */
export async function contentDigest(bytes: Uint8Array): Promise<string> {
  try {
    const task = getDocument({ data: new Uint8Array(bytes), verbosity: 0 });
    try {
      const document = await task.promise;
      const pageTexts: string[] = [];
      for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
        const page = await document.getPage(pageNumber);
        const content = await page.getTextContent();
        pageTexts.push(content.items.map((item) => ("str" in item ? item.str : "")).join(""));
      }
      return digestFromPages(document.numPages, pageTexts);
    } finally {
      await task.destroy().catch(() => undefined);
    }
  } catch (cause) {
    if (cause instanceof Dom2PdfError) throw cause;
    throw new Dom2PdfError({
      code: "PDF_VALIDATION_FAILED",
      message: `Failed to compute the content digest${cause instanceof Error ? `: ${cause.message}` : ""}`,
      cause,
    });
  }
}
