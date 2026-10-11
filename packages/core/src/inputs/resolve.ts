import { pathToFileURL } from "node:url";
import type { NormalizedOptions } from "../config/normalize.js";
import { PageForgeError } from "../errors/index.js";
import {
  assertLocalFileAllowed,
  assertUrlDestinationAllowed,
  systemDnsLookup,
  type DestinationPolicy,
  type DnsLookup,
  type LocalFilePolicy,
} from "../security/destination-policy.js";
import { escapeHtmlAttribute, sanitizeUrl } from "../utils/url.js";

/** What the browser should do with a validated input. */
export type InputPlan =
  | { kind: "navigate"; url: string; source: "url" | "file" }
  | { kind: "html"; html: string; baseUrl: string | undefined };

/**
 * Runs all input-side security checks (protocol, network destination, local
 * file allowlist) and produces an execution plan. Throws typed errors; never
 * performs browser work.
 */
export async function prepareInput(
  options: NormalizedOptions,
  dnsLookup: DnsLookup = systemDnsLookup,
): Promise<InputPlan> {
  const destinationPolicy: DestinationPolicy = {
    allowLoopback: options.security.allowLoopback,
    allowPrivateNetwork: options.security.allowPrivateNetwork,
  };

  switch (options.input.type) {
    case "url": {
      const url = await assertUrlDestinationAllowed(options.input.url, destinationPolicy, dnsLookup);
      return { kind: "navigate", url: url.href, source: "url" };
    }
    case "file": {
      const filePolicy: LocalFilePolicy = {
        allowLocalFiles: options.security.allowLocalFiles,
        allowedLocalDirectories: options.security.allowedLocalDirectories,
      };
      const resolved = await assertLocalFileAllowed(options.input.path, filePolicy);
      return { kind: "navigate", url: pathToFileURL(resolved).href, source: "file" };
    }
    case "html": {
      let baseUrl: string | undefined;
      if (options.input.baseUrl !== undefined) {
        const url = await assertUrlDestinationAllowed(options.input.baseUrl, destinationPolicy, dnsLookup);
        if (url.username.length > 0 || url.password.length > 0) {
          throw new PageForgeError({
            code: "INVALID_INPUT",
            message: "input.baseUrl must not contain credentials",
            details: { baseUrl: sanitizeUrl(url) },
          });
        }
        baseUrl = url.href;
      }
      return { kind: "html", html: options.input.html, baseUrl };
    }
  }
}

/**
 * Injects `<base href>` for HTML-string inputs so relative references resolve.
 * An author-declared `<base>` always wins (we never inject in that case).
 */
export function injectBaseHref(html: string, baseUrl: string): string {
  if (/<base\s/i.test(html)) return html;
  const baseTag = `<base href="${escapeHtmlAttribute(baseUrl)}">`;
  const headMatch = /<head\b[^>]*>/i.exec(html);
  if (headMatch !== null) {
    return html.slice(0, headMatch.index + headMatch[0].length) + baseTag + html.slice(headMatch.index + headMatch[0].length);
  }
  const htmlMatch = /<html\b[^>]*>/i.exec(html);
  if (htmlMatch !== null) {
    const at = htmlMatch.index + htmlMatch[0].length;
    return html.slice(0, at) + baseTag + html.slice(at);
  }
  return baseTag + html;
}
