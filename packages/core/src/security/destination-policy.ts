import { lookup } from "node:dns/promises";
import { realpath } from "node:fs/promises";
import { isIP } from "node:net";
import path from "node:path";
import { PageForgeError } from "../errors/index.js";
import { sanitizeUrl } from "../utils/url.js";

/**
 * Destination and filesystem policies.
 *
 * Layered SSRF defense (see docs/security.md): this module checks the
 * *explicit* destination before navigation — protocol, IP-literal
 * classification, and a pre-navigation DNS resolution whose *every* address is
 * classified. Browser-side request interception is a second, independent layer
 * (Phase 5), and deployments must additionally enforce egress rules, because
 * no in-process check can fully defeat DNS rebinding.
 */

export interface DestinationPolicy {
  allowLoopback: boolean;
  allowPrivateNetwork: boolean;
}

export interface LocalFilePolicy {
  allowLocalFiles: boolean;
  allowedLocalDirectories: readonly string[];
}

export type IpClassification = "loopback" | "private" | "link-local" | "reserved" | "public";

export interface ResolvedAddress {
  address: string;
}

export type DnsLookup = (hostname: string) => Promise<ResolvedAddress[]>;

/** Default DNS check: OS-level resolution of *every* address for the hostname. */
export const systemDnsLookup: DnsLookup = async (hostname) => {
  try {
    return await lookup(hostname, { all: true });
  } catch (cause) {
    throw new PageForgeError({
      code: "NAVIGATION_FAILED",
      message: `DNS lookup failed for host "${hostname}"`,
      details: { hostname },
      cause,
    });
  }
};

function classifyIpv4(ip: string): IpClassification {
  const octets = ip.split(".").map((part) => Number.parseInt(part, 10));
  const [a = 0, b = 0, c = 0] = octets;
  if (a === 127) return "loopback";
  if (a === 0) return "reserved"; // "this network"
  if (a === 10) return "private";
  if (a === 172 && b >= 16 && b <= 31) return "private";
  if (a === 192 && b === 168) return "private";
  if (a === 100 && b >= 64 && b <= 127) return "private"; // CGNAT (RFC 6598)
  if (a === 169 && b === 254) return "link-local"; // includes cloud metadata 169.254.169.254
  if (a === 192 && b === 0 && c === 0) return "reserved";
  if (a === 192 && b === 0 && c === 2) return "reserved"; // TEST-NET-1
  if (a === 198 && (b === 18 || b === 19)) return "reserved"; // benchmarking
  if (a === 198 && b === 51 && c === 100) return "reserved"; // TEST-NET-2
  if (a === 203 && b === 0 && c === 113) return "reserved"; // TEST-NET-3
  if (a >= 224) return "reserved"; // multicast + reserved + broadcast
  return "public";
}

/** Expands an IPv6 literal to its 8 hextets, or null if it cannot be parsed. */
function ipv6Hextets(ip: string): number[] | null {
  const parts = ip.split("::");
  if (parts.length > 2) return null;
  const parseSide = (side: string): number[] | null => {
    if (side.length === 0) return [];
    const out: number[] = [];
    for (const group of side.split(":")) {
      if (group.includes(".")) {
        // Embedded IPv4 in the trailing group (e.g. ::ffff:1.2.3.4).
        if (isIP(group) !== 4) return null;
        const [a, b, c, d] = group.split(".").map((x) => Number.parseInt(x, 10));
        out.push(((a ?? 0) << 8) | (b ?? 0), ((c ?? 0) << 8) | (d ?? 0));
        continue;
      }
      if (!/^[0-9a-f]{1,4}$/.test(group)) return null;
      out.push(Number.parseInt(group, 16));
    }
    return out;
  };

  const head = parseSide(parts[0] ?? "");
  if (head === null) return null;

  if (parts.length === 1) {
    return head.length === 8 ? head : null;
  }

  const tail = parseSide(parts[1] ?? "");
  if (tail === null) return null;
  const fill = 8 - head.length - tail.length;
  if (fill < 1) return null;
  return [...head, ...new Array<number>(fill).fill(0), ...tail];
}

function classifyIpv6(ip: string): IpClassification {
  const h = ipv6Hextets(ip.toLowerCase());
  if (h === null) {
    // Unparseable IPv6 is treated as non-public: blocked unless explicitly allowed.
    return "reserved";
  }
  const isZeroes = (from: number, to: number): boolean => h.slice(from, to).every((v) => v === 0);

  if (h[0] === 0 && isZeroes(1, 7) && h[7] === 1) return "loopback"; // ::1
  if (h.every((v) => v === 0)) return "reserved"; // ::

  // IPv4-mapped (::ffff:a.b.c.d) and deprecated IPv4-compatible (::a.b.c.d)
  // forms classify as their embedded IPv4 address.
  const c = h[6] ?? 0;
  const d = h[7] ?? 0;
  if (isZeroes(0, 5) && (h[5] === 0xffff || h[5] === 0) && (c !== 0 || d !== 0)) {
    return classifyIpv4(`${(c >> 8) & 0xff}.${c & 0xff}.${(d >> 8) & 0xff}.${d & 0xff}`);
  }

  const first = h[0] ?? 0;
  if ((first & 0xfe00) === 0xfc00) return "private"; // fc00::/7 unique-local
  if ((first & 0xffc0) === 0xfe80) return "link-local"; // fe80::/10
  if ((first & 0xff00) === 0xff00) return "reserved"; // ff00::/8 multicast
  if (first === 0x2001 && h[1] === 0x0db8) return "reserved"; // 2001:db8::/32 documentation
  if (first === 0x0100 && (h[1] ?? 0) === 0) return "reserved"; // 100::/64 discard-only
  return "public";
}

