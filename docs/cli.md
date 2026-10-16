# CLI reference

The `dom2pdf` binary lives in `apps/cli` and contains **no conversion or
benchmark logic** — `convert` and `inspect` delegate to the `dom2pdf-js`
library, `benchmark` to `dom2pdf-benchmark`. In this repository run it as
`pnpm dom2pdf …`.

## Exit codes (stable contract)

| Code | Meaning |
| --- | --- |
| `0` | Success (a benchmark with `skipped` engines is still success) |
| `2` | Usage error: unknown command/flag, missing or invalid argument |
| `3` | Conversion/inspection failed with a typed error; benchmark failed (a required engine errored) |
| `4` | Output rejected by a configured quality policy |
| `130` | Cancelled with Ctrl-C (128 + SIGINT) |

## `dom2pdf convert [source]`

`source` is an `http(s)` URL or a local file path. Use `--stdin` instead to
read HTML from a pipe. Anything with a URL scheme (`ftp://…`) is sent to the
library as a URL and rejected there with `BLOCKED_URL` (exit 3), not a usage
error.

```bash
dom2pdf convert https://example.com -o example.pdf
dom2pdf convert ./report.html -o report.pdf --format A4 --margin 15mm
cat page.html | dom2pdf convert --stdin -o out.pdf
dom2pdf convert ./dashboard.html --mode screen --viewport 1440x900
dom2pdf convert ./invoice.html --min-pages 1 --max-pages 4 --json > report.json
```

### Flags

**Output**

| Flag | Meaning |
| --- | --- |
| `-o, --output <path>` | Output path (default `dom2pdf.pdf`) |
| `--json` | Print the quality report as JSON on stdout (errors as JSON on stderr) |
| `--quiet` | Suppress success output; errors still go to stderr |

**Rendering**

| Flag | Maps to |
| --- | --- |
| `--mode document\|screen` | `mode` |
| `--format <A4…>` | `pdf.format` |
| `--landscape` | `pdf.landscape` |
| `--scale <0.1–2>` | `pdf.scale` (document mode only) |
| `--margin <spec>` | `pdf.margin` — one value (`15mm`) or `top,right,bottom,left` |
| `--page-ranges <"1-5, 8">` | `pdf.pageRanges` |
| `--prefer-css-page-size` | `pdf.preferCSSPageSize` |
| `--no-print-background` | `pdf.printBackground: false` |
| `--outline`, `--tagged` | `pdf.outline`, `pdf.tagged` |
| `--viewport <WxH>` | `viewport` |

**Readiness / quality**

| Flag | Maps to |
| --- | --- |
| `--timeout <ms>` | `readiness.timeoutMs` |
| `--render-timeout <ms>` | `render.timeoutMs` |
| `--min-pages`, `--max-pages` | `quality.minPages/maxPages` |
| `--min-text-chars <n>` | `quality.minTextChars` |
| `--max-bytes <n>` | `quality.maxBytes` |
| `--fail-on-warnings` | `quality.failOnWarnings` |
| `--diagnostics` | `diagnostics: true` — on failure, forensics (console, requests, DOM, screenshot) are written next to the output as `<output>.diag/` |
| `--deterministic` | `deterministic: true` — PDF date stamps are zeroed in place so repeated conversions produce byte-identical files (same browser build); the summary prints the content digest |
| `--keep-together` | `pagination.keepTogether: true` — object-aware pagination: page-fitting tables/images/code blocks stay whole across page breaks, rows are never clipped at a page edge, overridden table headers repeat |

**Security**

| Flag | Maps to |
| --- | --- |
| `--allow-loopback` | `security.allowLoopback` |
| `--allow-private-network` | `security.allowPrivateNetwork` |

**Limits** (each violation exits `3` with `RESOURCE_LIMIT_EXCEEDED`)

| Flag | Maps to |
| --- | --- |
| `--max-requests <n>` | `limits.maxRequests` — http(s) requests per conversion (default 500) |
| `--max-output-bytes <n>` | `limits.maxOutputBytes` — hard cap on the generated PDF |
| `--max-concurrent <n>` | `createConverter({ limits: { maxConcurrentConversions } })` |

Local files need no flag: passing a path on the command line is explicit
consent, and the CLI grants only **that file's own directory**
(`allowLocalFiles` + an allowlist of `dirname(source)`); the library still
verifies the resolved path (symlinks included).

### Cancellation

Ctrl-C (SIGINT) aborts the in-flight conversion: the browser context is
cleaned up and the process exits `130` with `CANCELLED` on stderr.

## `dom2pdf inspect <file>`

Structurally inspects an existing PDF using the library's inspector:

```bash
dom2pdf inspect report.pdf
# report.pdf: 3 page(s) · 45.2 KB · %PDF-1.4
#   text: 12345 character(s) across 3 page(s) · empty pages: none

dom2pdf inspect report.pdf --json
```

`--json` prints:

```json
{
  "file": "…/report.pdf",
  "byteLength": 46312,
  "pageCount": 3,
  "headerVersion": "1.4",
  "text": { "totalChars": 12345, "perPageChars": [4001, 4398, 3946], "emptyPages": [] }
}
```

A missing or unreadable file exits `3` (`INVALID_INPUT`).

## `dom2pdf benchmark`

Runs the deterministic multi-engine benchmark (dom2pdf, raw Playwright,
html2pdf.js, WeasyPrint) — methodology, engines, and honesty rules are
documented in [Benchmark](benchmark.md).

```bash
dom2pdf benchmark                                   # full suite, human table
dom2pdf benchmark --json > report.json              # machine-readable report
dom2pdf benchmark --iterations 3 --warmup 1         # timing controls
dom2pdf benchmark --scenarios simple --engines dom2pdf,weasyprint
dom2pdf benchmark --output report.json              # also write the JSON file
```

| Flag | Default | Maps to |
| --- | --- | --- |
| `--iterations <n>` | `5` | measured runs per engine/scenario |
| `--warmup <n>` | `1` | warm-up runs excluded from statistics |
| `--scenarios <list>` | all | comma-separated scenario names (unknown → exit 2) |
| `--engines <list>` | all | comma-separated engine names (unknown → exit 2) |
| `--output <path>` | — | write the JSON report to a file |
| `--json` | — | print the JSON report on stdout (progress stays off stdout) |

A missing external tool is an honest **skip** (`status: "skipped"` with the
install hint), not an error. The command exits `3` only when a *required*
engine — `dom2pdf` or its `playwright-raw` baseline — fails on a scenario.

## JSON formats

- **Success:** the quality report (see [API](api.md#quality-report)) on
  **stdout** — for `benchmark`, the full [benchmark report](benchmark.md).
- **Failure:** `{"error": {"name","code","message","details?"}}` on
  **stderr** — for quality failures `details` carries the `violations` and
  the full measured `report`.

Stdout therefore stays machine-parseable in both directions: the report on
success, nothing on failure.
