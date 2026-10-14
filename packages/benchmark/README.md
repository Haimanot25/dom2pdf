# pageforge-benchmark

Deterministic multi-engine benchmarking for HTML-to-PDF conversion, used by
`pageforge benchmark` (see [pageforge-cli](https://www.npmjs.com/package/pageforge-cli)).

## Methodology (honest by construction)

- **Deterministic fixtures** — served locally, no live internet, so runs are
  comparable across machines and time.
- **Warm-up runs** are excluded from stats; medians and p95 are reported from
  the measured runs.
- Engines that are not installed are reported as **skipped with the install
  command** — never estimated, never silently dropped.
- Every engine produces its own PDF; output size is reported alongside timing
  so a fast-but-bloated engine is visible, not disguised.
- PageForge is compared against a raw-Playwright baseline so the engine's
  own overhead (readiness, verification, policies) stays measurable.

## Engines

`pageforge` (this engine), `playwright-raw` (Chromium `page.pdf()` with no
pipeline), `html2pdf.js`, and `weasyprint` (skipped with instructions when
not on PATH).

```bash
pageforge benchmark --iterations 5 --scenarios simple,long-document --json
```

Requires Node.js >= 22.13.
