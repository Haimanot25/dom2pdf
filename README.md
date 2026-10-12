# PageForge

**PageForge** is an open-source HTML-to-PDF conversion engine built on Playwright's Chromium. It converts URLs, HTML strings, and explicitly-permitted local HTML files into PDFs that preserve website appearance as closely as the browser and the PDF format allow, keeping text selectable and searchable wherever possible.

> **Status: pre-alpha (Phase 5 of 6).** This repository is under active construction. Both rendering modes work — `document` (print CSS) and `screen` (paper-fit output policy) — the readiness phase plus structured quality checks/policies are in place, the `pageforge` CLI (`convert`, `inspect`) is usable, and every conversion now runs behind an enforced request policy with resource limits. The `benchmark` subcommand arrives with the benchmark suite in Phase 6. See [Roadmap](#roadmap) — no feature is documented here before it works.

## Quick start

```bash
# Library
pnpm build

# CLI (from this repository)
pnpm pageforge convert https://example.com -o example.pdf
pnpm pageforge convert ./report.html --format A4 --margin 15mm --json
pnpm pageforge inspect example.pdf
```

```ts
import { createConverter } from "pageforge-pdf";

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

### Readiness

After navigation, every conversion waits (under the single `readiness.timeoutMs` deadline) for the page to actually settle. Defaults: fonts settled (`fonts: true`), all images finished (`images: true`), and 300ms without network activity (`networkIdleMs: 300`, `0` disables — required for long-polling pages, otherwise the phase fails with `READINESS_TIMEOUT` naming the stage instead of hanging).

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

Every successful conversion returns a structured report: `checks` (`pdf-structure`, `readiness`, `resources`, `pdf-text`, and mode-specific ones), `warnings` (each labeled `observed` = measured, or `heuristic` = estimated), `timings`, and measured PDF facts. Resource problems (failed requests, HTTP ≥ 400, broken images, failed web fonts) and empty pages surface as warnings with stable codes.

Policies compare measured output against your expectations and fail with `QUALITY_POLICY_FAILED` (carrying `details.violations` plus the full report):

```ts
await converter.convert({
  input: { type: "url", url: "https://example.com/invoice" },
  quality: { minTextChars: 500, minPages: 1, maxPages: 4, failOnWarnings: false },
});
```

### Inputs

| Type | Example | Notes |
| --- | --- | --- |
| `url` | `{ type: "url", url: "https://example.com" }` | `http`/`https` only; private/loopback destinations blocked by default (opt in via `security`) |
| `html` | `{ type: "html", html, baseUrl? }` | Optional `baseUrl` resolves relative references |
| `file` | `{ type: "file", path }` | Opt-in only: `security.allowLocalFiles` + `allowedLocalDirectories` |

### Security defaults

- Chromium sandbox **enabled** (Playwright's own default disables it; PageForge does not).
- Private, link-local, and loopback destinations blocked unless explicitly allowed.
- Local file reads denied unless explicitly allowlisted; symlink escapes are detected.
- Unknown options are rejected (`UNSUPPORTED_OPTION`), never silently ignored.

## Errors

All failures throw `PageForgeError` with a stable machine-readable `code` such as `INVALID_INPUT`, `UNSUPPORTED_OPTION`, `BLOCKED_URL`, `LOCAL_FILE_NOT_ALLOWED`, `NAVIGATION_FAILED`, `READINESS_TIMEOUT`, `RENDER_TIMEOUT`, `PDF_VALIDATION_FAILED`, `QUALITY_POLICY_FAILED`, `BROWSER_FAILURE`, `CANCELLED`, or `CONVERTER_CLOSED`.

Conversions accept an optional `signal: AbortSignal`; aborting fails fast with `CANCELLED` and cleans up the browser context. The CLI maps failures to stable exit codes: `0` ok, `2` usage, `3` conversion error, `4` quality-policy rejection, `130` SIGINT.

## Documentation

- [Getting started](docs/getting-started.md) — build, first conversion, CLI basics
- [Rendering modes](docs/modes.md) — `document` vs `screen`, output policies, paper-fit math
- [API reference](docs/api.md) — every option, report checks/warnings, error codes
- [CLI reference](docs/cli.md) — commands, flags, JSON formats, exit codes
- [Security](docs/security.md) — enforced layers and the residual risks we document honestly

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
4. ✅ **Phase 4 — CLI & documentation**: `pageforge convert|inspect` with `--help`, JSON reports, stable exit codes (0/2/3/4/130), SIGINT cancellation; guides under `docs/`.
5. ✅ **Phase 5 — Security & reliability**: request-layer policies at the network layer (`BLOCKED_REDIRECT`, `BLOCKED_RESOURCE`, scripted-navigation blocks), resource limits (`RESOURCE_LIMIT_EXCEEDED`: requests, output bytes, fail-fast concurrency cap), credential redaction on error paths.
6. **Phase 6 — Benchmark & alpha**: `pageforge benchmark`, deterministic fixtures, comparative benchmarks, CI, Docker, release docs.

## License

MIT
