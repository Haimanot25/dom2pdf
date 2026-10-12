import { access, readFile, writeFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { createWeasyPrintEngine, type CommandOutcome, type CommandRunner } from "../src/engines/weasyprint.js";
import { SCENARIOS } from "../src/scenarios.js";

const simple = SCENARIOS.find((scenario) => scenario.name === "simple");
if (simple === undefined) throw new Error("simple scenario missing");

interface Call {
  command: string;
  args: string[];
}

/** Fake `weasyprint` that records calls and writes the requested output file. */
function recordingRunner(
  respond: (command: string, args: string[]) => CommandOutcome | Promise<CommandOutcome>,
): { runner: CommandRunner; calls: Call[] } {
  const calls: Call[] = [];
  const runner: CommandRunner = async (command, args) => {
    const outcome = await respond(command, args);
    calls.push({ command, args });
    return outcome;
  };
  return { runner, calls };
}

const exit0 = (stdout = "WeasyPrint 63.1\n"): CommandOutcome => ({
  kind: "exit",
  code: 0,
  stdout,
  stderr: "",
});

describe("weasyprint engine", () => {
  it("probes as unavailable with the honest install hint when the CLI is absent", async () => {
    const { runner, calls } = recordingRunner(() => ({
      kind: "spawn-error",
      error: "spawn weasyprint ENOENT",
      notFound: true,
    }));
    const engine = createWeasyPrintEngine(runner);
    const availability = await engine.probe();
    expect(availability.available).toBe(false);
    if (availability.available) throw new Error("unreachable");
    expect(availability.reason).toContain("not found on PATH");
    expect(availability.reason).toContain("skipped, never estimated");
    expect(calls).toEqual([{ command: "weasyprint", args: ["--version"] }]);
  });

  it("probes as available with the version detail when the CLI answers", async () => {
    const { runner } = recordingRunner(() => exit0());
    const engine = createWeasyPrintEngine(runner);
    const availability = await engine.probe();
    expect(availability.available).toBe(true);
    if (!availability.available) throw new Error("unreachable");
    expect(availability.detail).toBe("WeasyPrint 63.1");
  });

  it("probes as unavailable when --version exits non-zero (found but broken)", async () => {
    const { runner } = recordingRunner(() => ({
      kind: "exit",
      code: 1,
      stdout: "",
      stderr: "missing shared library",
    }));
    const engine = createWeasyPrintEngine(runner);
    const availability = await engine.probe();
    expect(availability.available).toBe(false);
    if (availability.available) throw new Error("unreachable");
    expect(availability.reason).toContain("exit 1");
    expect(availability.reason).toContain("missing shared library");
  });

  it("writes the scenario HTML, converts, and measures output bytes", async () => {
    const { runner, calls } = recordingRunner(async (command, args) => {
      if (args.length === 1) return exit0();
      // Conversion call: produce a fake PDF where the CLI would.
      await writeFile(args[1] as string, "%PDF-1.4 fake benchmark output");
      return exit0();
    });
    const engine = createWeasyPrintEngine(runner);
    expect((await engine.probe()).available).toBe(true);

    await engine.prepare(simple, simple.html());
    const convertCalls = () => calls.filter((call) => call.args.length === 2);
    expect(convertCalls()).toHaveLength(0);

    const first = await engine.run(simple, simple.html());
    const second = await engine.run(simple, simple.html());
    expect(first.outputBytes).toBe("%PDF-1.4 fake benchmark output".length);
    expect(second.outputBytes).toBe(first.outputBytes);
    expect(first.ms).toBeGreaterThanOrEqual(0);

    const inputPath = convertCalls()[0]?.args[0] as string;
    expect(await readFile(inputPath, "utf8")).toBe(simple.html());

    await engine.cleanup();
    await expect(access(inputPath)).rejects.toThrow(); // temp dir removed
    await engine.cleanup(); // idempotent
  });

  it("surfaces conversion failures as typed-in-message errors, not fake timings", async () => {
    const { runner } = recordingRunner(async (_command, args) => {
      if (args.length === 1) return exit0();
      return { kind: "exit", code: 2, stdout: "", stderr: "no space left on device" };
    });
    const engine = createWeasyPrintEngine(runner);
    await engine.probe();
    await engine.prepare(simple, simple.html());
    await expect(engine.run(simple, simple.html())).rejects.toThrow(/exited 2: no space left on device/);
    await engine.cleanup();
  });

  it("rejects running before prepare", async () => {
    const { runner } = recordingRunner(() => exit0());
    const engine = createWeasyPrintEngine(runner);
    await engine.probe();
    await expect(engine.run(simple, simple.html())).rejects.toThrow(/not prepared/);
  });
});
