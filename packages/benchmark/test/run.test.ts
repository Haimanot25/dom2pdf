import { describe, expect, it } from "vitest";
import { Dom2PdfError } from "dom2pdf-js";
import type { BenchmarkEngine, EngineAvailability, EngineTimedRun } from "../src/engines/types.js";
import { ENGINE_NAMES, runBenchmark } from "../src/run.js";
import type { BenchmarkScenario } from "../src/scenarios.js";

interface FakeEngineOptions {
  name?: string;
  probe?: () => Promise<EngineAvailability>;
  prepare?: (scenario: BenchmarkScenario, html: string) => Promise<void>;
  run?: (scenario: BenchmarkScenario, html: string) => Promise<EngineTimedRun>;
  cleanup?: () => Promise<void>;
  browserVersion?: () => string | undefined;
}

interface FakeEngineHandle {
  engine: BenchmarkEngine;
  counts: { run: number; prepare: number; cleanup: number };
}

function fakeEngine(options: FakeEngineOptions = {}): FakeEngineHandle {
  const counts = { run: 0, prepare: 0, cleanup: 0 };
  const engine: BenchmarkEngine = {
    name: options.name ?? "fake",
    description: "fake engine for harness tests",
    probe: options.probe ?? (async () => ({ available: true })),
    prepare: options.prepare ?? (async () => undefined),
    run: options.run ?? (async () => ({ ms: 10, outputBytes: 100 })),
    cleanup: options.cleanup ?? (async () => undefined),
    ...(options.browserVersion === undefined ? {} : { browserVersion: options.browserVersion }),
  };
  // Count calls via wrappers so custom implementations are counted exactly once.
  const basePrepare = engine.prepare;
  engine.prepare = async (scenario, html) => {
    counts.prepare += 1;
    await basePrepare(scenario, html);
  };
  const baseRun = engine.run;
  engine.run = async (scenario, html) => {
    counts.run += 1;
    return baseRun(scenario, html);
  };
  const baseCleanup = engine.cleanup;
  engine.cleanup = async () => {
    counts.cleanup += 1;
    await baseCleanup();
  };
  return { engine, counts };
}

