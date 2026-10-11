# Security

PageForge's stance: **secure by default, explicit opt-in for anything
dangerous, honest documentation about what is and is not enforced.** Each
layer assumes the others can fail.

> This page describes what is enforced **today (Phase 4)**. The error codes
> `BLOCKED_REDIRECT`, `BLOCKED_RESOURCE`, and `RESOURCE_LIMIT_EXCEEDED` exist
> in the catalog but are **not yet enforced** — request-layer policies and
> resource limits arrive in Phase 5. Do not rely on them yet.

## Defaults

| Control | Default |
| --- | --- |
| Chromium sandbox (`chromiumSandbox`) | **enabled** — Playwright's own default disables it; PageForge explicitly passes `chromiumSandbox: true` |
| URL input protocol allowlist | `http:`/`https:` only — `ftp:`, `file:`, `javascript:`, `data:` … rejected with `BLOCKED_URL` |
| Loopback destinations (`localhost`, `127.0.0.0/8`, `::1`) | denied unless `security.allowLoopback: true` |
| Private/link-local/metadata (RFC1918, `169.254.0.0/16`, `100.64.0.0/10`, …) | denied unless `security.allowPrivateNetwork: true` |
| Local file input | denied unless `security.allowLocalFiles: true` **and** the path resolves inside `security.allowedLocalDirectories` |
| Credentials in URLs | rejected in `baseUrl`; stripped/redacted in every message, log, and report (`sanitizeUrl`) |

## Layer 1 — destination policy (pre-navigation)

Before the browser sees a URL:

1. **Protocol check** against the allowlist.
2. **IP-literal check**: literal addresses are classified directly
   (public / loopback / private / link-local / reserved).
3. **DNS classification**: hostnames are resolved (lookup is injectable for
   tests) and **every** returned address must classify as public — a hostname
   resolving to `127.0.0.1` is blocked like the literal would be.
4. **Redirects**: Chromium follows redirects during navigation. Redirect
   destination validation is **not yet enforced** (Phase 5).

## Layer 2 — local files

`{ type: "file" }` input requires explicit permission, and the path is
verified **after** resolving to its real location, so symlink escapes fail the
containment check. Only directories you allowlist are readable this way.

The CLI scopes permission to the directory of the path you typed — an explicit
path on the command line is explicit consent for that file.

## Layer 3 — process isolation

Every conversion runs in a fresh browser context: no cookies, storage, cache,
or service-worker state survives between jobs, and contexts are destroyed on
every exit path (success, failure, timeout, cancellation). The Chromium
sandbox stays on.

## Residual risks (be honest about these)

- **Subresources are not yet policy-checked.** Once a permitted page loads, its
  own `<img>`/`<script>`/`fetch` targets are not filtered (Phase 5 adds
  `BLOCKED_RESOURCE`).
- **Redirects are not yet policy-checked** (Phase 5 adds `BLOCKED_REDIRECT`).
- **DNS rebinding (TOCTOU):** addresses are validated at check time; the
  browser resolves again when it connects. Deployment-level egress rules are
  the real defense for untrusted workloads.
- **No resource limits yet** (Phase 5): output size/page/time limits beyond
  the readiness/render deadlines are not enforced (`RESOURCE_LIMIT_EXCEEDED`
  unused so far).
- **Heuristic warnings are not security controls.** Layout/resource diagnostics
  describe rendering, not trustworthiness.

For anything exposed to untrusted input, run PageForge with network egress
policy at the infrastructure level (allowlist destinations, deny metadata
endpoints) and in an isolated container — its in-process checks are one layer,
not the perimeter.
