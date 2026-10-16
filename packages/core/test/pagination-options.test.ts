import { describe, expect, it } from "vitest";
import { DEFAULTS, normalizeOptions, parseConvertOptions } from "../src/config/normalize.js";
import { Dom2PdfError } from "../src/errors/index.js";

const htmlInput = { type: "html" as const, html: "<p>x</p>" };

function expectCode(fn: () => unknown, code: string): Dom2PdfError {
  let caught: unknown;
  try {
    fn();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(Dom2PdfError);
  const error = caught as Dom2PdfError;
  expect(error.code).toBe(code);
  return error;
}

describe("pagination options", () => {
  it("defaults to keepTogether: false (pagination unchanged unless opted in)", () => {
    const normalized = normalizeOptions({ input: htmlInput });
    expect(normalized.pagination.keepTogether).toBe(false);
    expect(DEFAULTS.paginationKeepTogether).toBe(false);
  });

  it("accepts pagination.keepTogether: true and passes it through", () => {
    const parsed = parseConvertOptions({ input: htmlInput, pagination: { keepTogether: true } });
    expect(parsed.pagination?.keepTogether).toBe(true);
    expect(normalizeOptions({ input: htmlInput, pagination: { keepTogether: true } }).pagination.keepTogether).toBe(
      true,
    );
  });

  it("passes an explicit false through unchanged", () => {
    const normalized = normalizeOptions({ input: htmlInput, pagination: { keepTogether: false } });
    expect(normalized.pagination.keepTogether).toBe(false);
  });

  it("rejects unknown keys inside pagination with UNSUPPORTED_OPTION", () => {
    const error = expectCode(
      () => parseConvertOptions({ input: htmlInput, pagination: { keepTogetherMaybe: true } }),
      "UNSUPPORTED_OPTION",
    );
    expect(error.message).toContain("keepTogetherMaybe");
  });

  it("rejects a non-boolean keepTogether with INVALID_INPUT", () => {
    expectCode(
      () => parseConvertOptions({ input: htmlInput, pagination: { keepTogether: "yes" } }),
      "INVALID_INPUT",
    );
  });

  it("rejects a non-object pagination value with INVALID_INPUT", () => {
    expectCode(() => parseConvertOptions({ input: htmlInput, pagination: true }), "INVALID_INPUT");
  });
});
