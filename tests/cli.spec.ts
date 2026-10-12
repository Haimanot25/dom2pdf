import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { startFixtureServer, type FixtureServer } from "./helpers/fixture-server.js";

const CLI = path.resolve("apps/cli/dist/index.js");

interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

function runCli(args: string[], options: { stdin?: string; timeoutMs?: number } = {}): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`CLI timed out: pageforge ${args.join(" ")}`));
    }, options.timeoutMs ?? 60_000);
    child.on("error", reject);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, stdout, stderr });
    });
    child.stdin.end(options.stdin ?? "");
  });
}

let server: FixtureServer;
let workDir: string;

test.beforeAll(async () => {
  server = await startFixtureServer();
  workDir = await mkdtemp(path.join(tmpdir(), "pageforge-cli-"));
});

test.afterAll(async () => {
  await server?.close();
  await rm(workDir, { recursive: true, force: true });
});

test.describe("pageforge CLI", () => {
  test("--help lists the available commands and exits 0", async () => {
    const result = await runCli(["--help"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Usage: pageforge");
    expect(result.stdout).toContain("convert");
    expect(result.stdout).toContain("inspect");
  });

  test("--version prints the package version and exits 0", async () => {
    const result = await runCli(["--version"]);
    expect(result.code).toBe(0);
    expect(result.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
  });

  test("unknown options exit with the usage code 2", async () => {
    const unknownTop = await runCli(["--definitely-not-a-flag"]);
    expect(unknownTop.code).toBe(2);
    const unknownCommand = await runCli(["convert", "--nope"]);
    expect(unknownCommand.code).toBe(2);
    expect(unknownCommand.stderr).toContain("unknown option");
  });

  test("a missing input argument exits with the usage code 2", async () => {
    const result = await runCli(["convert"]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("missing input");
  });

  test("convert writes a PDF from a local file and summarizes the report", async () => {
    const output = path.join(workDir, "basic.pdf");
    const result = await runCli(["convert", "fixtures/basic-text.html", "-o", output]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Wrote");
    expect(result.stdout).toContain("page(s)");

    const bytes = await readFile(output);
    expect(bytes.subarray(0, 5).toString("ascii")).toBe("%PDF-");
  });

  test("convert --json prints a parseable report on stdout", async () => {
    const output = path.join(workDir, "json.pdf");
    const result = await runCli([
      "convert",
      "fixtures/basic-text.html",
      "-o",
      output,
      "--json",
      "--quiet",
    ]);
    expect(result.code).toBe(0);
    const report = JSON.parse(result.stdout) as {
      status: string;
      mode: string;
      pdf: { pageCount: number; headerVersion: string };
      checks: Array<{ id: string }>;
      timings: { readinessMs: number; renderMs: number };
    };
    expect(report.status).toBe("succeeded");
    expect(report.mode).toBe("document");
    expect(report.pdf.pageCount).toBeGreaterThanOrEqual(1);
    expect(report.checks.map((check) => check.id)).toContain("readiness");
    expect(report.checks.map((check) => check.id)).toContain("pdf-text");
    expect(report.timings.renderMs).toBeGreaterThan(0);
  });

  test("convert accepts HTML piped on stdin", async () => {
    const output = path.join(workDir, "stdin.pdf");
    const result = await runCli(["convert", "--stdin", "-o", output, "--quiet"], {
      stdin: "<!doctype html><p>piped input works</p>",
    });
    expect(result.code).toBe(0);
    const bytes = await readFile(output);
    expect(bytes.subarray(0, 5).toString("ascii")).toBe("%PDF-");
  });

  test("blocked destinations exit 3 with the error code on stderr", async () => {
    const result = await runCli(["convert", "http://10.0.0.1/x", "-o", path.join(workDir, "nope.pdf")]);
    expect(result.code).toBe(3);
    expect(result.stderr).toContain("BLOCKED_URL");
  });

  test("--max-output-bytes caps the output with RESOURCE_LIMIT_EXCEEDED (exit 3)", async () => {
    const result = await runCli([
      "convert",
      "fixtures/basic-text.html",
      "-o",
      path.join(workDir, "capped.pdf"),
      "--max-output-bytes",
      "100",
    ]);
    expect(result.code).toBe(3);
    expect(result.stderr).toContain("RESOURCE_LIMIT_EXCEEDED");
  });

  test("invalid limit flags are usage errors (exit 2)", async () => {
    const result = await runCli([
      "convert",
      "fixtures/basic-text.html",
      "-o",
      path.join(workDir, "unused.pdf"),
      "--max-requests",
      "abc",
    ]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("--max-requests");
  });

  test("quality policy rejection exits 4; --json carries the measured report", async () => {
    const plain = await runCli([
      "convert",
      "fixtures/basic-text.html",
      "-o",
      path.join(workDir, "q.pdf"),
      "--min-pages",
      "50",
    ]);
    expect(plain.code).toBe(4);
    expect(plain.stderr).toContain("QUALITY_POLICY_FAILED");

    const json = await runCli([
      "convert",
      "fixtures/basic-text.html",
      "-o",
      path.join(workDir, "q2.pdf"),
      "--min-pages",
      "50",
      "--json",
    ]);
    expect(json.code).toBe(4);
    const payload = JSON.parse(json.stderr) as {
      error: { code: string; details: { violations: Array<{ rule: string }>; report: { pdf: { pageCount: number } } } };
    };
    expect(payload.error.code).toBe("QUALITY_POLICY_FAILED");
    expect(payload.error.details.violations[0]?.rule).toBe("minPages");
    expect(payload.error.details.report.pdf.pageCount).toBeGreaterThanOrEqual(1);
  });

  test("inspect reports structure and text of a generated PDF", async () => {
    const output = path.join(workDir, "inspect-me.pdf");
    const converted = await runCli(["convert", "fixtures/basic-text.html", "-o", output, "--quiet"]);
    expect(converted.code).toBe(0);

    const human = await runCli(["inspect", output]);
    expect(human.code).toBe(0);
    expect(human.stdout).toContain("page(s)");
    expect(human.stdout).toContain("character(s)");

    const json = await runCli(["inspect", output, "--json"]);
    expect(json.code).toBe(0);
    const payload = JSON.parse(json.stdout) as {
      pageCount: number;
      headerVersion: string;
      text: { totalChars: number };
    };
    expect(payload.pageCount).toBeGreaterThanOrEqual(1);
    expect(payload.headerVersion).toMatch(/^\d/);
    expect(payload.text.totalChars).toBeGreaterThan(0);
  });

  test("inspect on a missing file exits 3", async () => {
    const result = await runCli(["inspect", path.join(workDir, "does-not-exist.pdf")]);
    expect(result.code).toBe(3);
    expect(result.stderr).toContain("INVALID_INPUT");
  });

  test("SIGINT cancels the conversion and exits 130", async () => {
    // Node cannot deliver SIGINT to a child process on Windows; the exit-code
    // mapping itself is unit-tested, and Linux CI exercises this path.
    test.skip(process.platform === "win32", "SIGINT cannot be delivered to child processes on Windows");

    // A page blocked on a slow resource: without cancellation it would run
    // for 6 seconds; SIGINT must interrupt it promptly.
    const slowHtml = path.join(workDir, "slow.html");
    await writeFile(
      slowHtml,
      `<!doctype html><p>slow</p><img src="${server.origin}/__delay/6000/slow.png" />`,
    );

    const child = spawn(
      process.execPath,
      [CLI, "convert", slowHtml, "-o", path.join(workDir, "cancelled.pdf"), "--allow-loopback", "--timeout", "30000"],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });

    const started = Date.now();
    const exitCode = await new Promise<number>((resolve, reject) => {
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error("CLI did not exit after SIGINT"));
      }, 15_000);
      setTimeout(() => child.kill("SIGINT"), 800);
      child.on("close", (code) => {
        clearTimeout(timer);
        resolve(code ?? -1);
      });
    });

    expect(exitCode).toBe(130);
    expect(stderr).toContain("CANCELLED");
    expect(Date.now() - started).toBeLessThan(10_000);
  });
});
