# dom2pdf

**dom2pdf** is an open-source HTML-to-PDF conversion engine built on Playwright's Chromium. It converts URLs, HTML strings, and explicitly-permitted local HTML files into PDFs that preserve website appearance as closely as the browser and the PDF format allow, keeping text selectable and searchable wherever possible.

> **Status: pre-alpha (Phase 9 of 9 — complete; alpha publish pending).** This repository is under active construction. Both rendering modes work — `document` (print CSS) and `screen` (paper-fit output policy) — the readiness phase (including adaptive per-resource patience and the scroll-driven content drain: lazy markers, infinite scroll, reveal-on-scroll) plus structured quality checks/policies are in place, every conversion verifies its own output (render-fidelity comparison against the live page, failure forensics, optional byte-reproducible output), the `dom2pdf` CLI (`convert`, `inspect`, `benchmark`) and the local `dom2pdf-web` UI are usable, every conversion runs behind an enforced request policy with resource limits, CI runs the full gate, and the production Docker image keeps Chromium's sandbox on. See [Roadmap](#roadmap) — no feature is documented here before it works.

## Quick start

```bash
# Library
pnpm build

# CLI (from this repository)
pnpm dom2pdf convert https://example.com -o example.pdf
pnpm dom2pdf convert ./report.html --format A4 --margin 15mm --json
pnpm dom2pdf inspect example.pdf
pnpm dom2pdf benchmark --iterations 3 --scenarios simple   # multi-engine benchmark

# Local web UI — open the printed URL, paste a target URL, get a PDF
pnpm web                                     # http://127.0.0.1:8787
pnpm web --port 9000 --allow-loopback        # custom port; test localhost targets
```

```ts
import { createConverter } from "dom2pdf-js";

const converter = await createConverter();
try {
  const result = await converter.convert({
    input: { type: "html", html: "<!doctype html><html><body><h1>Hello</h1></body></html>" },
    mode: "document",
    pdf: { format: "A4", printBackground: true },
    readiness: { timeoutMs: 30_000 },
  });

  await result.save("./output.pdf");
  console.log(result.report); // structured quality report with measured values
} finally {
  await converter.close();
}
```

### Rendering modes

| Mode | What it does | Output policy |
| --- | --- | --- |
| `document` (default) | Print CSS media; author print styles and `@page` rules apply (via `pdf.preferCSSPageSize`) | paper config: `format`/`width`/`height`, `margin`, `landscape`, `scale` |
| `screen` | Screen CSS media at your viewport, then paginated | `paper-fit` (implemented): viewport scaled exactly onto the paper width; `viewport-pages`/`full-content` are reserved and rejected with `UNSUPPORTED_OPTION` |

Screen mode reports its measured fit (`screen.output-policy` check) plus heuristic warnings for horizontal overflow, fixed/sticky elements, and scroll containers.

In both modes the capture is taken with CSS/Web-Animations animations settled at their end state, so a printout shows the finished page rather than a mid-animation frame.

### Readiness

After navigation, every conversion waits (under the single `readiness.timeoutMs` deadline) for the page to actually settle. Defaults: fonts settled (`fonts: true`), all images finished (`images: true`), and 300ms without network activity (`networkIdleMs: 300`, `0` disables). Pages with requests genuinely still loading when the deadline expires fail with `READINESS_TIMEOUT` naming the stage instead of hanging; purely *chatty* pages (analytics beacons that keep the activity clock fresh while nothing transfers — news homepages) no longer fail: readiness stops at its own stage budget and proceeds with an honest `readiness.network-unsettled` warning.

Scrollable documents are also walked first (bounded, `readiness.lazyLoad`, default `true`) so scroll-driven content is actually present in the capture: `loading="lazy"` markers, fetch-on-scroll feeds (infinite scroll), and reveal-on-scroll animations that keep sections at `opacity: 0` until an observer fires — the pattern that otherwise prints as blank space. The sweep runs under its own time budget (it stops and reports `truncated` rather than spending the deadline the essential checks need — a slow sweep costs a warning, never a failed conversion), and the `readiness` check detail reports what it did (steps taken, large blocks revealed, blocks still hidden).

```ts
await converter.convert({
  input: { type: "url", url: "https://example.com/report" },
  readiness: {
    timeoutMs: 30_000,
    selector: "#app",            // wait until visible
    waitForFonts: ["Inter"],     // wait for declared @font-face loads
    settleMs: 200,               // extra quiet period
    networkIdleMs: 300,          // or 0 to disable
  },
});
```

### Quality report & policies

Every successful conversion returns a structured report: `checks` (`pdf-structure`, `readiness`, `resources`, `pdf-text`, `render.fidelity`, and mode-specific ones), `warnings` (each labeled `observed` = measured, or `heuristic` = estimated), `timings`, and measured PDF facts. Resource problems (failed requests, HTTP ≥ 400, broken images, failed web fonts) and empty pages surface as warnings with stable codes.

Policies compare measured output against your expectations and fail with `QUALITY_POLICY_FAILED` (carrying `details.violations` plus the full report):

```ts
await converter.convert({
  input: { type: "url", url: "https://example.com/invoice" },
  quality: { minTextChars: 500, minPages: 1, maxPages: 4, failOnWarnings: false },
});
```

### Verified output

Every conversion can verify itself after rendering — none of this claims pixel-perfectness; each measurement is a heuristic with honest skip rules:

