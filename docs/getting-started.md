# Getting started

dom2pdf is an HTML-to-PDF conversion engine built on Playwright's Chromium.
It ships as a library (`dom2pdf-js`) and a CLI (`dom2pdf`).

> **Status: pre-alpha (Phase 4 of 6).** Everything documented here works today
> and is covered by tests. Features still being built (request-layer security
> policies, resource limits, benchmarks) are listed in the README roadmap and
> are never described as complete before they are.

## Requirements

- Node.js ≥ 22.13.0
- pnpm (the repo pins its version via `packageManager`)
- A provisioned Chromium (`pnpm browser:install`, already run during setup)

## Build from source

```bash
git clone <repo> dom2pdf
cd dom2pdf
pnpm install
pnpm build          # builds the core library and the CLI
pnpm test           # unit tests, then end-to-end tests
```

## Library in 30 seconds

```ts
import { createConverter } from "dom2pdf-js";

const converter = await createConverter();
try {
  const result = await converter.convert({
    input: { type: "html", html: "<!doctype html><h1>Hello</h1>" },
    pdf: { format: "A4" },
  });
  await result.save("./hello.pdf");
  console.log(result.report); // structured, measured quality report
} finally {
  await converter.close();
}
```

Inputs: `{ type: "url", url }`, `{ type: "html", html, baseUrl? }`, and
`{ type: "file", path }` (requires an explicit local-file permission — see
[security](security.md)).

## CLI in 30 seconds

```bash
# URL → PDF
pnpm dom2pdf convert https://example.com -o example.pdf

# Local file → PDF (the CLI grants only the file's own directory)
pnpm dom2pdf convert ./report.html -o report.pdf --format A4 --margin 15mm

# HTML on stdin, machine-readable report on stdout
cat page.html | pnpm dom2pdf convert --stdin --json > /dev/stdout

# Inspect a PDF that was produced
pnpm dom2pdf inspect report.pdf --json
```

Exit codes are stable: `0` success, `2` usage error, `3` conversion failed,
`4` quality policy rejected the output, `130` cancelled with Ctrl-C. See the
[CLI reference](cli.md).

## Where to go next

- [Rendering modes](modes.md) — `document` vs `screen`, output policies
- [API reference](api.md) — every option, the report shape, error codes
- [CLI reference](cli.md) — commands, flags, JSON formats, exit codes
- [Security](security.md) — what is enforced today, and the residual risks we document honestly
- [Benchmark](benchmark.md) — deterministic multi-engine methodology and honesty rules
- [Releasing](releasing.md) — versioning, the verification gate, publishing
