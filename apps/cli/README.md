# dom2pdf-cli

Command-line interface for [dom2pdf](https://www.npmjs.com/package/dom2pdf-js)
— convert URLs/HTML to PDF, inspect PDFs, and run the multi-engine benchmark.

```bash
npm install -g dom2pdf-cli
```

## Commands

```bash
dom2pdf convert https://example.com -o example.pdf
dom2pdf convert ./report.html --format A4 --margin 15mm --json
dom2pdf convert --stdin -o out.pdf < page.html
dom2pdf inspect report.pdf --json
dom2pdf benchmark --iterations 3 --scenarios simple
```

Useful `convert` flags: `--mode document|screen`, `--format A4|Letter|…`,
`--margin 15mm` (or `top,right,bottom,left`), `--page-ranges "1-5, 8"`,
`--min-pages`/`--max-bytes`/`--fail-on-warnings` (quality policies),
`--diagnostics` (failure forensics written to `<output>.diag/`),
`--deterministic` (byte-identical repeated conversions on the same browser
build), and `--json` (structured quality report on stdout).

Security is deny-by-default: `--allow-loopback` / `--allow-private-network`
opt in per run; local file input is automatically scoped to the input
file's own directory.

## Exit codes (stable contract)

| Code | Meaning |
| --- | --- |
| 0 | success |
| 2 | usage error (unknown flag, invalid argument) |
| 3 | conversion/inspection failed (typed library error) |
| 4 | output rejected by a quality policy |
| 130 | cancelled via SIGINT |

Requires Node.js >= 22.13.