async function expectInvalidInputAsync(fn: () => Promise<unknown>): Promise<Dom2PdfError> {
  let caught: unknown;
  try {
    await fn();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(Dom2PdfError);
  const error = caught as Dom2PdfError;
  expect(error.code).toBe("INVALID_INPUT");
  return error;
}

describe("runBenchmark harness", () => {
  it("measures exactly iterations runs after the warm-ups and computes stats", async () => {
    // Warm-ups consume the first two samples; the four measured runs get the rest.
    const samples = [99, 99, 40, 10, 30, 20];
    const handle = fakeEngine({
      run: async () => ({ ms: samples.shift() ?? 99, outputBytes: 1234 }),
    });
    const report = await runBenchmark({
      iterations: 4,
      warmup: 2,
      scenarios: ["simple"],
      engineFactory: () => [handle.engine],
    });

    expect(handle.counts.run).toBe(6);
    expect(handle.counts.prepare).toBe(1);
    expect(handle.counts.cleanup).toBe(1);

    const engine = report.scenarios[0]?.engines[0];
    expect(engine?.status).toBe("ok");
    expect(engine?.runs).toEqual([40, 10, 30, 20]);
    expect(engine?.stats?.medianMs).toBe(25);
    expect(engine?.stats?.minMs).toBe(10);
    expect(engine?.outputBytes).toBe(1234);
    expect(report.meta.iterations).toBe(4);
    expect(report.meta.warmup).toBe(2);
  });

  it("reports unavailable engines as skipped with the reason, not as failures", async () => {
    const handle = fakeEngine({
      name: "missing-tool",
      probe: async () => ({ available: false, reason: "not installed" }),
    });
    const report = await runBenchmark({
      iterations: 1,
      warmup: 0,
      scenarios: ["simple"],
      engineFactory: () => [handle.engine],
    });
    const engine = report.scenarios[0]?.engines[0];
    expect(engine?.status).toBe("skipped");
    expect(engine?.skipReason).toBe("not installed");
    expect(engine?.error).toBeUndefined();
    expect(handle.counts.run).toBe(0);
    expect(handle.counts.cleanup).toBe(1);
  });

  it("marks a throwing probe as failed rather than silently skipping", async () => {
    const handle = fakeEngine({
      name: "broken-probe",
      probe: async () => {
        throw new Error("probe exploded");
      },
    });
    const report = await runBenchmark({
      iterations: 1,
      warmup: 0,
      scenarios: ["simple"],
      engineFactory: () => [handle.engine],
    });
    const engine = report.scenarios[0]?.engines[0];
    expect(engine?.status).toBe("failed");
    expect(engine?.error).toContain("probe failed");
    expect(engine?.error).toContain("probe exploded");
    expect(handle.counts.cleanup).toBe(1);
  });

  it("captures a mid-measurement failure with its partial samples and still cleans up", async () => {
    let call = 0;
    const handle = fakeEngine({
      run: async () => {
        call += 1;
        if (call >= 3) throw new Error("renderer died");
        return { ms: call * 10, outputBytes: 50 };
      },
    });
    const report = await runBenchmark({
      iterations: 5,
      warmup: 0,
      scenarios: ["simple"],
      engineFactory: () => [handle.engine],
    });
    const engine = report.scenarios[0]?.engines[0];
    expect(engine?.status).toBe("failed");
    expect(engine?.error).toContain("renderer died");
    expect(engine?.runs).toEqual([10, 20]); // completed samples are kept, honestly partial
    expect(engine?.stats?.maxMs).toBe(20);
    expect(handle.counts.cleanup).toBe(1);
  });

  it("rejects out-of-range options with typed INVALID_INPUT", async () => {
    await expectInvalidInputAsync(() => runBenchmark({ iterations: 0 }));
    await expectInvalidInputAsync(() => runBenchmark({ iterations: 1.5 }));
    await expectInvalidInputAsync(() => runBenchmark({ warmup: -1 }));
    await expectInvalidInputAsync(() => runBenchmark({ scenarios: ["nope"] }));
    await expectInvalidInputAsync(() =>
      runBenchmark({ engines: ["nope"], engineFactory: () => [fakeEngine().engine] }),
    );
  });

  it("runs only the selected scenarios and engines, in the requested order", async () => {
    const first = fakeEngine({ name: "alpha" });
    const second = fakeEngine({ name: "beta" });
    const discarded = fakeEngine({ name: "gamma" });
    const report = await runBenchmark({
      iterations: 1,
      warmup: 0,
      scenarios: ["print-css"],
      engines: ["beta", "alpha"],
      engineFactory: () => [first.engine, second.engine, discarded.engine],
    });
    expect(report.scenarios).toHaveLength(1);
    expect(report.scenarios[0]?.scenario).toBe("print-css");
    expect(report.scenarios[0]?.engines.map((engine) => engine.engine)).toEqual(["beta", "alpha"]);
    expect(first.counts.run).toBe(1);
    expect(second.counts.run).toBe(1);
    expect(discarded.counts.run).toBe(0); // never selected → never runs
  });

  it("streams progress, propagates browser version, and fills in metadata", async () => {
    const progress: string[] = [];
    const handle = fakeEngine({ browserVersion: () => "156.0.1" });
    const report = await runBenchmark({
      iterations: 1,
      warmup: 0,
      scenarios: ["simple"],
      engineFactory: () => [handle.engine],
      onProgress: (message) => progress.push(message),
    });
    expect(progress.some((line) => line.includes("simple"))).toBe(true);
    expect(progress.some((line) => line.includes("fake"))).toBe(true);
    expect(report.meta.tool).toBe("dom2pdf-benchmark");
    expect(report.meta.version).toMatch(/^\d+\.\d+\.\d+/);
    expect(report.meta.chromiumVersion).toBe("156.0.1");
    expect(report.meta.platform).toBeTruthy();
    expect(report.meta.nodeVersion).toBe(process.version);
    expect(Date.parse(report.meta.startedAt)).not.toBeNaN();
    expect(Date.parse(report.meta.finishedAt)).not.toBeNaN();
  });

  it("exports the four engine names the CLI validates against", () => {
    expect([...ENGINE_NAMES]).toEqual(["dom2pdf", "playwright-raw", "html2pdf.js", "weasyprint"]);
  });
});
