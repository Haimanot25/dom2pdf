# Contributing to dom2pdf

Thanks for helping. This document covers bug reports, feature requests, and
pull requests.

## Reporting bugs

The fastest way to get a bug fixed is a report we can reproduce. Include:

1. **dom2pdf version** (`dom2pdf --version` or your lockfile entry), Node
   version, and OS.
2. **The JSON report** from the failing run: `dom2pdf convert <target> -o
   out.pdf --json`.
3. **A diagnostics bundle** when the conversion fails:
   `dom2pdf convert <target> -o out.pdf --diagnostics` writes
   `out.pdf.diag/` (console transcript, failed requests, DOM, screenshot).
   Redact anything sensitive — the bundle contains page content.
4. **A minimal target** if you can: a small HTML file beats a production URL.

Search [existing issues](https://github.com/Haimanot25/dom2pdf/issues) first.

## Feature requests

Open an issue before writing the PR. A short discussion up front prevents
duplicates and design dead ends. Requests that weaken the project's honesty
rules (fabricated scores, swallowed errors, undocumented behavior) will be
declined regardless of implementation quality.

## Pull requests

1. **Tests for new behavior.** Unit tests (`packages/*/test`) for logic;
   e2e specs (`tests/`) for anything involving a real conversion. A PR
   without tests for changed behavior won't merge.
2. **No swallowed exceptions, no fake results.** A check that can't run
   reports `skipped` with a reason; a failure surfaces as a typed error.
   This rule is the project.
3. **Run the full gate before claiming done:**

   ```bash
   pnpm lint
   pnpm typecheck
   pnpm test:unit
   pnpm build
   pnpm test:e2e        # requires the pinned Chromium: pnpm browser:install
   ```

   CI runs exactly this. Green locally first.

4. **Comments are terse and factual.** One or two lines for non-obvious
   behavior, engine quirks, or security invariants. No narrative blocks, no
   storytelling. If you touch comments only, prove it:

   ```bash
   node scripts/check-comment-only.mjs
   ```

5. **Error codes are contract.** New codes may be added; existing codes are
   not renamed or repurposed. Document new codes in `docs/api.md`.

6. **Docs move with behavior.** If an option, check, warning, or default
   changes, the corresponding `docs/*.md` change in the same PR. Nothing is
   documented before it works — including in `README.md`.

## Project conventions

- Strict TypeScript, ESM, `zod`-validated options; unknown option keys are
  rejected, never ignored.
- Security defaults are conservative; anything dangerous is an explicit
  opt-in and is documented in `docs/security.md` — including its
  boundaries and residual risks.
- The benchmark harness must never estimate a missing engine; it reports
  `skipped`.

## Questions

[Open an issue](https://github.com/Haimanot25/dom2pdf/issues) — questions
that help others are welcome.
