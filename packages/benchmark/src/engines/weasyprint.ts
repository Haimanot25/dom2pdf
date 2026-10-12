import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { BenchmarkScenario } from "../scenarios.js";
import type { BenchmarkEngine, EngineAvailability, EngineTimedRun } from "./types.js";

/** Result of spawning an external command — never throws for expected failures. */
export type CommandOutcome =
  | { kind: "exit"; code: number; stdout: string; stderr: string }
  | { kind: "spawn-error"; error: string; notFound: boolean };

export type CommandRunner = (command: string, args: string[]) => Promise<CommandOutcome>;

const defaultRunner: CommandRunner = (command, args) =>
  new Promise((resolve) => {
    execFile(command, args, { windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error === null) {
        resolve({ kind: "exit", code: 0, stdout, stderr });
        return;
      }
      const code: unknown = error.code;
      if (code === "ENOENT") {
        resolve({ kind: "spawn-error", error: error.message, notFound: true });
        return;
      }
      if (typeof code === "number") {
        resolve({ kind: "exit", code, stdout, stderr });
        return;
      }
      resolve({ kind: "spawn-error", error: error.message, notFound: false });
    });
  });

const INSTALL_HINT =
  "WeasyPrint not found on PATH — install it (pip install weasyprint, https://weasyprint.org) " +
  "to include it; without it this engine is reported as skipped, never estimated";

/**
 * WeasyPrint as an external process: `weasyprint input.html output.pdf`.
 *
 * It only runs if installed — the probe reports absence as an honest `skip`
 * with the install hint. Results are never fabricated when it is missing.
 * The command runner is injectable so the skip/exit paths are unit-testable
 * on machines without WeasyPrint.
 */
export function createWeasyPrintEngine(runner: CommandRunner = defaultRunner): BenchmarkEngine {
  let workDir: string | undefined;

  async function ensureWorkDir(): Promise<string> {
    workDir ??= await mkdtemp(path.join(tmpdir(), "pageforge-bench-"));
    return workDir;
  }

  return {
    name: "weasyprint",
    description: "WeasyPrint CLI (external process, skips with install hint when absent)",

    async probe(): Promise<EngineAvailability> {
      const outcome = await runner("weasyprint", ["--version"]);
      if (outcome.kind === "spawn-error") {
        return { available: false, reason: outcome.notFound ? INSTALL_HINT : `WeasyPrint could not start: ${outcome.error}` };
      }
      if (outcome.code !== 0) {
        return { available: false, reason: `WeasyPrint found but "--version" failed (exit ${outcome.code}): ${outcome.stderr.trim().slice(0, 200)}` };
      }
      return { available: true, detail: outcome.stdout.trim().split("\n")[0] ?? "WeasyPrint" };
    },

    async prepare(scenario: BenchmarkScenario, html: string): Promise<void> {
      const dir = await ensureWorkDir();
      await writeFile(path.join(dir, `${scenario.name}.html`), html, "utf8");
    },

    async run(scenario: BenchmarkScenario, _html: string): Promise<EngineTimedRun> {
      const dir = workDir;
      if (dir === undefined) throw new Error("weasyprint engine was not prepared for this scenario");
      const input = path.join(dir, `${scenario.name}.html`);
      const output = path.join(dir, `${scenario.name}.pdf`);
      const startedAt = performance.now();
      const outcome = await runner("weasyprint", [input, output]);
      const ms = performance.now() - startedAt;
      if (outcome.kind === "spawn-error") {
        throw new Error(`weasyprint could not start: ${outcome.error}`);
      }
      if (outcome.code !== 0) {
        throw new Error(`weasyprint exited ${outcome.code}: ${outcome.stderr.trim().slice(0, 300)}`);
      }
      const bytes = await readFile(output);
      return { ms, outputBytes: bytes.byteLength };
    },

    async cleanup(): Promise<void> {
      const dir = workDir;
      workDir = undefined;
      if (dir !== undefined) await rm(dir, { recursive: true, force: true });
    },
  };
}