- **Render fidelity** (on by default): sampled pages of the produced PDF are re-rasterized inside Chromium (pdf.js) and compared, page by page, against screenshots of the live page at the print layout width. `report.fidelity` carries per-page SSIM / pHash / alignment; below `fidelity.threshold` (default `0.8`) you get a `render.fidelity` warning. Unverifiable layouts (header/footer templates, unmappable `pageRanges`) report `status: "skipped"` with the reason — scores are never fabricated.
- **Failure forensics** (`diagnostics: true`, always on in the web UI): on failure, `error.details.diagnostics` carries the console transcript, failed requests, the DOM, and a screenshot of what the page was doing. The CLI writes it to `<output>.diag/` with `--diagnostics`.
- **Deterministic output** (`deterministic: true` / `--deterministic`): Chromium's two date stamps are zeroed in place so repeated conversions on the same browser build are byte-identical; `report.deterministic` carries a content digest over the extracted page text.

### Inputs

| Type | Example | Notes |
| --- | --- | --- |
| `url` | `{ type: "url", url: "https://example.com" }` | `http`/`https` only; private/loopback destinations blocked by default (opt in via `security`) |
| `html` | `{ type: "html", html, baseUrl? }` | Optional `baseUrl` resolves relative references |
| `file` | `{ type: "file", path }` | Opt-in only: `security.allowLocalFiles` + `allowedLocalDirectories` |

### Security defaults

- Chromium sandbox **enabled** (Playwright's own default disables it; dom2pdf does not).
- Private, link-local, and loopback destinations blocked unless explicitly allowed.
- Local file reads denied unless explicitly allowlisted; symlink escapes are detected.
- Unknown options are rejected (`UNSUPPORTED_OPTION`), never silently ignored.

## Errors

All failures throw `Dom2PdfError` with a stable machine-readable `code` such as `INVALID_INPUT`, `UNSUPPORTED_OPTION`, `BLOCKED_URL`, `LOCAL_FILE_NOT_ALLOWED`, `NAVIGATION_FAILED`, `READINESS_TIMEOUT`, `RENDER_TIMEOUT`, `PDF_VALIDATION_FAILED`, `QUALITY_POLICY_FAILED`, `BROWSER_FAILURE`, `CANCELLED`, or `CONVERTER_CLOSED`.

Conversions accept an optional `signal: AbortSignal`; aborting fails fast with `CANCELLED` and cleans up the browser context. The CLI maps failures to stable exit codes: `0` ok, `2` usage, `3` conversion error, `4` quality-policy rejection, `130` SIGINT.

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
pnpm install
pnpm browser:install        # provision the pinned Chromium build
pnpm lint                   # eslint
pnpm typecheck              # strict tsc over src + tests
pnpm test:unit              # vitest (validation, security, deadlines, …)
pnpm test:e2e               # playwright test (real browser conversions)
pnpm build                  # compile packages
```

Requires Node.js ≥ 22.13 (24 LTS recommended) and pnpm.

## Roadmap

1. ✅ **Phase 1 — Foundation**: workspace, strict TypeScript, working URL/HTML/file → PDF, security pre-checks, deadlines.
2. ✅ **Phase 2 — Core rendering**: screen mode with paper-fit output policy, print CSS/paged media coverage, pagination, cancellation (`AbortSignal`), structured errors.
3. ✅ **Phase 3 — Readiness & quality**: font/image/network/selector readiness under one deadline, observed resource diagnostics, text extraction checks, quality policies (`QUALITY_POLICY_FAILED`).
4. ✅ **Phase 4 — CLI & documentation**: `dom2pdf convert|inspect` with `--help`, JSON reports, stable exit codes (0/2/3/4/130), SIGINT cancellation; guides under `docs/`.
5. ✅ **Phase 5 — Security & reliability**: request-layer policies at the network layer (`BLOCKED_REDIRECT`, `BLOCKED_RESOURCE`, scripted-navigation blocks), resource limits (`RESOURCE_LIMIT_EXCEEDED`: requests, output bytes, fail-fast concurrency cap), credential redaction on error paths.
6. ✅ **Phase 6 — Benchmark & alpha**: `dom2pdf benchmark` (deterministic fixtures; dom2pdf vs raw-Playwright baseline vs html2pdf.js vs WeasyPrint with honest skips), GitHub Actions CI, production Docker image (sandbox on), release docs.
7. ✅ **Local web UI (`dom2pdf-web`)**: localhost-only URL→PDF form; the full security policy applies (loopback/private targets need explicit server flags; the UI cannot escalate).
8. ✅ **Phase 7 — Adaptive readiness**: per-resource patience (`readiness.slowResourceMs`) so one hung asset cannot burn the shared deadline, and a bounded lazy-load drain (`readiness.lazyLoad`) so `loading="lazy"` content is actually fetched.
9. ✅ **Phase 8 — Verified output**: render-fidelity verification (`report.fidelity`, honest skip rules), failure forensics (`error.details.diagnostics`, CLI `--diagnostics`, always-on in the web UI), and deterministic byte-reproducible output (`deterministic`, CLI `--deterministic`, content digest).
10. ✅ **Phase 9 — Scroll-driven content**: the readiness sweep walks every scrollable document — `loading="lazy"` markers, infinite-scroll feeds, and reveal-on-scroll animations that would otherwise print as blank space — reporting what it revealed; captures are taken with animations fast-forwarded to their settled end state so reveal slides never clip text at the page edge.

## License

MIT
