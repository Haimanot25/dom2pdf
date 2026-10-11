import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { PageForgeError } from "../errors/index.js";
import { sanitizeBytesForDisplay } from "../utils/url.js";

export interface PdfInspection {
  /** Total PDF size in bytes. */
  byteLength: number;
  /** Page count from successful structural parsing. */
  pageCount: number;
  /** PDF header version (e.g. `"1.7"`), or null if absent. */
  headerVersion: string | null;
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
 */
export async function inspectPdf(bytes: Uint8Array): Promise<PdfInspection> {
  const byteLength = bytes.byteLength;
  const headerVersion = readHeader(bytes);

  if (headerVersion === null) {
    throw new PageForgeError({
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
      return { byteLength, pageCount: document.numPages, headerVersion };
    } finally {
      await task.destroy().catch(() => undefined);
    }
  } catch (cause) {
    if (cause instanceof PageForgeError) throw cause;
    throw new PageForgeError({
      code: "PDF_VALIDATION_FAILED",
      message: `Generated output failed PDF structural validation${cause instanceof Error ? `: ${cause.message}` : ""}`,
      details: { byteLength, headerVersion },
      cause,
    });
  }
}