export function classifyIp(ip: string): IpClassification {
  const family = isIP(ip);
  if (family === 4) return classifyIpv4(ip);
  if (family === 6) return classifyIpv6(ip);
  throw new PageForgeError({
    code: "INVALID_INPUT",
    message: `"${ip}" is not a valid IP address`,
    details: { ip },
  });
}

function blocked(
  ip: string,
  classification: IpClassification,
  policy: DestinationPolicy,
  url: URL,
): PageForgeError {
  const why =
    classification === "loopback"
      ? "loopback destinations require security.allowLoopback"
      : "private/link-local/reserved destinations require security.allowPrivateNetwork";
  return new PageForgeError({
    code: "BLOCKED_URL",
    message: `Blocked navigation to ${ip} (${classification}): ${why}`,
    details: {
      destination: ip,
      classification,
      url: sanitizeUrl(url),
      policy: { allowLoopback: policy.allowLoopback, allowPrivateNetwork: policy.allowPrivateNetwork },
    },
  });
}

/** Throws `BLOCKED_URL` when `ip` is not permitted by `policy`. */
export function assertIpAllowed(ip: string, policy: DestinationPolicy, url: URL): void {
  const classification = classifyIp(ip);
  switch (classification) {
    case "public":
      return;
    case "loopback":
      if (!policy.allowLoopback) throw blocked(ip, classification, policy, url);
      return;
    case "private":
    case "link-local":
    case "reserved":
      if (!policy.allowPrivateNetwork) throw blocked(ip, classification, policy, url);
      return;
  }
}

const ALLOWED_PROTOCOLS = new Set(["http:", "https:"]);

/**
 * Validates an explicit navigation URL: parses it, enforces the protocol
 * allowlist, classifies IP literals, and (for hostnames) resolves DNS first and
 * classifies every returned address.
 */
export async function assertUrlDestinationAllowed(
  rawUrl: string,
  policy: DestinationPolicy,
  dnsLookup: DnsLookup = systemDnsLookup,
): Promise<URL> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch (cause) {
    throw new PageForgeError({
      code: "INVALID_INPUT",
      message: `Invalid URL: ${rawUrl.length > 200 ? `${rawUrl.slice(0, 200)}…` : rawUrl}`,
      cause,
    });
  }

  if (!ALLOWED_PROTOCOLS.has(url.protocol)) {
    throw new PageForgeError({
      code: "BLOCKED_URL",
      message: `Blocked navigation to protocol "${url.protocol}" — only http: and https: are allowed`,
      details: { protocol: url.protocol, url: sanitizeUrl(url) },
    });
  }

  const hostname = url.hostname.replace(/^\[/, "").replace(/\]$/, "");
  if (hostname.length === 0) {
    throw new PageForgeError({ code: "INVALID_INPUT", message: "URL has no host", details: { url: sanitizeUrl(url) } });
  }

  if (isIP(hostname) !== 0) {
    assertIpAllowed(hostname, policy, url);
    return url;
  }

  const addresses = await dnsLookup(hostname);
  if (addresses.length === 0) {
    throw new PageForgeError({
      code: "NAVIGATION_FAILED",
      message: `DNS lookup returned no addresses for host "${hostname}"`,
      details: { hostname },
    });
  }
  for (const { address } of addresses) {
    assertIpAllowed(address, policy, url);
  }
  return url;
}

/**
 * Validates a local file path against the explicit allowlist and returns its
 * canonical (symlink-resolved) absolute path.
 *
 * Local input is opt-in (`security.allowLocalFiles` + at least one directory in
 * `security.allowedLocalDirectories`), restricted to `.html`/`.htm`, and
 * symlinks cannot escape the allowed directories because containment is checked
 * after `realpath`.
 */
export async function assertLocalFileAllowed(rawPath: string, policy: LocalFilePolicy): Promise<string> {
  if (!policy.allowLocalFiles || policy.allowedLocalDirectories.length === 0) {
    throw new PageForgeError({
      code: "LOCAL_FILE_NOT_ALLOWED",
      message:
        "Local file input is disabled — set security.allowLocalFiles: true and list security.allowedLocalDirectories",
      details: { path: rawPath },
    });
  }

  const resolved = path.resolve(rawPath);
  const extension = path.extname(resolved).toLowerCase();
  if (extension !== ".html" && extension !== ".htm") {
    throw new PageForgeError({
      code: "INVALID_INPUT",
      message: `Local input must be an .html or .htm file; received extension "${extension || "(none)"}"`,
      details: { path: resolved },
    });
  }

  let canonical: string;
  try {
    canonical = await realpath(resolved);
  } catch (cause) {
    throw new PageForgeError({
      code: "INVALID_INPUT",
      message: `Local file not found or unreadable: ${resolved}`,
      details: { path: resolved },
      cause,
    });
  }

  const canonicalRealDirs: string[] = [];
  for (const dir of policy.allowedLocalDirectories) {
    try {
      canonicalRealDirs.push(await realpath(path.resolve(dir)));
    } catch {
      // A missing allowed directory simply never matches.
    }
  }

  const contained = canonicalRealDirs.some((dir) => {
    const relative = path.relative(dir, canonical);
    return relative.length > 0 && !relative.startsWith("..") && !path.isAbsolute(relative);
  });

  if (!contained) {
    throw new PageForgeError({
      code: "LOCAL_FILE_NOT_ALLOWED",
      message: `Local file is outside security.allowedLocalDirectories: ${canonical}`,
      details: { path: canonical, allowedDirectories: canonicalRealDirs },
    });
  }

  return canonical;
}
