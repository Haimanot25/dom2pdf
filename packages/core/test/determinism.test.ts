import { describe, expect, it } from "vitest";
import { DEFAULTS, normalizeOptions, parseConvertOptions } from "../src/config/normalize.js";
import { PageForgeError } from "../src/errors/index.js";
import { digestFromPages, normalizePdfDates } from "../src/pdf/determinism.js";

const htmlInput = { type: "html" as const, html: "<p>x</p>" };

function bytesOf(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

function textOf(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

describe("normalizePdfDates", () => {
  it("zeroes digits inside both date stamps and preserves byte length", () => {
    const pdf = bytesOf(
      "%PDF-1.7\n" +
        "1 0 obj\n<< /Title (Report) /CreationDate (D:20261012234501+02'30') /ModDate (D:20261012234502+02'30') >>\nendobj\n" +
        "trailer\n<< /Root 1 0 R >>\n",
    );
    const result = normalizePdfDates(pdf);
    expect(result.normalizedSpans).toBe(2);
    expect(result.residual).toBe(0);
    expect(result.bytes.length).toBe(pdf.length);
    const text = textOf(result.bytes);
    expect(text).toContain("/CreationDate (D:00000000000000+00'00')");
    expect(text).toContain("/ModDate (D:00000000000000+00'00')");
    // Structure around the stamps is untouched.
    expect(text).toContain("/Title (Report)");
    expect(text.startsWith("%PDF-1.7")).toBe(true);
    // The caller's buffer is never mutated.
    expect(textOf(pdf)).toContain("/CreationDate (D:20261012234501");
  });

  it("normalizes a negative UTC-offset sign to '+'", () => {
    const input = bytesOf("/ModDate (D:20260101000000-05'00')");
    const result = normalizePdfDates(input);
    expect(result.bytes.length).toBe(input.length);
    expect(textOf(result.bytes)).toContain("(D:00000000000000+00'00')");
    expect(result.normalizedSpans).toBe(1);
  });

  it("leaves other parenthesized numbers outside the date keys untouched", () => {
    const pdf = bytesOf("/Count 3 /MediaBox (0 0 595 842) /CreationDate (D:20260101000000Z)");
    const text = textOf(normalizePdfDates(pdf).bytes);
    expect(text).toContain("/MediaBox (0 0 595 842)");
    expect(text).toContain("/CreationDate (D:00000000000000Z)");
  });

  it("counts a date key whose value is not a literal string as residual", () => {
    const result = normalizePdfDates(bytesOf("/CreationDate 5 /ModDate (D:20260101000000Z)"));
    expect(result.normalizedSpans).toBe(1);
    expect(result.residual).toBe(1);
    expect(textOf(result.bytes)).toContain("/CreationDate 5");
  });

  it("counts an unterminated literal string as residual", () => {
    const result = normalizePdfDates(bytesOf("/ModDate (D:20260101000000Z"));
    expect(result.normalizedSpans).toBe(0);
    expect(result.residual).toBe(1);
  });

  it("does not match a date name glued to a longer key", () => {
    const result = normalizePdfDates(bytesOf("/MyModDate (D:20260101000000Z) /XCreationDate (D:20260101000000Z)"));
    expect(result.normalizedSpans).toBe(0);
    expect(result.residual).toBe(0);
  });

  it("handles escaped characters inside the literal string", () => {
    const result = normalizePdfDates(bytesOf("/ModDate (D:20260101000000\\)tail) /Other 1"));
    expect(result.normalizedSpans).toBe(1);
    expect(result.residual).toBe(0);
    // The escaped paren stays escaped; digits are zeroed before it.
    expect(textOf(result.bytes)).toContain("(D:00000000000000\\)tail)");
  });

  it("returns an unchanged copy when no date keys exist", () => {
    const pdf = bytesOf("%PDF-1.4\n1 0 obj\n<< >>\nendobj\n");
    const result = normalizePdfDates(pdf);
    expect(result.normalizedSpans).toBe(0);
    expect(result.residual).toBe(0);
    expect(textOf(result.bytes)).toBe(textOf(pdf));
  });
});

describe("digestFromPages", () => {
  it("is stable for the same page count and text", () => {
    const first = digestFromPages(2, ["Hello  world", "Page two"]);
    const second = digestFromPages(2, ["Hello world", "Page two"]);
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(first).toBe(second); // whitespace differences do not change the digest
  });

  it("separates pages so shifted content changes the digest", () => {
    expect(digestFromPages(2, ["ab", "c"])).not.toBe(digestFromPages(2, ["a", "bc"]));
  });

  it("includes the page count", () => {
    expect(digestFromPages(1, ["abc"])).not.toBe(digestFromPages(2, ["abc", ""]));
  });

  it("changes when the text changes", () => {
    expect(digestFromPages(1, ["abc"])).not.toBe(digestFromPages(1, ["abd"]));
  });
});

describe("deterministic convert option", () => {
  it("defaults to false and passes explicit values through", () => {
    const normalized = normalizeOptions(parseConvertOptions({ input: htmlInput }));
    expect(normalized.deterministic).toBe(false);
    expect(normalized.deterministic).toBe(DEFAULTS.deterministicEnabled);
    const enabled = normalizeOptions(parseConvertOptions({ input: htmlInput, deterministic: true }));
    expect(enabled.deterministic).toBe(true);
  });

  it("rejects non-boolean values with a typed error", () => {
    for (const deterministic of ["yes", 1, {}]) {
      let caught: unknown;
      try {
        parseConvertOptions({ input: htmlInput, deterministic });
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(PageForgeError);
    }
  });
});
