# Releasing

PageForge uses semver. All workspace packages share one version (currently
`0.1.0-alpha.0`) so a release is a single bump: `pageforge-pdf`,
`pageforge-cli`, and `pageforge-benchmark` always match.

## Version bump

1. Pick the version (`0.1.0-alpha.1`, `0.1.0`, …). Error codes may be added
   in minor releases — note them in the changelog.
2. Update `version` in all four `package.json` files (root + the three
   packages).
3. Update `CHANGELOG.md`: move the unreleased section under the new version
   and date.
4. Docs must match reality: no feature is documented before it works, and
   `docs/security.md` must state exactly what is enforced.

## Verification (the gate)

Run on a clean tree:

```bash
pnpm lint
pnpm typecheck
pnpm test:unit
pnpm build
pnpm test:e2e
pnpm benchmark --iterations 1 --warmup 0 --scenarios simple   # smoke
```

All must exit 0 (unit/e2e may report their known skips). Also verify the
container builds and converts:

```bash
docker build -t pageforge:alpha .
docker run --rm --cap-add=SYS_ADMIN -v "$PWD/fixtures:/work" \
  pageforge:alpha convert /work/basic-text.html -o /work/out.pdf
```

`--cap-add=SYS_ADMIN` is required on stock Docker + Ubuntu 24.04 (noble):
the default seccomp/AppArmor profile blocks the user-namespace creation
Chromium's **sandbox** uses, and PageForge never disables the sandbox. The
capability grants namespace permission only — seccomp stays enabled.
`--security-opt seccomp=unconfined` also works; `--no-sandbox` is not
supported by PageForge and the CLI will refuse to fake a result for it.
The container runs as a non-root user (`pageforge`, uid 10001), which the
sandbox additionally requires.

## Publish

```bash
git commit -am "release: v0.1.0-alpha.1"
git tag v0.1.0-alpha.1 && git push --follow-tags
pnpm publish -r          # workspace:* deps are rewritten to the real version
```

Publish order is handled by `pnpm publish -r` (topological: core →
benchmark → cli). Each package needs an npm account with 2FA; dry-run first
with `pnpm publish -r --dry-run`.

## After the release

- Verify the published tarballs: `npm pack pageforge-pdf --dry-run` should
  contain `dist/` only.
- Open the next milestone and move deferred items forward.
