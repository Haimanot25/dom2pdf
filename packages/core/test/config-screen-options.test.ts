import { describe, expect, it } from "vitest";
import { normalizeOptions, parseConvertOptions } from "../src/config/normalize.js";
import { PageForgeError } from "../src/errors/index.js";

const htmlInput = { type: "html" as const, html: "<p>x</p>" };

function expectCode(fn: () => unknown, code: string): PageForgeError {
  let caught: unknown;
  try {
    fn();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(PageForgeError);
  const error = caught as PageForgeError;
  expect(error.code).toBe(code);
  return error;
}

describe("screen mode options", () => {
  it("accepts mode 'screen' and defaults outputPolicy to paper-fit", () => {
    const normalized = normalizeOptions({ input: htmlInput, mode: "screen" });
    expect(normalized.mode).toBe("screen");
    expect(normalized.outputPolicy).toEqual({ type: "paper-fit" });
  });

  it("keeps outputPolicy undefined in document mode", () => {
    expect(normalizeOptions({ input: htmlInput }).outputPolicy).toBeUndefined();
    expect(normalizeOptions({ input: htmlInput, mode: "document" }).outputPolicy).toBeUndefined();
  });

  it("accepts an explicit paper-fit policy for screen mode", () => {
    const normalized = normalizeOptions({
      input: htmlInput,
      mode: "screen",
      outputPolicy: { type: "paper-fit" },
    });
    expect(normalized.outputPolicy).toEqual({ type: "paper-fit" });
  });

  it("rejects outputPolicy in document mode", () => {
    expectCode(
      () => parseConvertOptions({ input: htmlInput, outputPolicy: { type: "paper-fit" } }),
      "INVALID_INPUT",
    );
    expectCode(
      () => parseConvertOptions({ input: htmlInput, mode: "document", outputPolicy: { type: "paper-fit" } }),
      "INVALID_INPUT",
    );
  });

  it("rejects reserved output policies with UNSUPPORTED_OPTION", () => {
    for (const type of ["viewport-pages", "full-content"]) {
      const error = expectCode(
        () => parseConvertOptions({ input: htmlInput, mode: "screen", outputPolicy: { type } }),
        "UNSUPPORTED_OPTION",
      );
      expect(error.message).toContain(type);
      expect(error.message).toContain("paper-fit");
    }
  });

  it("rejects unknown output policy names", () => {
    expectCode(
      () => parseConvertOptions({ input: htmlInput, mode: "screen", outputPolicy: { type: "whatever" } }),
      "INVALID_INPUT",
    );
  });

  it("rejects explicit pdf.scale in screen mode (the policy owns scaling)", () => {
    expectCode(
      () => parseConvertOptions({ input: htmlInput, mode: "screen", pdf: { scale: 1.5 } }),
      "INVALID_INPUT",
    );
    // …but pdf.scale is fine in document mode.
    expect(parseConvertOptions({ input: htmlInput, pdf: { scale: 1.5 } }).pdf?.scale).toBe(1.5);
  });

  it("rejects preferCSSPageSize in screen mode (the policy owns the paper)", () => {
    expectCode(
      () =>
        parseConvertOptions({
          input: htmlInput,
          mode: "screen",
          pdf: { preferCSSPageSize: true },
        }),
      "INVALID_INPUT",
    );
  });
});

describe("length validation", () => {
  it("accepts numbers and px/in/cm/mm strings", () => {
    for (const width of [800, "800px", "210mm", "8.5in", "10cm"]) {
      expect(() => parseConvertOptions({ input: htmlInput, pdf: { width, height: 600 } })).not.toThrow();
      expect(() =>
        parseConvertOptions({ input: htmlInput, pdf: { margin: { top: width } } }),
      ).not.toThrow();
    }
  });

  it("rejects unparseable length strings", () => {
    for (const width of ["abc", "10em", "10pt", "50%", "-20px"]) {
      expectCode(() => parseConvertOptions({ input: htmlInput, pdf: { width, height: 600 } }), "INVALID_INPUT");
    }
  });
});

describe("cancellation signal option", () => {
  it("accepts a real AbortSignal and passes it through", () => {
    const controller = new AbortController();
    const normalized = normalizeOptions({ input: htmlInput, signal: controller.signal });
    expect(normalized.signal).toBe(controller.signal);
  });

  it("defaults to no signal", () => {
    expect(normalizeOptions({ input: htmlInput }).signal).toBeUndefined();
  });

  it("rejects non-AbortSignal values", () => {
    expectCode(() => parseConvertOptions({ input: htmlInput, signal: { aborted: false } }), "INVALID_INPUT");
    expectCode(() => parseConvertOptions({ input: htmlInput, signal: "abort" }), "INVALID_INPUT");
  });
});
