# API reference

Entry point: `import { createConverter } from "pageforge-pdf"`.

## `createConverter(options?)`

```ts
const converter = await createConverter({
  browser: {
    sandbox: true,        // default true — Chromium's sandbox is never disabled by PageForge
    launchTimeoutMs: 60_000,
  },
  limits: {
    maxConcurrentConversions: 4, // optional fail-fast cap; unlimited by default
  },
  logger: myLogger,       // optional; defaults to a warn-level console logger
});
```

The Chromium process launches lazily on the first `convert()` and is reused
across conversions; **every conversion gets a brand-new isolated browser
context** (no cookie/storage leakage between jobs). Contexts are cleaned up on
success, failure, timeout, and cancellation alike.

`limits.maxConcurrentConversions` is fail-fast back-pressure, not a queue:
while N conversions run, additional `convert()` calls reject immediately with
`RESOURCE_LIMIT_EXCEEDED` (`details.limit = "maxConcurrentConversions"`), and
the slot frees as soon as a conversion settles.

`converter.close()` shuts the browser down; later conversions fail with
`CONVERTER_CLOSED`. Calling `close()` twice is safe.

## `converter.convert(options)`

Returns `Promise<ConvertResult>`: `{ bytes: Uint8Array, report: QualityReport, save(path) }`.

