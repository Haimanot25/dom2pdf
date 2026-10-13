import { readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Command } from "commander";
import {
  createConverter,
  createSilentLogger,
  readAttachedDiagnostics,
  type DiagnosticsBundle,
  type QualityReport,
} from "pageforge-pdf";
import {
  buildConvertOptions,
  formatBytes,
  parseIntFlag,
  resolveInputSource,
  UsageError,
  type ConvertFlags,
} from "./shared.js";

function readStdin(): string {
  if (process.stdin.isTTY) {
    throw new UsageError("--stdin requires HTML piped on stdin (nothing was piped)");
  }
  return readFileSync(0, "utf8");
}

/**
 * Writes a failure-forensics bundle next to the intended output as
 * `<output>.diag/`: `meta.json` (console, page errors, requests), plus
 * `page.html` and `screenshot.jpg` when they could be captured.
 */
async function writeDiagnosticsBundle(outputPath: string, bundle: DiagnosticsBundle): Promise<string> {
  const dir = `${outputPath}.diag`;
  await mkdir(dir, { recursive: true });
  const { screenshotJpegBase64, dom, ...rest } = bundle;
  await writeFile(path.join(dir, "meta.json"), `${JSON.stringify(rest, null, 2)}\n`);
  if (dom !== undefined) await writeFile(path.join(dir, "page.html"), dom);
  if (screenshotJpegBase64 !== undefined) {
    await writeFile(path.join(dir, "screenshot.jpg"), Buffer.from(screenshotJpegBase64, "base64"));
  }
  return dir;
}

function printSummary(report: QualityReport, output: string): void {
  const minutes = report.durationMs / 1000;
  const checksPassed = report.checks.filter((check) => check.status === "pass").length;
  const checksWarned = report.checks.filter((check) => check.status === "warn").length;
  console.log(`Wrote ${output}`);
  console.log(
    `  ${report.mode} mode · ${report.pdf.pageCount} page(s) · ${formatBytes(report.pdf.byteLength)} · ${minutes.toFixed(2)}s (readiness ${report.timings.readinessMs}ms, render ${report.timings.renderMs}ms)`,
  );
  console.log(
    `  checks: ${checksPassed} passed${checksWarned > 0 ? `, ${checksWarned} warned` : ""} · warnings: ${report.warnings.length}`,
  );
  for (const warning of report.warnings) {
    console.log(`  ! [${warning.code}] ${warning.message}`);
  }
}

export function registerConvertCommand(program: Command): void {
  program
    .command("convert")
    .description("convert a URL, HTML file, or piped HTML to PDF")
    .argument("[source]", "http(s) URL or local HTML file (omit when using --stdin)")
    .option("-o, --output <path>", "output PDF path", "pageforge.pdf")
    .option("--stdin", "read the HTML input from stdin")
    .option("--mode <mode>", "rendering mode: document | screen", undefined)
    .option("--format <format>", "paper format (A4, Letter, …)", undefined)
    .option("--landscape", "rotate the paper to landscape")
    .option("--scale <n>", "print scale 0.1–2 (document mode only)", undefined)
    .option("--margin <spec>", "page margin: one value or top,right,bottom,left", undefined)
    .option("--viewport <WxH>", "browser viewport, e.g. 1440x900", undefined)
    .option("--timeout <ms>", "overall readiness deadline in ms", undefined)
    .option("--render-timeout <ms>", "render deadline in ms", undefined)
    .option("--page-ranges <range>", 'pages to emit, e.g. "1-5, 8"', undefined)
    .option("--prefer-css-page-size", "let the page's @page rule decide the paper")
    .option("--no-print-background", "do not print CSS backgrounds")
    .option("--outline", "embed the document outline (headings) in the PDF")
    .option("--tagged", "ask Chromium for a tagged (accessible) PDF")
    .option("--min-pages <n>", "quality policy: minimum page count", undefined)
    .option("--max-pages <n>", "quality policy: maximum page count", undefined)
    .option("--min-text-chars <n>", "quality policy: minimum extractable characters", undefined)
    .option("--max-bytes <n>", "quality policy: maximum output size in bytes", undefined)
    .option("--fail-on-warnings", "quality policy: reject output that produced warnings")
    .option("--allow-loopback", "permit loopback URLs (localhost, 127.0.0.0/8, ::1)")
    .option("--allow-private-network", "permit RFC1918/link-local destinations")
    .option("--max-requests <n>", "limit: max http(s) requests per conversion (default 500)", undefined)
    .option("--max-output-bytes <n>", "limit: hard cap on generated PDF size in bytes", undefined)
    .option("--max-concurrent <n>", "limit: conversions allowed at once on this converter", undefined)
    .option("--diagnostics", "on failure, write forensics (console, requests, DOM, screenshot) to <output>.diag/")
    .option("--json", "print the structured quality report as JSON on stdout")
    .option("--quiet", "suppress success output (errors still go to stderr)")
    .action(async (source: string | undefined, flags: ConvertFlags) => {
      const inputPlan = resolveInputSource(source, flags.stdin === true);
      const options = buildConvertOptions(flags, inputPlan, readStdin);

      const controller = new AbortController();
      const onSignal = (): void => controller.abort();
      process.once("SIGINT", onSignal);
      const converter = await createConverter({
        ...(flags.quiet === true ? { logger: createSilentLogger() } : {}),
        ...(flags.maxConcurrent !== undefined
          ? { limits: { maxConcurrentConversions: parseIntFlag("max-concurrent", flags.maxConcurrent) } }
          : {}),
      });
      try {
        const result = await converter.convert({ ...options, signal: controller.signal });
        await result.save(flags.output);
        if (flags.json === true) {
          console.log(JSON.stringify(result.report, null, 2));
        } else if (flags.quiet !== true) {
          printSummary(result.report, flags.output);
        }
      } catch (error) {
        if (flags.diagnostics === true) {
          const bundle = readAttachedDiagnostics(error);
          if (bundle !== undefined) {
            try {
              const dir = await writeDiagnosticsBundle(flags.output, bundle);
              console.error(`Diagnostics written to ${dir}`);
            } catch (writeCause) {
              console.error(
                `Failed to write diagnostics: ${writeCause instanceof Error ? writeCause.message : String(writeCause)}`,
              );
            }
          }
        }
        throw error;
      } finally {
        process.removeListener("SIGINT", onSignal);
        await converter.close();
      }
    });
}
