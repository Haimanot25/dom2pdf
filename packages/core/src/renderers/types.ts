import type { Page } from "playwright";
import type { NormalizedOptions } from "../config/normalize.js";
import type { PaginationHintsResult } from "../pagination/keep-together.js";
import type { Logger } from "../utils/logger.js";

export interface RenderContext {
  page: Page;
  options: NormalizedOptions;
  logger: Logger;
  signal: AbortSignal | undefined;
}

/** Render facts reported back for the quality report. */
export interface RenderMetadata {
  outputPolicy: "paper-fit";
  /** Effective scale handed to Chromium (0.1 … 1). */
  scale: number;
  /** e.g. `A4` or `793×1123px`. */
  paperLabel: string;
  viewportWidth: number;
}

export interface RenderResult {
  bytes: Uint8Array;
  metadata?: RenderMetadata;
  /** Present exactly when `pagination.keepTogether` was requested. */
  pagination?: PaginationHintsResult;
}

export type RenderMode = "document" | "screen";

export interface Renderer {
  readonly mode: RenderMode;
  render(context: RenderContext): Promise<RenderResult>;
}
