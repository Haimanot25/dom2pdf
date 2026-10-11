#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { Command, CommanderError } from "commander";
import { isPageForgeError } from "pageforge-pdf";
import { registerConvertCommand } from "./convert.js";
import { registerInspectCommand } from "./inspect.js";
import { errorToJson, errorToText, EXIT_CODES, exitCodeFor } from "./shared.js";

/**
 * PageForge CLI entry point.
 *
 * Exit codes are a stable contract:
 *
 * - 0   success
 * - 2   usage error (unknown command/flag, invalid argument)
 * - 3   conversion/inspection failed (typed library error)
 * - 4   output rejected by a quality policy
 * - 130 cancelled via SIGINT (128 + SIGINT)
 *
 * `--json` mode reports errors as JSON on stderr; success reports are JSON on
 * stdout. The CLI contains no conversion logic — everything goes through the
 * `pageforge-pdf` library.
 */
export async function main(argv: string[]): Promise<number> {
  const program = new Command();
  program
    .name("pageforge")
    .description("PageForge — HTML-to-PDF conversion engine")
    .version(readVersion())
    .showHelpAfterError()
    .exitOverride();

  registerConvertCommand(program);
  registerInspectCommand(program);

  const jsonMode = argv.includes("--json");
  try {
    await program.parseAsync(argv);
    return EXIT_CODES.ok;
  } catch (error) {
    if (error instanceof CommanderError) {
      // `--help`/`--version` print themselves, then throw to exit cleanly.
      if (error.code === "commander.helpDisplayed" || error.code === "commander.version") {
        return EXIT_CODES.ok;
      }
      // Commander already wrote the usage message to stderr.
      return EXIT_CODES.usage;
    }
    if (jsonMode) {
      // Machine consumers get the full error, including attached details
      // (quality failures carry the measured report here).
      console.error(JSON.stringify({ error: errorToJson(error) }, null, 2));
    } else {
      console.error(errorToText(error));
      // Quality failures already name every violation in their message, so
      // the full attached report is only spelled out in --json mode.
      if (
        isPageForgeError(error) &&
        error.code !== "QUALITY_POLICY_FAILED" &&
        error.details !== undefined
      ) {
        console.error(`  details: ${JSON.stringify(error.details)}`);
      }
    }
    return exitCodeFor(error);
  }
}

/** Version from the CLI's own package.json (sits next to `dist/`). */
function readVersion(): string {
  try {
    const url = new URL("../package.json", import.meta.url);
    const packageJson = JSON.parse(readFileSync(url, "utf8")) as { version?: string };
    return packageJson.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

const exitCode = await main(process.argv);
process.exitCode = exitCode;
