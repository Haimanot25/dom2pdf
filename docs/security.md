# Security

PageForge's stance: **secure by default, explicit opt-in for anything
dangerous, honest documentation about what is and is not enforced.** Each
layer assumes the others can fail.

> This page describes what is enforced **today (Phase 5)**. Every error code in
> the catalog is now produced by real code paths — the only exception is the
> native-layer cases called out under [Residual risks](#residual-risks-be-honest-about-these).

## Defaults

| Control | Default |
| --- | --- |
| Chromium sandbox (`chromiumSandbox`) | **enabled** — Playwright's own default disables it; PageForge explicitly passes `chromiumSandbox: true` |
| URL input protocol allowlist | `http:`/`https:` only — `ftp:`, `file:`, `javascript:`, `data:` … rejected with `BLOCKED_URL` |
| Loopback destinations (`localhost`, `127.0.0.0/8`, `::1`) | denied unless `security.allowLoopback: true` |
| Private/link-local/metadata (RFC1918, `169.254.0.0/16`, `100.64.0.0/10`, …) | denied unless `security.allowPrivateNetwork: true` |
| Local file input | denied unless `security.allowLocalFiles: true` **and** the path resolves inside `security.allowedLocalDirectories` |
| Credentials in URLs | rejected in `baseUrl`; stripped/redacted in every message, log, and report (`sanitizeUrl`), including Playwright's own net-error text |
| Requests per conversion | capped at `limits.maxRequests` (default `500`) → `RESOURCE_LIMIT_EXCEEDED` |
| Output size | uncapped by default; `limits.maxOutputBytes` hard-fails larger output with `RESOURCE_LIMIT_EXCEEDED` |
| Concurrent conversions | unlimited by default; `createConverter({ limits: { maxConcurrentConversions } })` fails fast with `RESOURCE_LIMIT_EXCEEDED` |

## Layer 1 — destination policy (pre-navigation)

Before the browser sees a URL:

1. **Protocol check** against the allowlist.
2. **IP-literal check**: literal addresses are classified directly
   (public / loopback / private / link-local / reserved).
3. **DNS classification**: hostnames are resolved (lookup is injectable for
   tests) and **every** returned address must classify as public — a hostname
   resolving to `127.0.0.1` is blocked like the literal would be.

## Layer 2 — request interception (per conversion)

Every conversion installs a request guard on its browser context *before*
navigation:

- **Every http(s) request** the page makes beyond the pre-validated plan —
  subresources, iframes, popups, page-scripted `fetch` — is classified by the
  same protocol/destination policy. Rejections abort the request at the
  network layer (before Chromium performs DNS/connect for it) and fail the
  conversion with `BLOCKED_RESOURCE`.
- **Page-scripted main-frame navigations** to blocked destinations
  (`location.href = "http://169.254.169.254/"`) are aborted and fail the
  conversion with `BLOCKED_URL`.
- **Redirect hops** cannot be intercepted by Playwright (Chromium follows them
  inside its network stack — verified behavior, see residual risks), so each
  redirect response's `Location` target is classified the moment the redirect
  is issued. A blocked target fails the conversion with `BLOCKED_REDIRECT`.
- **The request cap** (`limits.maxRequests`, default 500) aborts further
  traffic once exceeded — a request flood stops instead of merely being
  counted — and fails with `RESOURCE_LIMIT_EXCEEDED`.
- The browser-probed `/favicon.ico` is excluded: it says nothing about the
  document author's choices.

## Layer 3 — local files

`{ type: "file" }` input requires explicit permission, and the path is
verified **after** resolving to its real location, so symlink escapes fail the
containment check. Only directories you allowlist are readable this way.

The CLI scopes permission to the directory of the path you typed — an explicit
path on the command line is explicit consent for that file.

## Layer 4 — process isolation and limits

Every conversion runs in a fresh browser context: no cookies, storage, cache,
or service-worker state survives between jobs, and contexts are destroyed on
every exit path (success, failure, timeout, cancellation). The Chromium
sandbox stays on.

Back-pressure is fail-fast: `createConverter({ limits: { maxConcurrentConversions:
N} })` rejects additional conversions with `RESOURCE_LIMIT_EXCEEDED` instead of
queueing them, so callers control their own scheduling. Generated output is
checked against `limits.maxOutputBytes` before inspection.

## Residual risks (be honest about these)

- **Redirect hops are followed by Chromium itself.** Playwright does not
  expose redirect follow-ups to request interception, so a redirect onto a
  private address is detected from the `Location` header (the typed
  `BLOCKED_REDIRECT` verdict lands within milliseconds), but Chromium's own
  connection attempt to the target happens natively first — it typically
  hangs or fails against an unreachable address, and the bounded navigation
  deadline turns that into a fast typed failure. Against a *reachable* private
  host, a TCP connection is made before the conversion fails. Deployment-level
  egress rules are the real defense for untrusted workloads.
- **Unsafe redirect schemes** (`http` → `file:`) are refused by Chromium
  itself with `net::ERR_UNSAFE_REDIRECT` before any response is delivered;
  PageForge surfaces that as `NAVIGATION_FAILED` with the native error —
  there is no classified hop to report, and we do not pretend otherwise.
- **DNS rebinding (TOCTOU):** addresses are validated at check time; the
  browser resolves again when it connects (for redirect hops, natively, see
  above). Hostname-based checks are advisory against an adversary who controls
  DNS.
- **Heuristic warnings are not security controls.** Layout/resource diagnostics
  describe rendering, not trustworthiness.

For anything exposed to untrusted input, run PageForge with network egress
policy at the infrastructure level (allowlist destinations, deny metadata
endpoints) and in an isolated container — its in-process checks are one layer,
not the perimeter.
