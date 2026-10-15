import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { Dom2PdfError } from "../errors/index.js";
import { sanitizeBytesForDisplay } from "../utils/url.js";

export interface PdfInspection {
  /** Total PDF size in bytes. */
  byteLength: number;
  /** Page count from successful structural parsing. */
  pageCount: number;
  /** PDF header version (e.g. `"1.7"`), or null if absent. */
  headerVersion: string | null;
  /** Text extraction stats when requested via `inspectPdf(bytes, { extractText: true })`. */
  text: PdfTextStats | null;
}

export interface PdfTextStats {
  /** Non-whitespace characters across the whole document. */
  totalChars: number;
  /** Non-whitespace characters per page, in page-tree order. */
  perPageChars: number[];
  /** 1-based page numbers that contain no extractable text. */
  emptyPages: number[];
  /**
   * Raw extracted text per page, in page-tree order. A weak signal like the
   * counts: it proves text presence, not reading order or fidelity — and
   * text that was never painted (e.g. invisible elements) is not here.
   */
  pages: string[];
}

function readHeader(bytes: Uint8Array): string | null {
  const magic = "%PDF-";
  if (bytes.length < magic.length) return null;
  for (let i = 0; i < magic.length; i += 1) {
    if (bytes[i] !== magic.charCodeAt(i)) return null;
  }
  let version = "";
  for (let i = magic.length; i < Math.min(bytes.length, magic.length + 3); i += 1) {
    const byte = bytes[i] ?? 0;
    const char = String.fromCharCode(byte);
    if (!/[0-9.]/.test(char)) break;
    version += char;
  }
  return version.length > 0 ? version : null;
}

/**
 * Structural validation of generated output using pdfjs-dist.
 *
 * A successful parse (header + document tree + page tree) is a structural
 * check only — it says nothing about visual fidelity or reading order.
 * Text extraction (also a weak signal: presence of text, not correct reading
 * order) runs in the same parse when `extractText` is set.
 */
export async function inspectPdf(
  bytes: Uint8Array,
  options: { extractText?: boolean } = {},
): Promise<PdfInspection> {
  const byteLength = bytes.byteLength;
  const headerVersion = readHeader(bytes);

  if (headerVersion === null) {
    throw new Dom2PdfError({
      code: "PDF_VALIDATION_FAILED",
      message: "Generated output is missing the %PDF header",
      details: { byteLength, preview: sanitizeBytesForDisplay(bytes) },
    });
  }

  // pdfjs takes ownership of (and may transfer/detach) the provided data, and
  // rejects Node Buffers outright — hand it a fresh plain Uint8Array copy so
  // the caller's bytes stay intact.
  try {
    const task = getDocument({ data: new Uint8Array(bytes), verbosity: 0 });
    try {
      const document = await task.promise;
      const inspection: PdfInspection = {
        byteLength,
        pageCount: document.numPages,
        headerVersion,
        text: null,
      };
      if (options.extractText === true) {
        const perPageChars: number[] = [];
        const emptyPages: number[] = [];
        const pages: string[] = [];
        for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
          const page = await document.getPage(pageNumber);
          const content = await page.getTextContent();
          const text = content.items.map((item) => ("str" in item ? item.str : "")).join("");
          const chars = text.replace(/\s+/g, "").length;
          perPageChars.push(chars);
          pages.push(text);
          if (chars === 0) emptyPages.push(pageNumber);
        }
        inspection.text = {
          totalChars: perPageChars.reduce((sum, count) => sum + count, 0),
          perPageChars,
          emptyPages,
          pages,
        };
      }
      return inspection;
    } finally {
      await task.destroy().catch(() => undefined);
    }
  } catch (cause) {
    if (cause instanceof Dom2PdfError) throw cause;
    throw new Dom2PdfError({
      code: "PDF_VALIDATION_FAILED",
      message: `Generated output failed PDF structural validation${cause instanceof Error ? `: ${cause.message}` : ""}`,
      details: { byteLength, headerVersion },
      cause,
    });
  }
}
