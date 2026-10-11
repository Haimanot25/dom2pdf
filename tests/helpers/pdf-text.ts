import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";

/**
 * Extracts text per page with pdfjs-dist for assertions that output remains
 * selectable/searchable. Text presence does NOT imply correct reading order,
 * complete coverage, or accessibility — only that glyphs were emitted as text.
 */
export async function extractPdfText(bytes: Uint8Array): Promise<string[]> {
  // `new Uint8Array(bytes)` copies into a plain Uint8Array: pdfjs rejects Node
  // Buffers, and Buffer#slice would return a shared view rather than a copy.
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
