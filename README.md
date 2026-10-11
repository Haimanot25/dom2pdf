# PageForge

**PageForge** is an open-source HTML-to-PDF conversion engine built on Playwright's Chromium. It converts URLs, HTML strings, and explicitly-permitted local HTML files into PDFs that preserve website appearance as closely as the browser and the PDF format allow, keeping text selectable and searchable wherever possible.

> **Status: pre-alpha (Phase 2 of 6).** This repository is under active construction. Both rendering modes work — `document` (print CSS) and `screen` (paper-fit output policy) — while the readiness/quality pipeline, the CLI, and the benchmark suite arrive in later phases. See [Roadmap](#roadmap) — no feature is documented here before it works.

## Quick start

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

All failures throw `PageForgeError` with a stable machine-readable `code` such as `INVALID_INPUT`, `UNSUPPORTED_OPTION`, `BLOCKED_URL`, `LOCAL_FILE_NOT_ALLOWED`, `NAVIGATION_FAILED`, `READINESS_TIMEOUT`, `RENDER_TIMEOUT`, `PDF_VALIDATION_FAILED`, `BROWSER_FAILURE`, `CANCELLED`, or `CONVERTER_CLOSED`.

Conversions accept an optional `signal: AbortSignal`; aborting fails fast with `CANCELLED` and cleans up the browser context.

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
3. **Phase 3 — Readiness & quality**: font/image/network/selector readiness, text extraction checks, layout diagnostics, quality policies.
4. **Phase 4 — CLI & documentation**: `pageforge convert|inspect|benchmark`, full docs, examples.
5. **Phase 5 — Security & reliability**: request-layer policies, resource limits, pooling and repeat-run guarantees.
6. **Phase 6 — Benchmark & alpha**: deterministic fixtures, comparative benchmarks, CI, Docker, release docs.

## License

MIT
