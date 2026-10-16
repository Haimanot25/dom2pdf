# Changelog

All notable changes to dom2pdf are documented here. Versions follow
[semver](https://semver.org/); until `1.0.0` the API may move in minor
versions, and **error codes may be added in minor releases** (treat unknown
codes as generic failures).

## 0.1.0-alpha.0 (2026-10-14)

First public alpha — the six-phase foundation, in order:

### Phase 1 — Foundation
- pnpm workspace: `dom2pdf-js` (core), `dom2pdf-cli`, `dom2pdf-benchmark`.
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
- `dom2pdf convert|inspect` with `--json`/`--quiet`, stable exit codes
  (0/2/3/4/130), SIGINT cancellation; getting-started, modes, API, CLI, and
  security docs.

### Phase 5 — Security & reliability
- Per-conversion request guard: subresource and page-scripted navigation
  classification (`BLOCKED_RESOURCE`, `BLOCKED_URL`), redirect `Location`
  classification (`BLOCKED_REDIRECT`), request caps
  (`RESOURCE_LIMIT_EXCEEDED`), output-byte and fail-fast concurrency limits,
  credential redaction on error paths.

### Phase 6 — Benchmark, CI, container
- `dom2pdf benchmark`: deterministic scenarios; dom2pdf vs raw-Playwright
  baseline vs html2pdf.js vs WeasyPrint (skip-with-hint when absent, never
  fabricated); JSON + human reports.
- GitHub Actions CI (lint, typecheck, unit on Node 22/24; build + Playwright
  e2e on Chromium) and a production Docker image with Chromium's sandbox on.

### Local web UI (`dom2pdf-web`, development tool)
- `pnpm web`: localhost-only server with a browser form — target URL in, PDF
  out, quality-report summary and typed security errors shown inline.
  Loopback/private targets need explicit `--allow-loopback` /
  `--allow-private-network` at startup; the UI cannot escalate policy.
- "Tolerant readiness" option (`tolerant: true` in the API): skips waiting on
  images/network idle for sites that keep requests open forever (streaming
  assets, long polling); fonts are still awaited. Default stays strict.
- `PAPER_FORMATS` and `PaperFormat` are now exported from `dom2pdf-js`.

### Browser presentation
- New `browser.userAgent` convert option. Default: a standard `Chrome` UA for
  the running Chromium build (the `HeadlessChrome` token removed), because
  production sites and WAFs frequently serve 403/500 pages to that string.
  This changes the UA string only — TLS/HTTP2 fingerprints still identify an
  automated browser; it is a compatibility shim, not an anonymity control.

### Phase 7 — Adaptive readiness
- Per-resource patience: new `readiness.slowResourceMs` (default 10s, `0`
  disables). A pending image that outlives its individual patience no longer
  spends the shared deadline — the conversion proceeds with a `resources.slow`
  warning naming the asset, and network quiet ignores requests older than the
  patience so a hung asset cannot re-block the idle check.
- Lazy-load drain: new `readiness.lazyLoad` (default `true`). Scrollable
  documents that declare lazy markers are swept with bounded scroll steps
  before the other checks so `loading="lazy"`/`data-src` content is actually
  fetched; scroll position is restored, and a sweep that hits its step limit
  reports `resources.lazy-load-truncated`.
- Navigation now waits for DOMContentLoaded; subresource settling belongs to
  the readiness phase (where patience applies). A hanging asset in the initial
  document is a warned slow resource instead of a navigation-stage timeout.
- Bug fix: a readiness poll abandoned by a firing deadline could reject
  unhandled ("Target closed") after its context closed, terminating the host
  Node process — found via the web UI dying mid-conversion. `withDeadline`
  now abandons in-flight work safely, with a regression test; the web UI also
  logs stray rejections instead of exiting.

### Phase 8a — Render-fidelity verification
- New post-render verification phase (on by default): sampled pages of the
  produced PDF are re-rasterized inside Chromium with pdf.js and compared,
  page by page, against screenshots of the live page captured under the same
  media emulation and at the print layout width. The comparison runs entirely
  in-browser (canvas pixel access) — no native dependencies, no pixel data
  leaves the process.
- `fidelity` convert options: `enabled` (default `true`), `samplePages`
  (1–50 or `"all"`, default `3`), `threshold` (default `0.8`). Results land in
  `report.fidelity` (per-page SSIM, pHash distance, alignment offset) with a
  `render.fidelity` check and `fidelity.low-score` / `fidelity.skipped`
  warnings.
- Honesty rules: scores are a heuristic visual comparison, never a
  pixel-perfectness claim; any infrastructure failure or unverifiable layout
  (header/footer templates, unmappable `pageRanges`, differing page sizes)
  degrades to `status: "skipped"` with the reason — scores are never
  fabricated. Cancellation still propagates as `CANCELLED`.

### Phase 8b — Failure forensics
- New `diagnostics` convert option (default `false`): console messages (ring
  buffer: last 100 entries, 2000 chars each), uncaught page exceptions, and
  network activity are recorded from the moment the page is created. On
  failure the captured state plus a best-effort JPEG screenshot and the
  serialized DOM (capped at 256 KiB) attach to the error as
  `error.details.diagnostics`.
- Forensics are best effort by design: a capture step that cannot run is
  listed in `incomplete[]` (never silently dropped), the whole artifact
  phase is bounded by a 5s deadline, and `CANCELLED` never waits on — or is
  masked by — forensics.
- CLI: `--diagnostics` writes the bundle next to the intended output as
  `<output>.diag/` (`meta.json`, `page.html`, `screenshot.jpg`). The local
  web UI always collects forensics so its error card can show what failed.

### Phase 8c — Deterministic (reproducible) output
- New `deterministic` convert option (default `false`): the two date stamps
  Chromium writes (`/CreationDate`, `/ModDate` — the only byte-level
  differences between repeated conversions of the same input on the same
  browser build) are zeroed in place, byte-length-preserving so the xref
  table stays valid. Repeated conversions are byte-identical; e2e proves it
  with a double-convert SHA-256 equality assertion (relative, no golden
  binaries).
- The report gains `deterministic: { contentDigest, normalizedSpans,
  residual }` plus a `pdf.determinism` check: the content digest is a sha256
  over page count + per-page extracted text (whitespace-normalized), letting
  callers verify "same content" independently of the stamps. A date span that
  cannot be normalized is counted in `residual` and warned about as
  `determinism.residual` — never silently ignored. Byte identity is a
  same-machine/same-browser-build property, not a cross-machine guarantee.
- CLI: `--deterministic` enables the rewrite; the summary prints the content
  digest and normalized span count.

### Phase 8d — Web UI surfacing & docs
- The web UI result card now shows the render-fidelity line: mean SSIM
  against the source page with the threshold and the sampled page range,
  color-coded (green at/above threshold, amber below) and explicitly framed
  as a visual comparison, not a pixel-perfectness claim; a skipped run shows
  the reason.
- The web UI error card now summarizes the always-collected forensics
  bundle: uncaught page errors, console errors/warnings, and failed requests
  at the moment of failure (the screenshot and DOM stay in the JSON bundle,
  out of the card).
- README: status/roadmap updated through Phase 8 with a new "Verified
  output" section; `docs/api.md`/`docs/cli.md` cover the new options
  (`fidelity`, `diagnostics`, `deterministic`), report fields, checks, and
  warning codes.

### Phase 9 — Scroll-driven content & settled captures
- The lazy sweep (`readiness.lazyLoad`, default `true`) now walks **every
  scrollable document**, not only pages that declare lazy markers, because
  scroll drives three different lazy behaviors: `loading="lazy"`/`data-src`
  markers, fetch-on-scroll feeds (infinite scroll), and reveal-on-scroll
  animations (Wix/AOS/wow-style sections sitting at `opacity: 0` until an
  IntersectionObserver fires — previously printed as blank space with no
  warning at all; found on a live site the fidelity check had flagged).
  Each step carries a calibrated dwell (200ms — throttled reveal handlers
  are otherwise outrun and sections stay hidden permanently); short pages
  still pay nothing.
- Infinite scroll: at the bottom, the document height is re-checked after
  the triggered burst settles — growth keeps the sweep walking into
  appended content, bounded by the step cap and the deadline; hitting the
  cap reports `resources.lazy-load-truncated` as before.
- The sweep can no longer starve the readiness deadline (regression found
  on a live site: per-step settle waits over ~18 steps consumed the whole
  30s and failed the conversion at the `lazy-load` stage even though the
  page settles in under 4s). It now runs under a **time budget** — at most
  half of the deadline still remaining at sweep start, always leaving the
  rest to the essential checks (fonts, images, network quiet) — mid-walk
  settle waits are capped small (600ms; the bottom growth check keeps the
  full 2.5s cap), and budget exhaustion stops the sweep with an honest
  `truncated: time budget` detail and `resources.lazy-load-truncated`
  warning instead of throwing. An already-expired deadline skips the sweep
  so the stage that names the real bottleneck reports the advice that
  applies.
- The `readiness` check detail now reports what the sweep did: step count,
  how many large blocks became visible (before/after hidden counts), and
  any large blocks still hidden afterwards (usually intentional decorative
  layers — reported, never claimed to be a defect). One bounded reveal-tail
  settle runs only on pages where the sweep actually revealed something.
- Captures are taken **settled**: before `page.pdf()`, running CSS/WAAPI
  animations and transitions are fast-forwarded to their end state and
  paused. Chromium's `printToPDF` settles CSS transitions itself but prints
  running Web Animations mid-flight — on reveal-heavy sites that clipped
  text at the page edge (verified: markers print `CLIPPED` without the
  freeze, `FULL` with it).
- `inspectPdf(bytes, { extractText: true })` now returns the raw extracted
  text per page (`text.pages`) next to the counts — included in
  `dom2pdf inspect --json` and used for content assertions in tests.
- New fixtures (`reveal-on-scroll`, `infinite-scroll`, `reveal-slide`, plus
  a fixture-server `/__chunk/<n>` feed route) and
  `tests/scroll-content.spec.ts`: both patterns convert with all content
  present, a no-sweep control proves the reveal case depends on the sweep,
  and static short pages are asserted to pay nothing. Validated end-to-end
  against a live reveal-on-scroll site (text extraction and hidden-block
  counts restored to the full-page baseline).

### Real-world matrix hardening (live sites)

Validated against a 14-site live matrix (long-form/CJK/RTL wikis, docs
sites, SPAs, repos, news, commerce) and fixed what it surfaced:

- **Chromium recovery**: a browser dying between conversions (crash, update,
  OOM kill) used to poison *every* conversion that followed — the manager
  cleared `browser` on the `disconnected` event but kept its resolved launch
  task, so it kept handing out the dead process
  (`newContext: ...has been closed` forever; found when one Chromium death
  failed four conversions in a row). The browser manager now drops both the
  browser and its launch task on disconnect, never acquires a browser that
  is not connected (relaunching at most once), and retries `newContext` once
  against a fresh launch when the process dies in the window between launch
  and context creation.
- **In-flight tracking keyed by request identity**: the resource tracker
  stored in-flight requests *by URL*, so several concurrent requests for the
  same URL (a poll fired every 50ms, retried assets) overwrote each other and
  the first response deleted entries that were still transferring —
  `inFlightRecent` under-reported real downloads and could flip readiness's
  loading-vs-churn verdict (surfaced as a load-dependent contract-test
  failure). The tracker now keys by the `Request` object; `requestStartAt`
  returns the newest in-flight start for a URL and `stalledUrls` reports each
  stalled URL once.
- **Network quiet degrades instead of failing**: live news homepages (BBC
  News) keep the activity clock fresh forever with fast analytics beacons
  while transferring almost nothing — a quiet window never arrives, the old
  code waited out the entire readiness deadline and failed with
  `READINESS_TIMEOUT` under advice that did not apply to the page. The
  network stage now judges the traffic over its own stage budget (4s): a
  stage that is transferring keeps waiting for the deadline, a stage that is
  only chatty stops and proceeds with a `readiness.network-unsettled`
  warning (the `readiness` check reports `warn`, never a silent pass).
  `READINESS_TIMEOUT` at the network stage still fires when the deadline
  expires with requests genuinely awaiting a response — the
  never-settles-with-real-transfers contract is unchanged.
- Docs: the warning-code table was completed (`resources.slow`,
  `resources.lazy-load-truncated` were missing) and now documents
  `readiness.network-unsettled`.
- Matrix outcome after the fixes: all convertible sites produce complete
  text with honest warnings; HTTP 403 bot walls still fail fast with
  `NAVIGATION_FAILED`; the remaining outliers (a trailing empty page on
  GitHub, a fidelity skip on a slow NASA load) are reported, not hidden.

### Object-aware pagination (`pagination.keepTogether`, opt-in)

New opt-in option `pagination: { keepTogether: true }` (CLI `--keep-together`,
web UI checkbox) that stops the common print awkwardness. Off by default:
without the option nothing is injected and pagination is exactly Chromium's
default, byte for byte.

- **Geometry-aware marking**: candidates are measured at the print layout
  size (`contentWidth / scale`, transiently resized and restored; no resize
  needed when the live viewport already matches) and only objects that fit
  one page (≤ 95% of the content height budget) get `break-inside: avoid` —
  tables, figures, images, videos, code blocks, and standalone SVGs no longer
  straddle a page break.
- **Rows never clipped at a page edge**: `tr { break-inside: avoid }` pushes a
  straddling row whole to the next page; rows taller than a page still break.
- **Overridden `<thead>` repeats**: tables whose header group was forced to
  `table-row-group` (the responsive "don't repeat" trick) get a scoped rule
  restoring `table-header-group`, so headers appear on continuation pages;
  deliberately hidden (`display: none`) headers stay hidden.
- **Honest limits, verified against this Chromium build before shipping**: an
  avoid block *taller than a page* is pushed and then overflows invisibly past
  the page edge, so over-tall objects are deliberately not marked (counted as
  `too tall to keep`); `break-after: avoid` (heading grouping) is not honored
  by the engine, so no heading rules are applied; with
  `pdf.preferCSSPageSize` the paper comes from `@page` and cannot be known
  pre-render, so the pass reports `skipped` with the reason instead of
  guessing.
- New `render.pagination` check (counts kept/repeated/too-tall plus the page
  budget; `skipped` with the reason when the pre-pass could not run —
  enrichment, never a conversion failure).
- **CSP-safe injection** (found by a real-site validation run): the
  stylesheet is installed as a constructed stylesheet on
  `document.adoptedStyleSheets`, which strict `style-src` policies without
  `unsafe-inline` (e.g. gov.uk) do not block — the earlier `addStyleTag`
  path was refused there and the check honestly reported `skipped`.
- **Shadow DOM + iframe coverage** (same validation run, against MDN):
  candidates are also collected from open shadow roots, with the stylesheet
  adopted per root (a document sheet never crosses the shadow boundary), and
  a page-fitting iframe is kept whole as a box (Chromium honors the rule on
  it — probe-verified). Closed shadow roots and iframe interiors are not
  scanned — documented in `docs/api.md`.
- Docs note the fidelity interaction honestly: kept objects change per-page
  composition versus the unpaginated screenshot, so those pages can score
  lower.
- Tests: schema/normalize/geometry units, CLI/web-UI flag mapping units, and
  an e2e spec covering default-off, whole-table keep, row push, header
  repeat, figure/caption keep, the too-tall guard, screen mode, and the
  `preferCSSPageSize` skip.

### Web UI redesign (visual polish)

- The local web UI (`dom2pdf-web`) got a full visual redesign: dark-first
  theme that follows `prefers-color-scheme` (light and dark), a sectioned
  form (target / output / reliability & layout) with switch-style option
  toggles, stat tiles and prominent actions on the result card, and a
  structured error card (icon, code chip, hint callout, forensics block).
  Same contract as before — a fully self-contained single page with inline
  CSS/JS and no external assets, identical element ids, and unchanged report
  wording, so the security posture and tests are untouched.
- Converting now shows a live status line with an elapsed-time ticker plus a
  spinner on the button (`aria-busy`/`aria-live` for assistive technology).
- Error messages strip embedded ANSI color codes (Playwright call-log
  styling) that previously rendered as garbage glyphs in the error card.
- `scripts/capture-ui-states.mjs` (manual, alongside the `validate-*`
  scripts) captures every UI state — initial, result, error, forensics — in
  both color schemes for visual review.
