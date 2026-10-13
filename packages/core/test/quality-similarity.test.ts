import { describe, expect, it } from "vitest";
import {
  alignByCorrelation,
  boxBlur3,
  computeSsim,
  inkProfile,
  phash,
  phashDistance,
  resizeWindow,
  toGray,
  type GrayImage,
  type RgbaImage,
} from "../src/quality/similarity.js";

/** Deterministic pseudo-random sequence (mulberry32) so tests never flake. */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function grayFrom(width: number, height: number, fn: (x: number, y: number) => number): GrayImage {
  const data = new Float32Array(width * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      data[y * width + x] = fn(x, y);
    }
  }
  return { data, width, height };
}

function rgbaFrom(
  width: number,
  height: number,
  fn: (x: number, y: number) => readonly [number, number, number, number],
): RgbaImage {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const [r, g, b, a] = fn(x, y);
      const o = (y * width + x) * 4;
      data[o] = r;
      data[o + 1] = g;
      data[o + 2] = b;
      data[o + 3] = a;
    }
  }
  return { data, width, height };
}

/** Pseudo-random "text-like" grayscale pattern whose content correlates only at the true offset. */
function textLikeProfile(width: number, height: number, random: () => number): GrayImage {
  return grayFrom(width, height, () => (random() > 0.72 ? 40 : 245));
}

describe("toGray", () => {
  it("computes luminance for opaque pixels", () => {
    const image = rgbaFrom(1, 1, () => [255, 0, 0, 255]);
    expect(toGray(image).data[0]).toBeCloseTo(0.299 * 255, 5);
  });

  it("composites transparent pixels over white paper", () => {
    const image = rgbaFrom(1, 1, () => [0, 0, 0, 0]);
    expect(toGray(image).data[0]).toBe(255);
    const half = rgbaFrom(1, 1, () => [0, 0, 0, 128]);
    const gray = toGray(half).data[0] ?? -1;
    expect(gray).toBeGreaterThan(120);
    expect(gray).toBeLessThan(135);
  });
});

describe("boxBlur3", () => {
  it("leaves a uniform image unchanged", () => {
    const image = grayFrom(8, 8, () => 100);
    const blurred = boxBlur3(image);
    for (const value of blurred.data) expect(value).toBeCloseTo(100, 5);
  });

  it("spreads an impulse across its 3x3 neighborhood", () => {
    const image = grayFrom(5, 5, (x, y) => (x === 2 && y === 2 ? 255 : 0));
    const blurred = boxBlur3(image);
    expect(blurred.data[2 * 5 + 2]).toBeCloseTo(255 / 9, 3);
    expect(blurred.data[0]).toBe(0); // corner stays untouched by the impulse
  });
});

describe("computeSsim", () => {
  it("returns 1 for identical images", () => {
    const random = mulberry32(7);
    const image = grayFrom(40, 40, () => random() * 255);
    expect(computeSsim(image, image)).toBeCloseTo(1, 10);
  });

  it("returns near 0 for uncorrelated constant extremes (black vs white)", () => {
    const black = grayFrom(32, 32, () => 0);
    const white = grayFrom(32, 32, () => 255);
    expect(computeSsim(black, white)).toBeLessThan(0.05);
  });

  it("returns a lower score for shifted content than for aligned content", () => {
    const random = mulberry32(11);
    const content = grayFrom(48, 48, () => random() * 255);
    const shifted = grayFrom(48, 48, (x, y) => content.data[((y + 6) % 48) * 48 + x] ?? 0);
    const aligned = computeSsim(content, content);
    const unaligned = computeSsim(content, shifted);
    expect(unaligned).toBeLessThan(aligned);
  });

  it("rejects size mismatches explicitly", () => {
    const a = grayFrom(8, 8, () => 0);
    const b = grayFrom(8, 9, () => 0);
    expect(() => computeSsim(a, b)).toThrow(/size mismatch/);
  });

  it("returns 0 instead of NaN for images smaller than one window", () => {
    const tiny = grayFrom(2, 2, () => 10);
    expect(computeSsim(tiny, tiny)).toBe(0);
  });
});

