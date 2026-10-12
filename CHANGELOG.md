# Changelog

All notable changes to PageForge are documented here. Versions follow
[semver](https://semver.org/); until `1.0.0` the API may move in minor
versions, and **error codes may be added in minor releases** (treat unknown
codes as generic failures).

## 0.1.0-alpha.0 (unreleased)

First public alpha — the six-phase foundation, in order:

### Phase 1 — Foundation
- pnpm workspace: `pageforge-pdf` (core), `pageforge-cli`, `pageforge-benchmark`.
- Strict TypeScript everywhere, ESLint flat config, pinned Playwright 1.64.0.
- URL/HTML/file → PDF through Chromium's native `page.pdf()`; typed errors
  with stable codes; `Deadline`; isolated browser manager.

### Phase 2 — Core rendering
- `screen` mode with the `paper-fit` output policy (paper-uniform scale,
  never upscales); `document` mode with print CSS, paper/margins/scale.
- Cancellation via `AbortSignal`; capture/paper modules; layout analysis and
  renderer diagnostics.

### Phase 3 — Readiness & quality
- Readiness phase (fonts, images, network idle, selector, settle) under a
  single deadline; observed resource diagnostics; text-extraction checks;
  structured quality report; `QUALITY_POLICY_FAILED` policies.

### Phase 4 — CLI & documentation
- `pageforge convert|inspect` with `--json`/`--quiet`, stable exit codes
  (0/2/3/4/130), SIGINT cancellation; getting-started, modes, API, CLI, and
  security docs.

### Phase 5 — Security & reliability
- Per-conversion request guard: subresource and page-scripted navigation
  classification (`BLOCKED_RESOURCE`, `BLOCKED_URL`), redirect `Location`
  classification (`BLOCKED_REDIRECT`), request caps
  (`RESOURCE_LIMIT_EXCEEDED`), output-byte and fail-fast concurrency limits,
  credential redaction on error paths.

### Phase 6 — Benchmark, CI, container
- `pageforge benchmark`: deterministic scenarios; PageForge vs raw-Playwright
  baseline vs html2pdf.js vs WeasyPrint (skip-with-hint when absent, never
  fabricated); JSON + human reports.
- GitHub Actions CI (lint, typecheck, unit on Node 22/24; build + Playwright
  e2e on Chromium) and a production Docker image with Chromium's sandbox on.

### Local web UI (`pageforge-web`, development tool)
- `pnpm web`: localhost-only server with a browser form — target URL in, PDF
  out, quality-report summary and typed security errors shown inline.
  Loopback/private targets need explicit `--allow-loopback` /
  `--allow-private-network` at startup; the UI cannot escalate policy.
- "Tolerant readiness" option (`tolerant: true` in the API): skips waiting on
  images/network idle for sites that keep requests open forever (streaming
  assets, long polling); fonts are still awaited. Default stays strict.
- `PAPER_FORMATS` and `PaperFormat` are now exported from `pageforge-pdf`.

### Browser presentation
- New `browser.userAgent` convert option. Default: a standard `Chrome` UA for
  the running Chromium build (the `HeadlessChrome` token removed), because
  production sites and WAFs frequently serve 403/500 pages to that string.
  This changes the UA string only — TLS/HTTP2 fingerprints still identify an
  automated browser; it is a compatibility shim, not an anonymity control.
