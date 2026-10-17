import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";

/**
 * Extracts text per page with pdfjs-dist. Text presence proves only that
 * glyphs were emitted as text, not reading order, coverage, or accessibility.
 */
export async function extractPdfText(bytes: Uint8Array): Promise<string[]> {
  // Copies into a plain Uint8Array: pdfjs rejects Node Buffers, and Buffer#slice is a shared view.
  const task = getDocument({ data: new Uint8Array(bytes), verbosity: 0 });
  try {
    const document = await task.promise;
    const pages: string[] = [];
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      const page = await document.getPage(pageNumber);
      const content = await page.getTextContent();
      pages.push(
        content.items
          .map((item) => ("str" in item ? item.str : ""))
          .join(""),
      );
    }
    return pages;
  } finally {
    await task.destroy().catch(() => undefined);
  }
}
