import { describe, expect, it } from "vitest";
import { Dom2PdfError } from "../src/errors/index.js";
import {
  assertIpAllowed,
  assertUrlDestinationAllowed,
  classifyIp,
  type DestinationPolicy,
  type DnsLookup,
} from "../src/security/destination-policy.js";

const DENY_ALL: DestinationPolicy = { allowLoopback: false, allowPrivateNetwork: false };

function fakeDns(...addresses: string[]): DnsLookup {
  return async () => addresses.map((address) => ({ address }));
}

function expectBlocked(fn: () => unknown): Dom2PdfError {
  let caught: unknown;
  try {
    fn();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(Dom2PdfError);
  const error = caught as Dom2PdfError;
  expect(error.code).toBe("BLOCKED_URL");
  return error;
}

async function expectBlockedAsync(promise: Promise<unknown>): Promise<Dom2PdfError> {
  let caught: unknown;
  try {
    await promise;
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(Dom2PdfError);
  const error = caught as Dom2PdfError;
  expect(error.code).toBe("BLOCKED_URL");
  return error;
}

describe("classifyIp", () => {
  it("classifies IPv4 ranges", () => {
    expect(classifyIp("127.0.0.1")).toBe("loopback");
    expect(classifyIp("127.8.9.10")).toBe("loopback");
    expect(classifyIp("10.1.2.3")).toBe("private");
    expect(classifyIp("172.16.0.1")).toBe("private");
    expect(classifyIp("172.31.255.255")).toBe("private");
    expect(classifyIp("172.32.0.1")).toBe("public");
    expect(classifyIp("192.168.1.1")).toBe("private");
    expect(classifyIp("169.254.169.254")).toBe("link-local"); // cloud metadata
    expect(classifyIp("100.64.0.1")).toBe("private");
    expect(classifyIp("0.0.0.0")).toBe("reserved");
    expect(classifyIp("224.0.0.1")).toBe("reserved");
    expect(classifyIp("255.255.255.255")).toBe("reserved");
    expect(classifyIp("8.8.8.8")).toBe("public");
    expect(classifyIp("93.184.216.34")).toBe("public");
  });

  it("classifies IPv6 ranges", () => {
    expect(classifyIp("::1")).toBe("loopback");
    expect(classifyIp("::")).toBe("reserved");
    expect(classifyIp("fc00::1")).toBe("private");
    expect(classifyIp("fd12:3456::1")).toBe("private");
    expect(classifyIp("fe80::1")).toBe("link-local");
    expect(classifyIp("ff02::1")).toBe("reserved");
    expect(classifyIp("2001:db8::1")).toBe("reserved");
    expect(classifyIp("2606:4700:4700::1111")).toBe("public");
    expect(classifyIp("::ffff:127.0.0.1")).toBe("loopback");
    expect(classifyIp("::ffff:192.168.0.1")).toBe("private");
  });

  it("rejects non-IP input", () => {
    expect(() => classifyIp("not-an-ip")).toThrowError(Dom2PdfError);
  });
});

describe("assertIpAllowed", () => {
  const url = new URL("https://example.com/");

  it("allows public addresses under any policy", () => {
    expect(() => assertIpAllowed("93.184.216.34", DENY_ALL, url)).not.toThrow();
  });

  it("blocks loopback unless allowLoopback", () => {
    expectBlocked(() => assertIpAllowed("127.0.0.1", DENY_ALL, url));
    expect(() => assertIpAllowed("127.0.0.1", { allowLoopback: true, allowPrivateNetwork: false }, url)).not.toThrow();
    // allowPrivateNetwork alone does NOT unlock loopback.
    expectBlocked(() => assertIpAllowed("127.0.0.1", { allowLoopback: false, allowPrivateNetwork: true }, url));
  });

  it("blocks private and link-local unless allowPrivateNetwork", () => {
    expectBlocked(() => assertIpAllowed("10.0.0.7", DENY_ALL, url));
    expectBlocked(() => assertIpAllowed("169.254.169.254", DENY_ALL, url));
    expect(() =>
      assertIpAllowed("10.0.0.7", { allowLoopback: false, allowPrivateNetwork: true }, url),
    ).not.toThrow();
  });
});

describe("assertUrlDestinationAllowed", () => {
  it("rejects malformed URLs with INVALID_INPUT", async () => {
    await expect(assertUrlDestinationAllowed("not a url", DENY_ALL)).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });
  });

  it("rejects non-http(s) protocols", async () => {
    for (const raw of ["ftp://example.com/", "file:///etc/passwd", "javascript:alert(1)", "data:text/html,x"]) {
      await expect(assertUrlDestinationAllowed(raw, DENY_ALL)).rejects.toMatchObject({ code: "BLOCKED_URL" });
    }
  });

  it("classifies IP-literal hosts without DNS", async () => {
    await expect(assertUrlDestinationAllowed("http://127.0.0.1/", DENY_ALL)).rejects.toMatchObject({
      code: "BLOCKED_URL",
    });
    await expect(assertUrlDestinationAllowed("http://[::1]/", DENY_ALL)).rejects.toMatchObject({
      code: "BLOCKED_URL",
    });
    await expect(assertUrlDestinationAllowed("http://169.254.169.254/latest/meta-data/", DENY_ALL)).rejects.toMatchObject(
      { code: "BLOCKED_URL" },
    );
    const allowed = await assertUrlDestinationAllowed("http://93.184.216.34/", DENY_ALL);
    expect(allowed.hostname).toBe("93.184.216.34");
  });

  it("resolves DNS and blocks when any resolved address is private", async () => {
    const lookup = fakeDns("93.184.216.34", "10.0.0.1");
    const error = await expectBlockedAsync(assertUrlDestinationAllowed("http://rebind.example/", DENY_ALL, lookup));
    expect(error.details).toMatchObject({ destination: "10.0.0.1", classification: "private" });
  });

  it("blocks hostnames that resolve only to loopback", async () => {
    await expect(
      assertUrlDestinationAllowed("http://intranet.example/", DENY_ALL, fakeDns("127.0.0.1")),
    ).rejects.toMatchObject({ code: "BLOCKED_URL" });
    // Explicit opt-in allows it.
    const allowed = await assertUrlDestinationAllowed(
      "http://intranet.example/",
      { allowLoopback: true, allowPrivateNetwork: false },
      fakeDns("127.0.0.1"),
    );
    expect(allowed.hostname).toBe("intranet.example");
  });

  it("allows hostnames resolving to public addresses", async () => {
    const url = await assertUrlDestinationAllowed(
      "https://example.com/page?q=1",
      DENY_ALL,
      fakeDns("93.184.216.34"),
    );
    expect(url.href).toBe("https://example.com/page?q=1");
  });

  it("maps DNS failures to NAVIGATION_FAILED", async () => {
    const failing: DnsLookup = async () => {
      throw new Dom2PdfError({ code: "NAVIGATION_FAILED", message: "DNS lookup failed" });
    };
    await expect(assertUrlDestinationAllowed("http://nope.example/", DENY_ALL, failing)).rejects.toMatchObject({
      code: "NAVIGATION_FAILED",
    });
  });

  it("treats empty DNS results as navigation failure", async () => {
    await expect(assertUrlDestinationAllowed("http://empty.example/", DENY_ALL, fakeDns())).rejects.toMatchObject({
      code: "NAVIGATION_FAILED",
    });
  });
});