describe("resizeWindow", () => {
  it("preserves values when resizing to identical dimensions", () => {
    const random = mulberry32(3);
    const image = grayFrom(16, 16, () => random() * 255);
    const resized = resizeWindow(image, 0, 16, 16, 16);
    for (let i = 0; i < image.data.length; i += 1) {
      expect(resized.data[i]).toBeCloseTo(image.data[i] ?? -1, 4);
    }
  });

  it("clamps sampling beyond the image without producing NaN", () => {
    const image = grayFrom(4, 10, (_x, y) => y * 10);
    const resized = resizeWindow(image, 95, 10, 4, 3); // window hangs off the bottom
    for (const value of resized.data) {
      expect(Number.isFinite(value)).toBe(true);
      expect(value).toBe(90); // clamped to the last row
    }
  });

  it("interpolates at fractional source rows", () => {
    const image = grayFrom(2, 4, (_x, y) => y * 10); // rows: 0, 10, 20, 30
    const resized = resizeWindow(image, 0, 2, 1, 3); // window covers rows [0, 2)
    expect(resized.data[0]).toBeCloseTo(0, 5);
    expect(resized.data[1]).toBeCloseTo((10 * 2) / 3, 5);
    expect(resized.data[2]).toBeCloseTo(10 * (1 - 1 / 3) + 20 * (1 / 3), 5);
  });
});

describe("inkProfile", () => {
  it("measures row darkness, ignoring color arrangement", () => {
    const stripes = grayFrom(10, 3, (x, y) => (y === 1 ? (x % 2 === 0 ? 0 : 255) : 255));
    const profile = inkProfile(stripes);
    expect(profile[0]).toBeCloseTo(0, 5);
    expect(profile[1]).toBeCloseTo(255 * (5 / 10), 5); // 5 dark + 5 light pixels per row
    expect(profile[2]).toBeCloseTo(0, 5);
  });
});

describe("alignByCorrelation", () => {
  it("recovers a known vertical shift between pdf page and strip", () => {
    const random = mulberry32(21);
    const pdf = textLikeProfile(24, 120, random);
    const nominal = 128;
    const shift = 14;
    // Strip: noise above, the pdf's rows at nominal+shift, noise below.
    const stripHeight = 320;
    const noise = textLikeProfile(24, stripHeight, random);
    const strip = grayFrom(24, stripHeight, (x, y) => {
      if (y >= nominal + shift && y < nominal + shift + 120) {
        return pdf.data[(y - nominal - shift) * 24 + x] ?? 255;
      }
      return noise.data[y * 24 + x] ?? 255;
    });
    const alignment = alignByCorrelation(pdf, strip, stripHeight - 120, nominal);
    expect(alignment.offset).toBe(nominal + shift);
    expect(alignment.score).toBeGreaterThan(0.9);
  });

  it("keeps the nominal offset when profiles are uniform (blank page)", () => {
    const pdf = grayFrom(16, 64, () => 255);
    const strip = grayFrom(16, 160, () => 255);
    const alignment = alignByCorrelation(pdf, strip, 96, 32);
    expect(alignment.offset).toBe(32);
  });

  it("clamps a nominal offset outside the searchable range", () => {
    const random = mulberry32(5);
    const pdf = textLikeProfile(16, 32, random);
    const strip = grayFrom(16, 64, (x, y) => pdf.data[y * 16 + x] ?? 255);
    const alignment = alignByCorrelation(pdf, strip, 32, 900);
    expect(alignment.offset).toBeLessThanOrEqual(32);
  });
});

describe("phash", () => {
  it("is stable for the same content and distance-0 against itself", () => {
    const random = mulberry32(13);
    const image = grayFrom(48, 48, () => random() * 255);
    const hash = phash(image);
    expect(hash).toMatch(/^[0-9a-f]{16}$/);
    expect(phashDistance(hash, phash(image))).toBe(0);
  });

  it("tolerates brightness shifts (pHash ignores absolute luminance)", () => {
    const random = mulberry32(17);
    const image = grayFrom(48, 48, () => 40 + random() * 120);
    const base = phash(image);
    const plusShift = grayFrom(48, 48, (x, y) => Math.min(255, (image.data[y * 48 + x] ?? 0) + 40));
    expect(phashDistance(base, phash(plusShift))).toBeLessThanOrEqual(8);
  });

  it("separates structured content from noise", () => {
    const random = mulberry32(23);
    const structured = grayFrom(48, 48, (x, y) => (Math.floor(x / 6) + Math.floor(y / 6)) % 2 === 0 ? 230 : 30);
    const noise = grayFrom(48, 48, () => random() * 255);
    expect(phashDistance(phash(structured), phash(noise))).toBeGreaterThan(8);
  });
});

describe("phashDistance", () => {
  it("counts differing bits", () => {
    expect(phashDistance("0000000000000000", "0000000000000000")).toBe(0);
    expect(phashDistance("0000000000000000", "ffffffffffffffff")).toBe(64);
    expect(phashDistance("0000000000000000", "000000000000000f")).toBe(4);
  });
});
