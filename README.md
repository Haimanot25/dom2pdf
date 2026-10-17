<div align="center">

# dom2pdf

**HTML → PDF, with receipts.**

Convert modern web pages to searchable, selectable PDFs with Chromium — and
get a quality report explaining what happened.

[![CI](https://github.com/Haimanot25/dom2pdf/actions/workflows/ci.yml/badge.svg)](https://github.com/Haimanot25/dom2pdf/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/dom2pdf-js?label=npm&color=cb3837)](https://www.npmjs.com/package/dom2pdf-js)
[![node](https://img.shields.io/badge/node-%E2%89%A522.13-339933)](https://nodejs.org)
[![license](https://img.shields.io/badge/license-MIT-2ea44f)](LICENSE)

</div>

---

## Why dom2pdf?

- **⏳ Wait intelligently** — lazy-loaded content, fonts, images, and pages
  that never fully settle are handled by a readiness phase, not your scripts.
- **🔍 Verify the output** — rendered PDF pages are compared against a browser
  reference with measurable fidelity scores, where verification is possible.
- **🧾 Debug failures** — a failed conversion carries diagnostics (console,
  network, DOM, screenshot), not an empty error message.
- **🎚️ Control quality** — limits and quality policies reject outputs that
  miss your expectations (`QUALITY_POLICY_FAILED`, with evidence attached).
- **🛡️ Protect your environment** — URL restrictions, resource caps, and
  local-file allowlists enforced at the network layer by default.
- **🔁 Reproduce results** — deterministic byte-stable output under
  [documented conditions](#honest-limits) for repeatable testing.

## Sound familiar?

Your Puppeteer one-liner "works" — until it doesn't:

- Lazy-loaded sections print as **blank space** nobody sees until the customer
  complains.
- A web font hangs, a fallback sneaks in, and the report looks **off-brand**.
- A table row gets **sliced in half** across a page break.
- A hung image request burns the whole timeout and the run **dies at 3 a.m.**
- The script exits `0`, bytes are written — and the PDF bears **no resemblance**
  to the page. You find out from an email, not from code.

The browser will print whatever is on screen, including its mistakes. What's
missing isn't a renderer — Chromium is excellent — it's everything around it:
waiting, guarding, verifying, and telling the truth about what happened.

## A real conversion, a real report

This is the **actual output** of converting a 5-page test document on the
reference machine (environment below; field layout re-wrapped for width, no
value changed):

```bash
dom2pdf convert fixtures/long-document.html -o sample.pdf --json
```

```json
{
  "status": "succeeded",
  "durationMs": 4296,
  "timings": { "readinessMs": 1690, "renderMs": 201 },
  "mode": "document",
  "browser": { "name": "chromium", "version": "156.0.8078.4" },
  "pdf": { "byteLength": 54109, "pageCount": 5, "headerVersion": "1.4" },
  "checks": [
    { "id": "pdf-structure", "status": "pass",
      "detail": "PDF parsed successfully: 5 page(s), 54109 bytes, header %PDF-1.4" },
    { "id": "readiness", "status": "pass",
      "detail": "ready in 1690ms: lazy sweep 7 steps, fonts settled, network idle 300ms" },
    { "id": "resources", "status": "pass",
      "detail": "no failed requests, HTTP errors, broken images, or slow resources" },
    { "id": "pdf-text", "status": "pass",
      "detail": "9240 extractable character(s) across 5 page(s)" },
    { "id": "render.fidelity", "status": "pass",
      "detail": "mean SSIM 0.975 across 3 sampled page(s) (worst: page 2 at 0.957; threshold 0.800)" },
    { "id": "security.requests", "status": "pass",
      "detail": "0 http(s) request(s) intercepted and checked against destination policy (limit 500)" }
  ],
  "warnings": [],
  "fidelity": {
    "status": "measured",
    "score": 0.9752,
    "threshold": 0.8,
    "sampledPages": [1, 2, 3],
    "pages": [
      { "page": 1, "ssim": 0.9839, "phashDistance": 6, "alignmentOffsetPx": 0,   "alignCorrelation": 0.9832 },
      { "page": 2, "ssim": 0.9566, "phashDistance": 8, "alignmentOffsetPx": -11, "alignCorrelation": 0.931 },
      { "page": 3, "ssim": 0.985,  "phashDistance": 2, "alignmentOffsetPx": -55, "alignCorrelation": 0.9851 }
    ],
    "durationMs": 1925
  }
}
```

How to read it:

- **`checks[]`** — `pass` / `warn` / `fail` / `skipped`. A `skipped` check
  always carries the reason; scores are never fabricated to look like a pass.
- **`warnings[]`** — each labeled `observed` (a measured fact, e.g. a request
  really did fail) or `heuristic` (an estimate, e.g. fixed elements *may*
  overlap). Codes are stable — branch on them.
- **`fidelity.score`** — mean SSIM (0–1) across sampled pages against
  same-session reference screenshots. Below `threshold` (default `0.8`) you
  get a `fidelity.low-score` warning, not a hard failure. Want it to fail?
  `quality: { failOnWarnings: true }`.
- **`timings`** — how the wall clock was spent (readiness vs. render).

## Measured performance

Not claims — actual `dom2pdf benchmark` output from this repository
(2026-10-17, reference machine below):

```bash
pnpm benchmark --iterations 5 --warmup 1 --scenarios simple
```

```text
simple — one-page article — fixed per-conversion overhead
  dom2pdf         median 1045ms  (min 946, max 1746, p95 1746)  output 33.0 KB
  playwright-raw  median 101ms   (min 93,  max 119,  p95 119)   output 33.0 KB
  html2pdf.js     median 121ms   (min 112, max 137,  p95 137)   output 256.6 KB
  weasyprint      skipped — WeasyPrint not found on PATH … never estimated

meta: win32 x64 · 8 cpu(s) · 11th Gen Intel(R) Core(TM) i7-1165G7 @ 2.80GHz
      · node v24.18.0 · chromium 156.0.8078.4 · 9792ms total
```

Reading it honestly:

- The `simple` scenario isolates **fixed per-conversion overhead**: fresh
  browser context, readiness checks, fidelity verification, and PDF
  inspection. dom2pdf pays ~1s for that on a trivial one-page article — on
  heavier pages the fraction shrinks.
- dom2pdf and raw Playwright use the same engine, so the outputs match at
  33.0 KB. html2pdf.js's 256.6 KB is an image-based PDF (text is not
  selectable).
- WeasyPrint, when not installed, is reported as **skipped — never estimated**.
- Your machine will produce different numbers; reproduce with the command
  above (`dom2pdf benchmark --help` for scenarios, iterations, JSON output).

## How a conversion works

```text
  URL / HTML / file
        │
  ┌─────▼──────┐  validate input, reject unknown options,
  │ pre-flight │  arm destination policy (SSRF guard) + limits
  ├────────────┤
  │  navigate  │  one shared deadline governs everything below
  ├────────────┤
  │  readiness │  lazy-load sweep · infinite-scroll drain ·
  │            │  reveal-on-scroll · fonts · images ·
  │            │  per-resource patience · network settle
  ├────────────┤
  │   render   │  animations settled · print CSS ·
  │            │  optional object-aware pagination
  ├────────────┤
  │  verify    │  PDF re-rasterized → per-page SSIM vs the
  │            │  live page at the same print layout
  ├────────────┤
  │  report    │  checks · warnings · timings · fidelity
  └────────────┘  an honest "skipped" beats a fabricated score
```

## Install

```bash
npm i dom2pdf-js        # library — installs a pinned Chromium build
npm i -g dom2pdf-cli    # CLI — the `dom2pdf` command
```

Node.js ≥ 22.13. pnpm/yarn work the same way.

| Package | What it is |
| --- | --- |
| [`dom2pdf-js`](https://www.npmjs.com/package/dom2pdf-js) | The library — `createConverter()` and every option/type |
| [`dom2pdf-cli`](https://www.npmjs.com/package/dom2pdf-cli) | Installs the `dom2pdf` command: `convert`, `inspect`, `benchmark` |
| [`dom2pdf-benchmark`](https://www.npmjs.com/package/dom2pdf-benchmark) | The deterministic benchmark harness behind `dom2pdf benchmark` (pulled in by the CLI) |
| `dom2pdf-web` | The local web UI — run from the repo (`pnpm web`), not published |

## First conversion

**CLI**

```bash
dom2pdf convert https://example.com -o example.pdf
dom2pdf convert ./invoice.html --format A4 --margin 15mm --json
dom2pdf inspect example.pdf          # pages, bytes, text stats of any PDF
dom2pdf benchmark --iterations 3     # deterministic multi-engine benchmark
```

**Library**

```ts
import { createConverter, isDom2PdfError } from "dom2pdf-js";

const converter = await createConverter();
try {
  const result = await converter.convert({
    input: { type: "url", url: "https://example.com/report" },
    pdf: { format: "A4", printBackground: true },
    readiness: { timeoutMs: 30_000 },
    quality: { minTextChars: 500, maxPages: 10 }, // reject near-empty output
  });
  await result.save("./report.pdf");
  console.log(result.report.fidelity);
  // → { status: "measured", score: 0.9752, threshold: 0.8, … }
} catch (error) {
  // Stable codes to branch on: READINESS_TIMEOUT, BLOCKED_URL, …
  if (isDom2PdfError(error)) console.error(error.code, error.message);
  throw error;
} finally {
  await converter.close();
}
```

Inputs: `{ type: "url", url }` · `{ type: "html", html, baseUrl? }` ·
`{ type: "file", path }` (opt-in allowlist). Conversions accept an
`AbortSignal` and fail fast with `CANCELLED`.

**Local web UI**

```bash
git clone https://github.com/Haimanot25/dom2pdf && cd dom2pdf
pnpm install && pnpm build
pnpm web                              # http://127.0.0.1:8787
```

![dom2pdf web UI — initial state](https://raw.githubusercontent.com/Haimanot25/dom2pdf/master/docs/assets/webui-initial.png)

![dom2pdf web UI — conversion result with quality report](https://raw.githubusercontent.com/Haimanot25/dom2pdf/master/docs/assets/webui-result.png)

A dark-first single page (light mode follows your system preference): paste a
URL, flip options, download the PDF, read the report. The full security policy
applies — the UI cannot escalate anything.

**Docker**

```bash
docker build -t dom2pdf .
docker run --rm -v "$PWD:/work" dom2pdf convert https://example.com -o /work/out.pdf
```

## What you actually get

**⏳ Readiness that understands the modern web.** Before printing, dom2pdf
walks scrollable pages to trigger `loading="lazy"` content, infinite-scroll
feeds, and reveal-on-scroll animations — the patterns that otherwise print as
blank space. It waits for fonts and images, and gives each slow resource its
own patience (`slowResourceMs`) so one hung asset costs a warning, not the
run. Pages that never settle are handled explicitly: a chatty network
(analytics beacons) ends the wait at its stage budget with an observed
`readiness.network-unsettled` warning, while a stage with real work still in
flight past `readiness.timeoutMs` fails with `READINESS_TIMEOUT` naming the
stage — never a silent bad PDF.

**🔍 Output verified against reality — within honest bounds.** Sampled pages
of the produced PDF are re-rasterized inside Chromium and compared, page by
page, against screenshots of the live page (SSIM + perceptual hash +
alignment). The reference screenshots are taken in the **same browser
session**, immediately after rendering, under the same media emulation, with
animations fast-forwarded to their settled end state — so session state and
animation timing match. What no control can eliminate: pages that
personalize per paint (randomized ads, rotated banners, live clocks) can
still differ between the PDF and the reference. When they do, you get a
measured score and — below your `threshold` — a warning; never a fabricated
pass. Tune `threshold`/`samplePages`, or set `fidelity.enabled: false` for
inherently dynamic pages. Unverifiable layouts (header/footer templates,
unmappable `pageRanges`) report `skipped` with the reason.

**🧾 Failure forensics.** Set `diagnostics: true` and a failed conversion
attaches the console transcript, network log, DOM, and a screenshot of what
the page was doing at that moment (`error.details.diagnostics`; the CLI
writes it to `<output>.diag/` with `--diagnostics`; always on in the web
UI). Debugging from the error message alone is over.

**🔁 Byte-identical reruns — under stated conditions.** `deterministic: true`
zeroes Chromium's two PDF date stamps in place (byte-length-preserving), so
repeated conversions of the **same input** on the **same Chromium build** are
byte-identical — `report.deterministic` confirms it with a content digest
over extracted page text. Two honest caveats: if a date span can't be
normalized you get a `determinism.residual` warning (bytes may differ — never
hidden); and if the source itself changes — a live URL serving different
markup, rotated ads, new timestamps in the page — the bytes change
accordingly. That's content variance, and the digest is how you tell it
apart from nondeterminism.

**🧱 Object-aware pagination.** Opt in with
`pagination: { keepTogether: true }` (CLI `--keep-together`): page-fitting
tables, figures, images, videos, code blocks, and standalone SVGs stay whole
across breaks; a table row that fits within one page is pushed whole instead
of being clipped at a page edge (rows taller than a page still break —
forced breaks override avoidance); and tables whose `<thead>` was overridden
to `table-row-group` get their headers repeated on continuation pages. Off by
default, so pagination is byte-for-byte unchanged unless you ask. The
`render.pagination` check reports what was kept, what repeats, and what was
skipped (with the reason).

**🛡️ Secure by default.** Chromium's sandbox stays **on** (Playwright's own
default disables it; dom2pdf explicitly passes `chromiumSandbox: true`).
Private, loopback, and link-local destinations are blocked unless explicitly
allowed — the page, its subresources, page-scripted navigations, and
redirect targets included. Local file reads require an explicit directory
allowlist, with symlink-escape detection after path resolution. Unknown
options are rejected (`UNSUPPORTED_OPTION`), never silently ignored. See
[Security posture](#security-posture--read-the-boundaries) for the
enforcement boundaries.

**📊 Benchmark harness included.** `dom2pdf benchmark` compares dom2pdf
against raw Playwright, html2pdf.js, and WeasyPrint on deterministic fixtures
— with strict methodology rules and honest skips when an engine isn't
available.

## Rendering modes

| Mode | What it does | Output policy |
| --- | --- | --- |
| `document` (default) | Print CSS media; your `@page` and print styles apply | paper config: `format`/`width`/`height`, `margin`, `landscape`, `scale` |
| `screen` | Screen CSS media at your viewport, paginated onto paper | `paper-fit`: viewport scaled exactly onto the paper width (`viewport-pages`/`full-content` reserved for later) |

## How it compares

**Built-in** = dom2pdf ships it as a tested, end-to-end workflow.
**Your code** = the ecosystem can do it, but you assemble, maintain, and
debug it yourself. Compiled from each project's public documentation
(Oct 2026) — verify what matters to you.

| Capability | **dom2pdf** | [Puppeteer](https://pptr.dev) / [Playwright](https://playwright.dev/docs/api/class-page#page-pdf) `page.pdf()` | [Gotenberg](https://gotenberg.dev/) | [WeasyPrint](https://doc.courtbouillon.org/weasyprint/stable/) | [wkhtmltopdf](https://wkhtmltopdf.org/) | [html2pdf.js](https://github.com/eKoopmans/html2pdf.js) |
| --- | --- | --- | --- | --- | --- | --- |
| Renderer | pinned Chromium | your Chromium | Chromium (Docker) | Python, no JS engine | Qt WebKit (unmaintained) | html2canvas → **image** |
| Runs the page's JS | ✓ | ✓ | ✓ | ✗ | partial | only what already ran |
| Waits for lazy / infinite-scroll content | ✓ built-in | your code | your code | n.a. | n.a. | your code |
| Hung asset ≠ failed run (per-resource patience) | ✓ built-in | your code | your code | n.a. | n.a. | n.a. |
| PDF re-verified against the live page | ✓ SSIM | your code | your code | your code | your code | your code |
| Structured quality report | ✓ | your code | your code | your code | your code | your code |
| Failure forensics bundle (DOM + screenshot + console) | ✓ | your code | your code | your code | your code | your code |
| Byte-reproducible output option | ✓ | your code | your code | your code | your code | your code |
| Text in output selectable & searchable | ✓ | ✓ | ✓ | ✓ | ✓ | ✗ (rasterized) |
| SSRF guard + sandbox-on default | ✓ | sandbox off by default | deployment's job | n.a. | n.a. | n.a. |
| Interfaces | library · CLI · local web UI | library | HTTP API (Docker) | Python library | CLI | browser library |

"n.a." = the pipeline has no browser. If you hand-author print CSS and need
full CSS Paged Media — generated content, running headers, cross-references —
commercial engines like [Prince](https://www.princexml.com/) or
[Antenna House](https://www.antennahe.com/) remain the right tool. dom2pdf is
for converting **the web you don't control**, in Node, with verification
attached.

## Security posture — read the boundaries

Chromium sandbox on; `http`/`https` only; loopback, private, and
link-local/metadata destinations blocked unless explicitly allowed; every
subresource, page-scripted navigation, and redirect target classified at the
network layer before it completes; local files opt-in by resolved path;
request caps; a fresh isolated browser context per conversion.

The full layer-by-layer description — **including the residual risks** — is
in [docs/security.md](docs/security.md). The short version: redirect hops
are followed by Chromium's own network stack before classification lands,
hostname-based checks are advisory against DNS rebinding, and for untrusted
workloads the real perimeter is infrastructure egress policy plus container
isolation. dom2pdf's in-process checks are one layer, not the perimeter.

## Who is this for

- **Invoice / receipt / statement generators** where print CSS fidelity is the product
- **Report exporters** turning dashboards into client-ready PDFs
- **Archival & audit pipelines** that need byte-stable, reproducible artifacts
- **Security-conscious teams** converting untrusted URLs behind strict defaults
- **Anyone whose Puppeteer one-liner grew teeth** and now needs deadlines,
  limits, and evidence instead of hope

## Honest limits

Said out loud, because the tool's job is telling you the truth:

- **Alpha.** `v0.1.0-alpha.x` — the API may move in minor releases; error
  codes may be added. Pin your version.
- **Not pixel-perfect.** Fidelity is an SSIM heuristic: great at catching
  blank sections, broken fonts, and mangled layout; a score near the
  threshold is a judgment call, which is why the threshold is yours to set.
  Pages with per-paint randomness (ads, clocks, rotation) can score low
  without a rendering defect — see the fidelity section above.
- **Determinism has conditions** — same input, same Chromium build,
  successful date normalization (reported as `determinism.residual`
  otherwise). A live URL returning different content produces different
  bytes; that's the content, not the engine.
- **`screen` mode** implements `paper-fit`; `viewport-pages` and
  `full-content` are reserved in the schema and rejected with
  `UNSUPPORTED_OPTION` until they ship. No feature is documented here before
  it works.
- **Pagination scope** — `keepTogether` marks only objects that fit one page;
  closed shadow DOM and cross-origin iframe interiors are not scanned; kept
  objects move content across pages, so fidelity on affected pages can score
  lower than the unpaginated reference.
- **Chromium needs a real OS environment** — use the provided Dockerfile on
  serverless.

## Errors & exit codes

Every failure is a `Dom2PdfError` with a stable `code` you can branch on:
`INVALID_INPUT` · `UNSUPPORTED_OPTION` · `BLOCKED_URL` · `BLOCKED_REDIRECT` ·
`BLOCKED_RESOURCE` · `LOCAL_FILE_NOT_ALLOWED` · `NAVIGATION_FAILED` ·
`READINESS_TIMEOUT` (names the stage) · `RENDER_TIMEOUT` ·
`PDF_VALIDATION_FAILED` · `RESOURCE_LIMIT_EXCEEDED` · `QUALITY_POLICY_FAILED` ·
`BROWSER_FAILURE` · `CANCELLED` · `CONVERTER_CLOSED`.

CLI exit codes: `0` ok · `2` usage · `3` conversion failed · `4` quality
policy rejected · `130` SIGINT. Full table: [docs/api.md](docs/api.md).

## Documentation

- [Getting started](docs/getting-started.md) — build, first conversion, CLI basics
- [Rendering modes](docs/modes.md) — `document` vs `screen`, output policies, paper-fit math
- [API reference](docs/api.md) — every option, report checks/warnings, error codes
- [CLI reference](docs/cli.md) — commands, flags, JSON formats, exit codes
- [Security](docs/security.md) — enforced layers, boundaries, and residual risks
- [Benchmark](docs/benchmark.md) — deterministic multi-engine methodology and honesty rules
- [Releasing](docs/releasing.md) — versioning, the gate, publishing

## Contributing

Bug reports and PRs welcome — [open an issue](https://github.com/Haimanot25/dom2pdf/issues).
For a conversion that misbehaves, attach the `--json` report and a
`--diagnostics` bundle; that is usually enough to find it. For feature
requests, an issue first keeps duplicates and dead ends out. Dev setup, the
test gate, and PR expectations: [CONTRIBUTING.md](CONTRIBUTING.md).

## Development

```bash
git clone https://github.com/Haimanot25/dom2pdf && cd dom2pdf
pnpm install
pnpm browser:install        # provision the pinned Chromium build
pnpm lint && pnpm typecheck
pnpm test:unit              # vitest
pnpm test:e2e               # playwright test (real browser conversions)
pnpm build
```

CI runs the full gate on every change.

## Roadmap

All nine numbered phases plus the local web UI milestone are shipped and
tested (see [CHANGELOG](CHANGELOG.md)): rendering modes, readiness &
adaptive patience, quality checks/policies, CLI, request-layer security &
limits, benchmark, local web UI, verified output, scroll-driven content,
object-aware pagination.

Next up: the reserved `screen` output policies (`viewport-pages`,
`full-content`), then 1.0 API freeze. No feature is documented here before it
works.

## License

[MIT](LICENSE) — contributions welcome.
