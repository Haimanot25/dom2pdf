# CLI reference

The `pageforge` binary lives in `apps/cli` and contains **no conversion
logic** — every command delegates to the `pageforge-pdf` library. In this
repository run it as `pnpm pageforge …`.

## Exit codes (stable contract)

| Code | Meaning |
| --- | --- |
| `0` | Success |
| `2` | Usage error: unknown command/flag, missing or invalid argument |
| `3` | Conversion/inspection failed with a typed error |
| `4` | Output rejected by a configured quality policy |
| `130` | Cancelled with Ctrl-C (128 + SIGINT) |

## `pageforge convert [source]`

`source` is an `http(s)` URL or a local file path. Use `--stdin` instead to
read HTML from a pipe. Anything with a URL scheme (`ftp://…`) is sent to the
library as a URL and rejected there with `BLOCKED_URL` (exit 3), not a usage
error.

```bash
pageforge convert https://example.com -o example.pdf
pageforge convert ./report.html -o report.pdf --format A4 --margin 15mm
cat page.html | pageforge convert --stdin -o out.pdf
pageforge convert ./dashboard.html --mode screen --viewport 1440x900
pageforge convert ./invoice.html --min-pages 1 --max-pages 4 --json > report.json
```

### Flags

**Output**

| Flag | Meaning |
| --- | --- |
| `-o, --output <path>` | Output path (default `pageforge.pdf`) |
| `--json` | Print the quality report as JSON on stdout (errors as JSON on stderr) |
| `--quiet` | Suppress success output; errors still go to stderr |

**Rendering**

| Flag | Maps to |
| --- | --- |
| `--mode document\|screen` | `mode` |
| `--format <A4…>` | `pdf.format` |
| `--landscape` | `pdf.landscape` |
| `--scale <0.1–2>` | `pdf.scale` (document mode only) |
| `--margin <spec>` | `pdf.margin` — one value (`15mm`) or `top,right,bottom,left` |
| `--page-ranges <"1-5, 8">` | `pdf.pageRanges` |
| `--prefer-css-page-size` | `pdf.preferCSSPageSize` |
| `--no-print-background` | `pdf.printBackground: false` |
| `--outline`, `--tagged` | `pdf.outline`, `pdf.tagged` |
| `--viewport <WxH>` | `viewport` |

**Readiness / quality**

| Flag | Maps to |
| --- | --- |
| `--timeout <ms>` | `readiness.timeoutMs` |
| `--render-timeout <ms>` | `render.timeoutMs` |
| `--min-pages`, `--max-pages` | `quality.minPages/maxPages` |
| `--min-text-chars <n>` | `quality.minTextChars` |
| `--max-bytes <n>` | `quality.maxBytes` |
| `--fail-on-warnings` | `quality.failOnWarnings` |

**Security**

| Flag | Maps to |
| --- | --- |
| `--allow-loopback` | `security.allowLoopback` |
| `--allow-private-network` | `security.allowPrivateNetwork` |

Local files need no flag: passing a path on the command line is explicit
consent, and the CLI grants only **that file's own directory**
(`allowLocalFiles` + an allowlist of `dirname(source)`); the library still
verifies the resolved path (symlinks included).

### Cancellation

Ctrl-C (SIGINT) aborts the in-flight conversion: the browser context is
cleaned up and the process exits `130` with `CANCELLED` on stderr.

## `pageforge inspect <file>`

Structurally inspects an existing PDF using the library's inspector:

```bash
pageforge inspect report.pdf
# report.pdf: 3 page(s) · 45.2 KB · %PDF-1.4
#   text: 12345 character(s) across 3 page(s) · empty pages: none

pageforge inspect report.pdf --json
```

`--json` prints:

```json
{
  "file": "…/report.pdf",
  "byteLength": 46312,
  "pageCount": 3,
  "headerVersion": "1.4",
  "text": { "totalChars": 12345, "perPageChars": [4001, 4398, 3946], "emptyPages": [] }
}
```

A missing or unreadable file exits `3` (`INVALID_INPUT`).

## JSON formats

- **Success:** the quality report (see [API](api.md#quality-report)) on
  **stdout**.
- **Failure:** `{"error": {"name","code","message","details?"}}` on
  **stderr** — for quality failures `details` carries the `violations` and
  the full measured `report`.

Stdout therefore stays machine-parseable in both directions: the report on
success, nothing on failure.
