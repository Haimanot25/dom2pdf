# Rendering modes

PageForge renders through Chromium's own print pipeline — there is no
independent layout engine. What Chromium would put in its print preview is
what you get, within the limits of the PDF format. Pixel-perfect fidelity
between screen and print is **not** claimed and not measured.

## `document` mode (default)

Print CSS media: author `@media print` styles and `@page` rules apply exactly
as they would from the browser's print dialog.

```ts
await converter.convert({
  input: { type: "url", url: "https://example.com/article" },
  mode: "document", // optional; this is the default
  pdf: {
    format: "A4", // or width/height, e.g. { width: "210mm", height: "297mm" }
    margin: { top: "20mm", bottom: "20mm" },
    landscape: false,
    scale: 1, // 0.1–2
    printBackground: true, // PageForge default (Chromium's default is false)
    preferCSSPageSize: false, // true → the page's @page size wins
    pageRanges: "1-5, 8",
    outline: false, // embed heading outline
    tagged: false, // ask Chromium for a tagged PDF
  },
});
```

Paper resolution order:

1. `preferCSSPageSize: true` and an `@page` size → the author's size wins.
2. `width`/`height` if given (explicit paper; `format` must not be set too).
3. `format` (defaults to `A4`).

## `screen` mode

Screen CSS media at your configured viewport, then paginated onto paper under
an **output policy**. Use it when the page is designed for screens and print
styles would degrade it.

```ts
await converter.convert({
  input: { type: "url", url: "https://example.com/dashboard" },
  mode: "screen",
  viewport: { width: 1280, height: 720 },
});
```

### Output policies

| Policy | Status | Behavior |
| --- | --- | --- |
| `paper-fit` | ✅ implemented (default) | The viewport is scaled onto the paper's content width and paginates vertically at that scale. |
| `viewport-pages` | reserved | Rejected with `UNSUPPORTED_OPTION` until implemented. |
| `full-content` | reserved | Rejected with `UNSUPPORTED_OPTION` until implemented. |

**paper-fit math:** `scale = paper content width / viewport width`, clamped to
`[0.1, 1]` — content narrower than the paper is **never upscaled**. For a
1280px viewport on A4 (≈793.7px content width) that is ≈62%. The measured
value is reported in the `screen.output-policy` check, so you never have to
trust the documentation over the output.

### What screen mode reports additionally

Screen-specific layout diagnostics (labeled `heuristic` — DOM coordinates, not
pixel comparison):

- `layout.horizontal-overflow` — content wider than the viewport
- `screen.fixed-elements` — `position: fixed/sticky` overlays
- `screen.scrollable-containers` — nested scrollers whose hidden content
  will not be captured

Document mode does not emit these: print flow layout re-wraps content, so the
screen-viewport diagnostics do not transfer.

## Options rejected per mode

Validation happens before any browser work, with `INVALID_INPUT`:

| Option | `document` | `screen` |
| --- | --- | --- |
| `outputPolicy` | ✗ rejected | ✓ defaults to `{ type: "paper-fit" }` |
| `pdf.scale` | ✓ allowed | ✗ rejected (the policy owns scaling) |
| `pdf.preferCSSPageSize` | ✓ allowed | ✗ rejected (the policy owns the paper) |
