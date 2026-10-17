import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";

export interface PageSize {
  /** Width in PDF points (1/72 inch). */
  width: number;
  /** Height in PDF points (1/72 inch). */
  height: number;
}

/** Reads a page's media box (via the viewport) in PDF points; A4 ≈ 595.3 × 841.9pt. */
export async function getPdfPageSize(bytes: Uint8Array, pageNumber = 1): Promise<PageSize> {
  // Copies into a plain Uint8Array: pdfjs rejects Node Buffers, and Buffer#slice is a shared view.
  const task = getDocument({ data: new Uint8Array(bytes), verbosity: 0 });
  try {
    const document = await task.promise;
    const page = await document.getPage(pageNumber);
    const viewport = page.getViewport({ scale: 1 });
    return { width: viewport.width, height: viewport.height };
  } finally {
    await task.destroy().catch(() => undefined);
  }
}

export async function getPdfPageSizes(bytes: Uint8Array): Promise<PageSize[]> {
  const task = getDocument({ data: new Uint8Array(bytes), verbosity: 0 });
  try {
    const document = await task.promise;
    const sizes: PageSize[] = [];
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      const page = await document.getPage(pageNumber);
      const viewport = page.getViewport({ scale: 1 });
      sizes.push({ width: viewport.width, height: viewport.height });
    }
    return sizes;
  } finally {
    await task.destroy().catch(() => undefined);
  }
}
