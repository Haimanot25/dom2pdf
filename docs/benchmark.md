# Benchmark

`pageforge benchmark` runs a **deterministic** HTML-to-PDF benchmark across
multiple engines and reports honest, machine-readable results. Numbers are
measured, never estimated; engines that cannot run are reported as skipped
with the reason.

## Run it

```bash
# Full suite: 4 scenarios × 4 engines, 5 measured runs each (+1 warm-up)
pageforge benchmark

# Machine-readable JSON on stdout
pageforge benchmark --json > report.json

# Quick smoke / CI-friendly settings
pageforge benchmark --iterations 1 --warmup 0 --scenarios simple

# A subset of scenarios or engines
pageforge benchmark --scenarios print-css,long-document --engines pageforge,playwright-raw
```

From the monorepo: `pnpm benchmark` (builds must exist — `pnpm build` first).

| Flag | Default | Meaning |
| --- | --- | --- |
| `--iterations <n>` | `5` | Measured runs per engine/scenario |
| `--warmup <n>` | `1` | Warm-up runs **excluded** from statistics |
| `--scenarios <list>` | all | Comma-separated scenario names |
| `--engines <list>` | all | Comma-separated engine names |
| `--output <path>` | — | Also write the JSON report to a file |
| `--json` | — | Print the JSON report on stdout (no progress lines) |

Exit codes: `0` completed (skips are results, not errors), `2` usage error,
`3` a **required** engine failed (see below), `130` cancelled with Ctrl-C.

As a library:

```ts
import { runBenchmark, formatReportHuman } from "pageforge-benchmark";

const report = await runBenchmark({ iterations: 3, scenarios: ["simple"] });
console.log(formatReportHuman(report));
```

## Engines

| Engine | What it is | Notes |
| --- | --- | --- |
| `pageforge` | PageForge's full pipeline (isolated context, request policy, readiness, quality report) | required — its failure exits 3 |
| `playwright-raw` | `setContent` + `page.pdf()` on the same pinned Chromium | required baseline — isolates what PageForge's pipeline adds |
| `html2pdf.js` | html2canvas + jsPDF running **inside** the same Chromium | informational comparator |
| `weasyprint` | WeasyPrint CLI as an external process | skipped with an install hint when absent |

**Required vs. informational.** If `pageforge` or `playwright-raw` fails on any
scenario the command exits `3` (the comparison pair is the point of the
suite). Comparator failures are recorded in the report (`status: "failed"`
with the error) but do not fail the command.

**WeasyPrint is never fabricated.** When the CLI is not on `PATH`, the engine
comes back `skipped` with `skipReason` explaining how to install it — never
plausible-looking numbers. Install it (`pip install weasyprint`) and rerun to
include it.

## Scenarios

All fixtures are generated from fixed inputs — self-contained HTML, inline
CSS, no network — so the workload is byte-identical on every call and every
machine:

| Scenario | Workload |
| --- | --- |
| `simple` | One-page article — fixed per-conversion overhead |
| `long-document` | 120 deterministic paragraphs — pagination-dominated |
| `print-css` | `@page` rules, forced breaks, tables — document-mode print pipeline |
| `screen-dashboard` | CSS-grid dashboard (PageForge renders it in `screen` mode) |

## How to read the results

- **Wall-clock only.** `runs` are raw milliseconds per conversion (including
  page/context setup inside the timed window); `stats` adds
  min/median/max/p95 (nearest-rank, no interpolation). Every report includes
  the raw samples so you can recompute.
- **First run vs. steady state.** Browser launches happen lazily and are
  excluded by the default warm-up (`--warmup 0` includes them — that is a
  deliberate choice for cold-start questions).
- **Bytes are per-engine, not cross-engine.** html2pdf.js rasterizes pages
  (JPEG), so its outputs are much larger; PageForge and `playwright-raw`
  produce native vector PDFs of near-identical size for the same scenario —
  a useful sanity check that the baseline really is the same renderer.
- **Comparisons are only meaningful on the same machine**, same run.
  Benchmarks are *not* run in CI and no numbers are published from CI runs —
  noisy shared runners produce confident-looking nonsense.

## Honesty rules (what this suite will never do)

1. No estimated or interpolated results for engines that did not run.
2. No silent failures: every engine/scenario cell is `ok`, `skipped`
   (with reason), or `failed` (with error) — never absent.
3. No hidden tuning: engine configurations are fixed in source and visible
   in the report; scenarios are deterministic.
4. No cross-machine claims: `meta` records platform, CPU, Node, and Chromium
   versions so a number always travels with its context.
