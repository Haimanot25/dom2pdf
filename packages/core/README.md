# dom2pdf-js

HTML-to-PDF conversion built on Playwright's Chromium — URL, HTML string, or
explicitly-permitted local file in, PDF plus a structured quality report out.

```bash
npm install dom2pdf-js
```

```ts
import { createConverter } from "dom2pdf-js";

const converter = await createConverter();
try {
  const result = await converter.convert({
    input: { type: "url", url: "https://example.com/report" },
    mode: "document", // or "screen" (paper-fit output policy)
    pdf: { format: "A4", printBackground: true },
  });
  await result.save("./report.pdf");
  console.log(result.report); // checks, warnings, timings, fidelity, …
} finally {
  await converter.close();
}
```

## What it does

- **Two modes**: `document` (print CSS, `@page` rules, paper/margins/scale)
  and `screen` (your viewport layout paginated under a measured paper-fit
  output policy).
- **Readiness phase**: fonts, images, network quiet, a CSS selector, and a
  settle period under one deadline — failures name the stage instead of
  hanging. Adaptive per-resource patience stops one hung asset from burning
  the shared deadline; scroll-driven content (lazy markers, infinite scroll,
  reveal-on-scroll animations) is drained before capture, and captures are
  taken with animations settled at their end state.
- **Structured quality report**: every check states measured facts; warnings
  are labeled `observed` (measured) or `heuristic` (estimated). Policies can
  reject output (`minPages`, `maxBytes`, `failOnWarnings`, …) with
  `QUALITY_POLICY_FAILED` carrying the report.
- **Verified output**: sampled PDF pages are re-rasterized in-browser and
  compared against the live page (`report.fidelity`) — a heuristic visual
  comparison, **never a pixel-perfectness claim**. Failures can carry
  forensics (`details.diagnostics`: console, requests, DOM, screenshot).
  `deterministic: true` zeroes the PDF date stamps so repeated conversions
  on the same browser build are byte-identical.
- **Security by default**: Chromium sandbox stays on; private/loopback
  destinations and local file reads are denied unless explicitly allowed; a
  request policy runs at the network layer with resource limits.

Requires Node.js >= 22.13. Playwright's Chromium is installed as part of
`npm install`.

## Errors

Every failure throws `Dom2PdfError` with a stable `code`
(`BLOCKED_URL`, `NAVIGATION_FAILED`, `READINESS_TIMEOUT`,
`QUALITY_POLICY_FAILED`, `CANCELLED`, …) that is safe to branch on.
Conversions accept an `AbortSignal` and fail fast with `CANCELLED`.

Full API reference, guides, and source: see the dom2pdf repository
(README and `docs/`).
