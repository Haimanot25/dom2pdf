/** URL helpers focused on making URLs safe to print in logs and errors. */

const SENSITIVE_QUERY_PARAM = /^(?:token|key|secret|password|passwd|sig|signature|access_token|refresh_token|id_token|api_key|apikey|auth|authorization|session|code)$/i;

/**
 * Returns a representation of `input` that is safe to embed in logs, error
 * messages, and reports: userinfo (credentials) removed, sensitive query
 * parameters redacted, and the fragment dropped entirely.
 *
 * Unparseable input is returned truncated rather than thrown, because this is
 * used on the error path.
 */
export function sanitizeUrl(input: string | URL): string {
  const raw = typeof input === "string" ? input : input.href;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return raw.length > 200 ? `${raw.slice(0, 200)}…` : raw;
  }
  url.username = "";
  url.password = "";
  url.hash = "";
  const params = url.searchParams;
  for (const key of [...params.keys()]) {
    if (SENSITIVE_QUERY_PARAM.test(key)) {
      params.set(key, "REDACTED");
    }
  }
  url.search = params.toString();
  const result = url.toString();
  // WHATWG keeps a trailing "?" for empty queries; drop it for cleanliness.
  return result.endsWith("?") ? result.slice(0, -1) : result;
}

/** Escapes a value for safe interpolation into a double-quoted HTML attribute. */
export function escapeHtmlAttribute(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

/** Replaces non-printable bytes so binary previews can go into error details. */
export function sanitizeBytesForDisplay(bytes: Uint8Array, max = 16): string {
  let out = "";
  for (let i = 0; i < Math.min(bytes.length, max); i += 1) {
    const byte = bytes[i] ?? 0;
    out += byte >= 0x20 && byte <= 0x7e ? String.fromCharCode(byte) : ".";
  }
  if (bytes.length > max) out += "…";
  return out;
}
