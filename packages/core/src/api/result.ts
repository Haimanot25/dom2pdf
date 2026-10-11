import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { PageForgeError } from "../errors/index.js";
import type { QualityReport } from "../quality/report.js";
import type { ConvertResult } from "./types.js";

export class ConversionResult implements ConvertResult {
  constructor(
    readonly bytes: Uint8Array,
    readonly report: QualityReport,
  ) {}

  async save(target: string): Promise<void> {
    if (typeof target !== "string" || target.length === 0) {
      throw new PageForgeError({
        code: "INVALID_INPUT",
        message: "save(path) requires a non-empty path string",
        details: { path: String(target) },
      });
    }
    const resolved = path.resolve(target);
    await mkdir(path.dirname(resolved), { recursive: true });
    await writeFile(resolved, this.bytes);
  }
}
