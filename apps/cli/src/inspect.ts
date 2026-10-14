import { readFileSync } from "node:fs";
import { statSync } from "node:fs";
import path from "node:path";
import type { Command } from "commander";
import { inspectPdf, Dom2PdfError } from "dom2pdf-js";
import { formatBytes, UsageError } from "./shared.js";

interface InspectJson {
  file: string;
  byteLength: number;
  pageCount: number;
  headerVersion: string | null;
  text: { totalChars: number; perPageChars: number[]; emptyPages: number[] } | null;
}

export function registerInspectCommand(program: Command): void {
  program
    .command("inspect")
    .description("structurally inspect a PDF: pages, size, header, extractable text")
    .argument("<file>", "path to an existing PDF")
    .option("--json", "print the inspection as JSON on stdout")
    .action(async (file: string, flags: { json?: boolean }) => {
      const resolved = path.resolve(file);
      let bytes: Buffer;
      try {
        const info = statSync(resolved);
        if (!info.isFile()) throw new UsageError(`not a file: ${resolved}`);
        bytes = readFileSync(resolved);
      } catch (cause) {
        if (cause instanceof UsageError) throw cause;
        throw new Dom2PdfError({
          code: "INVALID_INPUT",
          message: `Cannot read ${resolved}: ${cause instanceof Error ? cause.message : String(cause)}`,
          cause,
        });
      }

      const inspection = await inspectPdf(new Uint8Array(bytes), { extractText: true });
      const payload: InspectJson = {
        file: resolved,
        byteLength: inspection.byteLength,
        pageCount: inspection.pageCount,
        headerVersion: inspection.headerVersion,
        text: inspection.text,
      };

      if (flags.json === true) {
        console.log(JSON.stringify(payload, null, 2));
        return;
      }
      const text = inspection.text;
      const emptyPages = text !== null && text.emptyPages.length > 0 ? text.emptyPages.join(", ") : "none";
      console.log(
        `${path.basename(resolved)}: ${inspection.pageCount} page(s) · ${formatBytes(inspection.byteLength)} · %PDF-${inspection.headerVersion ?? "?"}`,
      );
      if (text !== null) {
        console.log(
          `  text: ${text.totalChars} character(s) across ${text.perPageChars.length} page(s) · empty pages: ${emptyPages}`,
        );
      }
    });
}
