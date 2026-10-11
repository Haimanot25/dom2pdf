# PageForge

**PageForge** is an open-source HTML-to-PDF conversion engine built on Playwright's Chromium. It converts URLs, HTML strings, and explicitly-permitted local HTML files into PDFs that preserve website appearance as closely as the browser and the PDF format allow, keeping text selectable and searchable wherever possible.

> **Status: pre-alpha (Phase 1 of 6).** This repository is under active construction. Only `document` mode (print CSS) is implemented so far; `screen` mode, the full readiness/quality pipeline, the CLI, and the benchmark suite arrive in later phases. See [Roadmap](#roadmap) — no feature is documented here before it works.

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

All failures throw `PageForgeError` with a stable machine-readable `code` such as `INVALID_INPUT`, `BLOCKED_URL`, `LOCAL_FILE_NOT_ALLOWED`, `NAVIGATION_FAILED`, `READINESS_TIMEOUT`, `RENDER_TIMEOUT`, `PDF_VALIDATION_FAILED`, `BROWSER_FAILURE`, or `CONVERTER_CLOSED`.

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
2. **Phase 2 — Core rendering**: screen mode with output policies, full PDF option coverage, cancellation, error catalog completion.
3. **Phase 3 — Readiness & quality**: font/image/network/selector readiness, text extraction checks, layout diagnostics, quality policies.
4. **Phase 4 — CLI & documentation**: `pageforge convert|inspect|benchmark`, full docs, examples.
5. **Phase 5 — Security & reliability**: request-layer policies, resource limits, pooling and repeat-run guarantees.
6. **Phase 6 — Benchmark & alpha**: deterministic fixtures, comparative benchmarks, CI, Docker, release docs.

## License

MIT