All failures throw `PageForgeError` with a stable `code` (see
[error codes](#error-codes)).

### Options

Unknown keys are rejected with `UNSUPPORTED_OPTION` — never silently ignored.

| Option | Type | Default | Notes |
| --- | --- | --- | --- |
| `input` | `{type:"url",url}` \| `{type:"html",html,baseUrl?}` \| `{type:"file",path}` | — (required) | `file` requires `security.allowLocalFiles` + an allowlist |
| `mode` | `"document"` \| `"screen"` | `"document"` | See [modes](modes.md) |
| `outputPolicy` | `{type:"paper-fit"}` | screen: `paper-fit` | `viewport-pages`/`full-content` reserved → `UNSUPPORTED_OPTION`; document mode rejects the option |
| `viewport` | `{width,height}` | `1280×720` | Browser layout viewport; independent of paper |
| `signal` | `AbortSignal` | — | Aborting fails fast with `CANCELLED`; the converter stays usable |

#### `pdf` options

| Key | Type | Default |
| --- | --- | --- |
| `format` | `A0…A6`, `Letter`, `Legal`, `Tabloid`, `Ledger` | `A4` (when no width/height) |
| `width` / `height` | number (CSS px) or `"100px"/"8.5in"/"210mm"/"10cm"` | — |
| `margin` | `{top,right,bottom,left}` lengths | Chromium default (0) |
| `landscape` | boolean | `false` |
| `scale` | 0.1–2 | `1` (document mode only) |
| `printBackground` | boolean | `true` (Chromium's own default is `false`) |
| `preferCSSPageSize` | boolean | `false` |
| `pageRanges` | `"1-5, 8, 11-13"` | all pages |
| `displayHeaderFooter` | boolean | `false` |
| `headerTemplate` / `footerTemplate` | string | — (require `displayHeaderFooter: true`) |
| `outline` | boolean | `false` |
| `tagged` | boolean | `false` |

`format` cannot be combined with `width`/`height`.

#### `readiness` options

All stages share **one deadline** (`timeoutMs`); whichever stage gives out is
named in the `READINESS_TIMEOUT` error (`details.stage`). Waiting is
*adaptive*: each pending resource gets its own `slowResourceMs` patience, and
a hung asset costs a `resources.slow` warning instead of the whole conversion.
Navigation itself waits for DOMContentLoaded only — settling subresources is
what the readiness phase is for.

| Key | Type | Default | Meaning |
| --- | --- | --- | --- |
| `timeoutMs` | int (≤ 30 min) | `30000` | Overall deadline: input prep → navigation → readiness |
| `fonts` | boolean | `true` | Await `document.fonts.ready` |
| `waitForFonts` | `string[]` | `[]` | Wait for declared `@font-face` families; failures become `resources.font-unavailable` warnings |
| `images` | boolean | `true` | Wait until every `<img>` finished (failed = finished; each image is given `slowResourceMs` individual patience) |
| `slowResourceMs` | int, `0` disables | `10000` | Individual patience for a still-pending resource. Out-of-patience images (and other hung requests) no longer block; the conversion proceeds with a `resources.slow` warning naming them. `0` restores blocking until `timeoutMs` |
| `lazyLoad` | boolean | `true` | Before the other checks, sweep-scroll scrollable documents that declare lazy markers (`loading="lazy"`, `data-src`, …) so scroll-loaded content is actually fetched. Bounded by step count, per-step quiet windows, the request cap, and the deadline; a sweep that hits the step limit reports `resources.lazy-load-truncated` |
| `networkIdleMs` | int, `0` disables | `300` | No network activity for this long; uses a tracker attached **before** navigation, so in-flight requests count. Requests older than `slowResourceMs` count as hung and do not block. Pages that keep *starting* requests (long polling) hit `READINESS_TIMEOUT` unless disabled |
| `selector` | string | — | Wait until a CSS selector is **visible** |
| `settleMs` | int | `0` | Extra quiet period after the other checks |

#### `render` options

| Key | Type | Default |
| --- | --- | --- |
| `timeoutMs` | int | `30000` | Deadline for `page.pdf()` itself → `RENDER_TIMEOUT` |

#### `quality` options (policies)

Measured after rendering; violations throw `QUALITY_POLICY_FAILED` with
`details.violations` and the full `details.report`.

| Key | Violation |
| --- | --- |
| `minTextChars` | fewer extractable (non-whitespace) characters than requested |
| `minPages` / `maxPages` | page count outside the range (`minPages ≤ maxPages` enforced) |
| `maxBytes` | output larger than requested |
| `failOnWarnings` | report contains any warnings |

#### `fidelity` options (render-fidelity verification)

After the PDF is produced, PageForge re-rasterizes sampled pages inside
Chromium (pdf.js) and compares them against screenshots of the live page taken
under the same media emulation and at the print layout width. The comparison
runs entirely in-browser (canvas pixel access); no pixel data leaves the
process and no native dependencies are involved. Scores are a **heuristic
visual comparison** (blurred, resized SSIM plus a perceptual-hash cross-check) —
never a claim of pixel-perfect output.

| Key | Type | Default | Meaning |
| --- | --- | --- | --- |
| `enabled` | boolean | `true` | Run the verification phase. When `false`, `report.fidelity` is absent |
| `samplePages` | int 1–50, or `"all"` | `3` | Verify the first N pages (or every page) |
| `threshold` | number 0–1 | `0.8` | Mean SSIM below which the `render.fidelity` check warns |

Any infrastructure failure (or a layout that cannot be verified) degrades to
`report.fidelity = { status: "skipped", reason }` — scores are never
fabricated. Verification is skipped when `pdf.displayHeaderFooter` renders
header/footer chrome, when `pdf.pageRanges` cannot be mapped back onto the
document flow, or when the PDF has pages of differing sizes. Cancellation
(`CANCELLED`) still propagates as a conversion failure, not a skip.

#### `limits` options (safety rails)

Unlike quality policies, limits fail the conversion outright with
`RESOURCE_LIMIT_EXCEEDED` — they bound resource usage, not output
expectations.

| Key | Type | Default | Behavior |
| --- | --- | --- | --- |
| `maxRequests` | int 1–100000 | `500` | http(s) requests per conversion (favicon excluded); beyond the cap, requests are aborted at the network layer (`details.limit = "maxRequests"`) |
| `maxOutputBytes` | int ≥ 1 | — | Generated PDF size checked before inspection (`details.limit = "maxOutputBytes"`) |

#### `security` options

See [security](security.md). Defaults are the strict ones:
`allowLocalFiles: false`, `allowLoopback: false`, `allowPrivateNetwork: false`.

#### `browser` options

| Key | Type | Default | Meaning |
| --- | --- | --- | --- |
| `userAgent` | string (1–512 chars) | this Chromium's standard `Chrome` UA | User-Agent sent with every request of the conversion |

PageForge presents a standard `Chrome` UA by default — the `HeadlessChrome`
token removed — because production sites and WAFs frequently serve error
pages (403/500) to that string, and a conversion engine's job is to render
the site as its visitors see it. This changes the UA *string* only: TLS and
HTTP/2 fingerprints still identify an automated browser, so it is a
compatibility shim, not an anonymity control. Pass any string to override
it exactly (e.g. to reproduce what a specific client receives).

## Quality report

```ts
interface QualityReport {
  status: "succeeded";
  durationMs: number;
  timings: { readinessMs: number; renderMs: number }; // measured phases
  mode: "document" | "screen";
  browser: { name: "chromium"; version: string };
  pdf: { byteLength: number; pageCount: number; headerVersion: string };
  checks: QualityCheck[];    // { id, status: pass|warn|fail|skipped, detail, recommendation? }
  warnings: QualityWarning[];// { code, message, source: observed|heuristic }
  fidelity?: FidelityReport; // present when fidelity verification was enabled
}
```

`source` is load-bearing: `observed` means the browser or pdfjs reported it;
`heuristic` means it was estimated (DOM coordinates) and may be wrong.

When fidelity verification is enabled, `report.fidelity` carries the outcome:

```ts
interface FidelityReport {
  status: "measured" | "skipped";
  reason?: string;            // why verification was skipped
  score?: number;             // mean SSIM across sampled pages (measured only)
  threshold: number;          // the configured threshold at the time
  sampledPages: number[];     // 1-based PDF pages verified
  pages?: Array<{
    page: number;             // 1-based PDF page number
    ssim: number;             // mean structural similarity (0–1, heuristic)
    phashDistance: number;    // pHash Hamming distance (0 = same structure)
    alignmentOffsetPx: number;// vertical shift that best aligned the slice
    alignCorrelation: number; // ink-profile correlation at that alignment
  }>;
  durationMs?: number;
}
```

### Checks

| `id` | Present when | Notes |
| --- | --- | --- |
| `pdf-structure` | always | pdfjs parsed header + page tree |
| `readiness` | always | What actually ran: fonts/images/network idle/selector/settle + duration |
| `resources` | always | Failed requests, HTTP ≥ 400, broken images |
| `pdf-text` | always | Extractable character count (weak signal: presence, not reading order) |
| `security.requests` | always | Requests intercepted and classified against destination policy, plus the configured cap |
| `render.fidelity` | fidelity enabled | Mean SSIM of sampled pages against live-page screenshots; `skipped` (with the reason) when verification could not run |
| `screen.output-policy` | screen mode | The measured paper-fit scale |

### Warning codes

| Code | Source | Meaning |
| --- | --- | --- |
| `layout.horizontal-overflow` | heuristic | Content wider than the viewport |
| `screen.fixed-elements` | heuristic | `fixed`/`sticky` overlays may repeat or cover content |
| `screen.scrollable-containers` | heuristic | Scrolled-out content will not be captured |
| `resources.request-failed` | observed | A subresource request failed (see `errorText`) |
| `resources.http-error` | observed | A response returned HTTP ≥ 400 |
| `resources.broken-images` | observed | An `<img>` finished without decoding |
| `resources.font-unavailable` | observed | A `waitForFonts` family failed to load |
| `pdf.empty-pages` | observed | A page has no extractable text (may be blank/image-only) |
| `fidelity.low-score` | heuristic | Sampled pages scored below `fidelity.threshold` (visual comparison, not a pixel-perfectness claim) |
| `fidelity.skipped` | heuristic | Fidelity verification was enabled but could not run (see the reason) |

A browser-probed `/favicon.ico` 404 is excluded from resource issues: it says
nothing about the document being converted.

## Error codes

Part of the public contract: safe to branch on; new codes may be added in
minor releases, existing codes are not renamed within a major version.

| Code | Meaning |
| --- | --- |
| `INVALID_INPUT` | Bad value/type/cross-field conflict |
| `UNSUPPORTED_OPTION` | Known but unimplemented option or unknown key |
| `BLOCKED_URL` | Destination rejected by policy (protocol, private network, …), including page-scripted navigations to blocked destinations |
| `BLOCKED_REDIRECT` | A redirect landed on a destination rejected by security policy |
| `BLOCKED_RESOURCE` | A subresource request (or subresource redirect) was rejected by security policy |
| `LOCAL_FILE_NOT_ALLOWED` | File input without permission or outside the allowlist |
| `NAVIGATION_FAILED` | Navigation failed (DNS, connection, HTTP ≥ 400, crash, Chromium's own unsafe-redirect refusal) |
| `READINESS_TIMEOUT` | Overall readiness deadline elapsed (`details.stage` names it) |
| `RENDER_TIMEOUT` | `page.pdf()` exceeded its deadline |
| `PDF_VALIDATION_FAILED` | Output failed structural validation |
| `RESOURCE_LIMIT_EXCEEDED` | A configured limit was hit (`details.limit`: `maxRequests`, `maxOutputBytes`, `maxConcurrentConversions`) |
| `CANCELLED` | Aborted via `AbortSignal`/SIGINT |
| `BROWSER_FAILURE` | Chromium failed to launch/crashed/unexpected failure |
| `QUALITY_POLICY_FAILED` | Output rejected by a quality policy |
| `CONVERTER_CLOSED` | Conversion attempted after `close()` |

## Helpers

```ts
import { inspectPdf, sanitizeUrl, Deadline, classifyIp } from "pageforge-pdf";

// Structural inspection + optional text stats (what `pageforge inspect` uses).
const inspection = await inspectPdf(bytes, { extractText: true });
// → { byteLength, pageCount, headerVersion, text: { totalChars, perPageChars, emptyPages } | null }
```
