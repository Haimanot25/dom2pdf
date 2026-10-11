import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { normalizeOptions } from "../src/config/normalize.js";
import { injectBaseHref, prepareInput } from "../src/inputs/resolve.js";
import type { DnsLookup } from "../src/security/destination-policy.js";

const publicDns: DnsLookup = async () => [{ address: "93.184.216.34" }];
const loopbackDns: DnsLookup = async () => [{ address: "127.0.0.1" }];

const FIXTURES_DIR = path.resolve(fileURLToPath(new URL("../../../fixtures", import.meta.url)));

describe("prepareInput", () => {
  it("plans navigation for validated URL inputs", async () => {
    const options = normalizeOptions({ input: { type: "url", url: "https://example.com/page" } });
    const plan = await prepareInput(options, publicDns);
    expect(plan).toEqual({ kind: "navigate", url: "https://example.com/page", source: "url" });
  });

  it("blocks loopback URLs unless allowed", async () => {
    const options = normalizeOptions({ input: { type: "url", url: "http://127.0.0.1:8080/" } });
    await expect(prepareInput(options, loopbackDns)).rejects.toMatchObject({ code: "BLOCKED_URL" });

    const permissive = normalizeOptions({
      input: { type: "url", url: "http://127.0.0.1:8080/" },
      security: { allowLoopback: true },
    });
    const plan = await prepareInput(permissive, loopbackDns);
    expect(plan).toMatchObject({ kind: "navigate", url: "http://127.0.0.1:8080/" });
  });

  it("plans file:// navigation only when explicitly permitted", async () => {
    const filePath = path.join(FIXTURES_DIR, "basic-text.html");
    const denied = normalizeOptions({ input: { type: "file", path: filePath } });
    await expect(prepareInput(denied)).rejects.toMatchObject({ code: "LOCAL_FILE_NOT_ALLOWED" });

    const allowed = normalizeOptions({
      input: { type: "file", path: filePath },
      security: { allowLocalFiles: true, allowedLocalDirectories: [FIXTURES_DIR] },
    });
    const plan = await prepareInput(allowed);
    expect(plan.kind).toBe("navigate");
    expect(plan.kind === "navigate" && plan.url.startsWith("file:///")).toBe(true);
    expect(plan.kind === "navigate" && plan.url.endsWith("basic-text.html")).toBe(true);
  });

  it("passes HTML through with a validated baseUrl", async () => {
    const options = normalizeOptions({
      input: { type: "html", html: "<p>x</p>", baseUrl: "https://example.com/docs/" },
    });
    const plan = await prepareInput(options, publicDns);
    expect(plan).toEqual({ kind: "html", html: "<p>x</p>", baseUrl: "https://example.com/docs/" });
  });

  it("rejects credentials in baseUrl", async () => {
    const options = normalizeOptions({
      input: { type: "html", html: "<p>x</p>", baseUrl: "https://user:pass@example.com/" },
    });
    await expect(prepareInput(options, publicDns)).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });

  it("applies network policy to baseUrl", async () => {
    const options = normalizeOptions({
      input: { type: "html", html: "<p>x</p>", baseUrl: "http://127.0.0.1/assets/" },
    });
    await expect(prepareInput(options, loopbackDns)).rejects.toMatchObject({ code: "BLOCKED_URL" });
  });

  it("rejects non-http baseUrl protocols", async () => {
    const options = normalizeOptions({
      input: { type: "html", html: "<p>x</p>", baseUrl: "file:///etc/" },
    });
    await expect(prepareInput(options, publicDns)).rejects.toMatchObject({ code: "BLOCKED_URL" });
  });
});

describe("injectBaseHref", () => {
  it("injects right after <head>", () => {
    const result = injectBaseHref("<html><head><title>t</title></head><body></body></html>", "https://example.com/");
    expect(result).toContain('<head><base href="https://example.com/"><title>t</title>');
  });

  it("injects after <html> when there is no explicit head", () => {
    const result = injectBaseHref('<html lang="en"><body><p>x</p></body></html>', "https://example.com/");
    expect(result).toContain('<html lang="en"><base href="https://example.com/">');
  });

  it("prepends for fragments", () => {
    const result = injectBaseHref("<p>x</p>", "https://example.com/");
    expect(result.startsWith('<base href="https://example.com/">')).toBe(true);
  });

  it("never overrides an author-declared base", () => {
    const html = "<html><head><base href=\"https://author.example/\"></head></html>";
    expect(injectBaseHref(html, "https://ours.example/")).toBe(html);
  });

  it("escapes the href attribute", () => {
    const result = injectBaseHref("<html><head></head></html>", 'https://example.com/?a="b"');
    expect(result).toContain("&quot;");
    expect(result).not.toContain('a="b"');
  });
});
