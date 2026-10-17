<div align="center">

# dom2pdf

**HTML → PDF, with receipts.**

Waits until the page is *actually* ready, prints it with Chromium, then
re-opens the PDF and checks it against the live page. Every conversion ends in
a measured quality report — never a hopeful exit 0.

[![CI](https://github.com/Haimanot25/dom2pdf/actions/workflows/ci.yml/badge.svg)](https://github.com/Haimanot25/dom2pdf/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/dom2pdf-js?label=npm&color=cb3837)](https://www.npmjs.com/package/dom2pdf-js)
[![node](https://img.shields.io/badge/node-%E2%89%A522.13-339933)](https://nodejs.org)
[![license](https://img.shields.io/badge/license-MIT-2ea44f)](LICENSE)

</div>

---

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

**That's the whole product.** dom2pdf wraps the print in a pipeline that ends
in evidence:

```jsonc
// result.report — trimmed; every field measured, every skip explained
{
  "status": "succeeded",
  "durationMs": 2841,
  "timings": { "readinessMs": 903, "renderMs": 612 },
  "mode": "document",
  "browser": { "name": "chromium", "version": "156.0.8078.4" },
  "pdf": { "byteLength": 184320, "pageCount": 3, "headerVersion": "1.7" },
  "checks": [
    { "id": "pdf-structure", "status": "pass",
      "detail": "PDF parsed successfully: 3 page(s), 184320 bytes, header %PDF-1.7" },
    { "id": "render.fidelity", "status": "pass", "detail": "…" }
  ],
  "warnings": [
    { "code": "resources.slow", "message": "…", "source": "observed" }
  ],
  "fidelity": { "status": "measured", "score": 0.97, "threshold": 0.8,
                "sampledPages": [1, 2, 3] }
}
```

Numbers are from a representative run; the *shape* is the contract. Want the
PDF rejected when reality misses your expectations? Say so once:

```ts
quality: { minTextChars: 500, maxPages: 4 }
// → QUALITY_POLICY_FAILED, carrying details.violations + the full report
```

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
npm i -g dom2pdf-cli    # CLI — the `dom2pdf` binary
```

Node.js ≥ 22.13. pnpm/yarn work the same way.

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
import { createConverter } from "dom2pdf-js";

const converter = await createConverter();
try {
  const result = await converter.convert({
    input: { type: "url", url: "https://example.com/report" },
    pdf: { format: "A4", printBackground: true },
    readiness: { timeoutMs: 30_000 },
  });
  await result.save("./report.pdf");
  console.log(result.report.fidelity); // { status: "measured", score: 0.97, … }
} finally {
  await converter.close();
}
```

Inputs: `{ type: "url", url }` · `{ type: "html", html, baseUrl? }` ·
`{ type: "file", path }` (opt-in allowlist). Conversions take an
`AbortSignal` and fail fast with `CANCELLED`.

**Local web UI**

```bash
git clone https://github.com/Haimanot25/dom2pdf && cd dom2pdf
pnpm install && pnpm build
pnpm web                              # http://127.0.0.1:8787
```

A dark-first single page: paste a URL, flip options, download the PDF. The full
security policy applies — the UI cannot escalate anything.

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
run. Chatty pages (analytics beacons) don't fail the deadline either — they
end in an honest `readiness.network-unsettled` warning.

**🔍 Output verified against reality.** Sampled pages of the produced PDF are
re-rasterized inside Chromium and compared, page by page, against screenshots
of the live page (SSIM + perceptual hash + alignment). Below your threshold →
a `render.fidelity` warning. Unverifiable layouts report `skipped` with the
reason. Scores are never fabricated, and nothing here claims
pixel-perfection — see [Honest limits](#honest-limits).

**🧾 Failure forensics.** Set `diagnostics: true` and a failed conversion
attaches the console transcript, network log, DOM, and a screenshot of what
the page was doing at that moment (`error.details.diagnostics`; the CLI writes
it to `<output>.diag/` with `--diagnostics`; always on in the web UI). Debugging
from the error message alone is over.

**🔁 Byte-identical reruns.** `deterministic: true` zeroes Chromium's date
stamps in place so repeated conversions on the same browser build are
byte-identical, with a content digest over extracted text for independent
verification. Golden-file tests stop being flaky.

**🧱 Object-aware pagination.** Opt in with `pagination: { keepTogether: true }`
(CLI `--keep-together`): page-fitting tables, figures, images, videos, code
blocks, and standalone SVGs stay whole across breaks, table rows are never
clipped at a page edge, and overridden `<thead>` headers repeat on
continuation pages. Off by default, so pagination is byte-for-byte unchanged
unless you ask.

**🛡️ Secure by default.** Chromium's sandbox stays **on** (Playwright's default
turns it off). Private, loopback, and link-local destinations are blocked
unless explicitly allowed — the page and its subresources, redirects
included. Local file reads require an explicit directory allowlist, with
symlink-escape detection. Unknown options are rejected (`UNSUPPORTED_OPTION`),
never silently ignored.

**📊 Benchmark harness included.** `dom2pdf benchmark` compares dom2pdf against
raw Playwright, html2pdf.js, and WeasyPrint on deterministic fixtures — with
strict methodology rules and honest skips when an engine isn't available.

## Rendering modes

| Mode | What it does | Output policy |
| --- | --- | --- |
| `document` (default) | Print CSS media; your `@page` and print styles apply | paper config: `format`/`width`/`height`, `margin`, `landscape`, `scale` |
| `screen` | Screen CSS media at your viewport, paginated onto paper | `paper-fit`: viewport scaled exactly onto the paper width (`viewport-pages`/`full-content` reserved for later) |

## How it compares

Compiled from each project's public documentation (Oct 2026) — verify what
matters to you.

| | **dom2pdf** | `page.pdf()`<br>Puppeteer / Playwright | Gotenberg | WeasyPrint | wkhtmltopdf | html2pdf.js |
| --- | --- | --- | --- | --- | --- | --- |
| Renderer | pinned Chromium | your Chromium | Chromium (Docker) | Python, no JS engine | Qt WebKit (unmaintained) | html2canvas → **image** |
| Runs the page's JS | ✓ | ✓ | ✓ | ✗ | partial | only what already ran |
| Waits for lazy / infinite-scroll content | ✓ built-in | your code | your code | n.a. | n.a. | your code |
| Hung asset ≠ failed run (per-resource patience) | ✓ | your code | your code | n.a. | n.a. | n.a. |
| PDF re-verified against the live page | ✓ SSIM | — | — | — | — | — |
| Structured quality report | ✓ | — | — | — | — | — |
| Failure forensics bundle (DOM + screenshot + console) | ✓ | — | — | — | — | — |
| Byte-reproducible output option | ✓ | — | — | — | — | — |
| Text in output selectable & searchable | ✓ | ✓ | ✓ | ✓ | ✓ | ✗ (rasterized) |
| SSRF guard + sandbox-on default | ✓ | — / sandbox off | deployment's job | n.a. | n.a. | n.a. |
| Interfaces | library · CLI · local web UI | library | HTTP API (Docker) | Python library | CLI | browser library |

"your code" = the underlying tool can do it, but nothing is built in — that
pile of scripts is exactly what dom2pdf replaces. "n.a." = the pipeline has no
browser.

If you hand-author print CSS and can pay for a license, Prince XML remains the
gold standard — dom2pdf is for converting **the web you don't control**, in
Node, with verification attached.

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
  blank sections, broken fonts, and mangled layout; a score near the threshold
  is a judgment call, which is why the threshold is yours to set.
- **`screen` mode** implements `paper-fit`; `viewport-pages` and `full-content`
  are reserved in the schema and rejected with `UNSUPPORTED_OPTION` until they
  ship. No feature is documented here before it works.
- **Closed shadow DOM** and **cross-origin iframe interiors** are not scanned
  for pagination candidates.
- Kept-together objects move content across pages, so fidelity on affected
  pages can score lower than the unpaginated reference.
- Chromium needs a real OS environment — use the provided Dockerfile on
  serverless.

## Errors & exit codes

Every failure is a `Dom2PdfError` with a stable `code` you can branch on:
`INVALID_INPUT` · `UNSUPPORTED_OPTION` · `BLOCKED_URL` · `BLOCKED_REDIRECT` ·
`BLOCKED_RESOURCE` · `LOCAL_FILE_NOT_ALLOWED` · `NAVIGATION_FAILED` ·
`READINESS_TIMEOUT` (names the stage) · `RENDER_TIMEOUT` ·
`PDF_VALIDATION_FAILED` · `RESOURCE_LIMIT_EXCEEDED` · `QUALITY_POLICY_FAILED` ·
`BROWSER_FAILURE` · `CANCELLED` · `CONVERTER_CLOSED`.

CLI exit codes: `0` ok · `2` usage · `3` conversion failed · `4` quality policy
rejected · `130` SIGINT. Full table: [docs/api.md](docs/api.md).

## Documentation

- [Getting started](docs/getting-started.md) — build, first conversion, CLI basics
- [Rendering modes](docs/modes.md) — `document` vs `screen`, output policies, paper-fit math
- [API reference](docs/api.md) — every option, report checks/warnings, error codes
- [CLI reference](docs/cli.md) — commands, flags, JSON formats, exit codes
- [Security](docs/security.md) — enforced layers and the residual risks we document honestly
- [Benchmark](docs/benchmark.md) — deterministic multi-engine methodology and honesty rules
- [Releasing](docs/releasing.md) — versioning, the gate, publishing

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

All nine foundation phases are shipped and tested (see
[CHANGELOG](CHANGELOG.md)): rendering modes, readiness & adaptive patience,
quality checks/policies, CLI, request-layer security & limits, benchmark,
local web UI, verified output, scroll-driven content, object-aware pagination.

Next up: the reserved `screen` output policies (`viewport-pages`,
`full-content`), then 1.0 API freeze. No feature is documented here before it
works.

## License

[MIT](LICENSE) — contributions welcome.
