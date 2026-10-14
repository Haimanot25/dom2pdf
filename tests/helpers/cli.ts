import { spawn } from "node:child_process";
import path from "node:path";

export const CLI = path.resolve("apps/cli/dist/index.js");

export interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

export function runCli(
  args: string[],
  options: { stdin?: string; timeoutMs?: number } = {},
): Promise<CliResult> {
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
      reject(new Error(`CLI timed out: dom2pdf ${args.join(" ")}`));
    }, options.timeoutMs ?? 60_000);
    child.on("error", reject);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, stdout, stderr });
    });
    child.stdin.end(options.stdin ?? "");
  });
}
