import type { Page } from "playwright";
import type { NormalizedOptions } from "../config/normalize.js";
import type { Logger } from "../utils/logger.js";

export interface RenderContext {
  page: Page;
  options: NormalizedOptions;
  logger: Logger;
}

export interface RenderResult {
  bytes: Uint8Array;
}

export type RenderMode = "document" | "screen";

export interface Renderer {
  readonly mode: RenderMode;
  render(context: RenderContext): Promise<RenderResult>;
}
