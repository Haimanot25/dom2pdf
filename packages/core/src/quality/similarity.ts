/**
 * Pure image-similarity primitives behind the render-fidelity phase.
 *
 * These functions are deliberately self-contained: they take plain
 * `{ data, width, height }` images (any RGBA byte buffer plus dimensions),
 * import nothing, and close over nothing outside their own bodies. That lets
 * the fidelity pipeline stringify them into the verification Chromium page
 * (where the PDF is re-rasterized with pdf.js and compared against live-page
 * screenshots) while the exact same source is unit-tested in Node against
 * synthetic arrays. Keep them free of imports and module-scope state.
 *
 * All metrics run on grayscale images. `computeSsim` expects inputs that were
 * already converted with `toGray` (and typically softened with `boxBlur3`);
 * the caller applies blur/resize so each step stays individually testable.
 */

export interface GrayImage {
  readonly data: Float32Array;
  readonly width: number;
  readonly height: number;
}

export interface RgbaImage {
  readonly data: Uint8ClampedArray | Uint8Array;
  readonly width: number;
  readonly height: number;
}

/** Converts an RGBA buffer to grayscale luminance (0..255), compositing over white so transparent pixels are paper-colored. */
export function toGray(image: RgbaImage): GrayImage {
  const { width, height } = image;
  const out = new Float32Array(width * height);
  for (let i = 0; i < out.length; i += 1) {
    const o = i * 4;
    const alpha = (image.data[o + 3] ?? 0) / 255;
    const r = image.data[o] ?? 0;
    const g = image.data[o + 1] ?? 0;
    const b = image.data[o + 2] ?? 0;
    const luminance = 0.299 * r + 0.587 * g + 0.114 * b;
    // Transparent source pixels show the page background (white paper).
    out[i] = luminance * alpha + 255 * (1 - alpha);
  }
  return { data: out, width, height };
}

/** 3x3 box blur; softens antialiasing/hinting differences so SSIM measures layout, not glyph rasterizer noise. */
export function boxBlur3(image: GrayImage): GrayImage {
  const { width, height } = image;
  const src = image.data;
  const out = new Float32Array(src.length);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      let sum = 0;
      let count = 0;
      for (let dy = -1; dy <= 1; dy += 1) {
        const yy = y + dy;
        if (yy < 0 || yy >= height) continue;
        for (let dx = -1; dx <= 1; dx += 1) {
          const xx = x + dx;
          if (xx < 0 || xx >= width) continue;
          sum += src[yy * width + xx] ?? 0;
          count += 1;
        }
      }
      out[y * width + x] = count === 0 ? 0 : sum / count;
    }
  }
  return { data: out, width, height };
}

/**
 * Bilinearly resizes the vertical window `[sourceY, sourceY + sourceHeight)` of
 * the image to `targetWidth x targetHeight`. Sampling outside the image clamps
 * to the edge row, so a scroll-clamped strip or a raster taller than its strip
 * still compares cleanly.
 */
export function resizeWindow(
  image: GrayImage,
  sourceY: number,
  sourceHeight: number,
  targetWidth: number,
  targetHeight: number,
): GrayImage {
  const { width: sw, height: sh } = image;
  const src = image.data;
  const out = new Float32Array(targetWidth * targetHeight);
  for (let y = 0; y < targetHeight; y += 1) {
    const sy = sourceY + (y * sourceHeight) / targetHeight;
    const ya = Math.floor(sy);
    const yb = ya + 1;
    const wy = sy - ya;
    const ra = Math.min(sh - 1, Math.max(0, ya));
    const rb = Math.min(sh - 1, Math.max(0, yb));
    for (let x = 0; x < targetWidth; x += 1) {
      const fx = Math.min(sw - 1, (x * sw) / targetWidth);
      const xa = Math.floor(fx);
      const xb = Math.min(sw - 1, xa + 1);
      const wx = fx - xa;
      const top = (src[ra * sw + xa] ?? 0) * (1 - wx) + (src[ra * sw + xb] ?? 0) * wx;
      const bottom = (src[rb * sw + xa] ?? 0) * (1 - wx) + (src[rb * sw + xb] ?? 0) * wx;
      out[y * targetWidth + x] = top * (1 - wy) + bottom * wy;
    }
  }
  return { data: out, width: targetWidth, height: targetHeight };
}

/**
 * Mean structural similarity over 8x8 windows (stride 4) of two equally sized
 * grayscale images. Returns 1 for identical images, ~0 for uncorrelated ones,
 * and can go negative for strongly inverted content.
 */
export function computeSsim(a: GrayImage, b: GrayImage): number {
  if (a.width !== b.width || a.height !== b.height) {
    throw new Error(`SSIM size mismatch: ${a.width}x${a.height} vs ${b.width}x${b.height}`);
  }
  const { width: w, height: h } = a;
  const c1 = (0.01 * 255) ** 2;
  const c2 = (0.03 * 255) ** 2;
  const win = 8;
  const stride = 4;
  let sum = 0;
  let count = 0;
  for (let y = 0; y + win <= h; y += stride) {
    for (let x = 0; x + win <= w; x += stride) {
      let ma = 0;
      let mb = 0;
      for (let dy = 0; dy < win; dy += 1) {
        for (let dx = 0; dx < win; dx += 1) {
          const o = (y + dy) * w + x + dx;
          ma += a.data[o] ?? 0;
          mb += b.data[o] ?? 0;
        }
      }
      const n = win * win;
      ma /= n;
      mb /= n;
      let va = 0;
      let vb = 0;
      let cov = 0;
      for (let dy = 0; dy < win; dy += 1) {
        for (let dx = 0; dx < win; dx += 1) {
          const o = (y + dy) * w + x + dx;
          const da = (a.data[o] ?? 0) - ma;
          const db = (b.data[o] ?? 0) - mb;
          va += da * da;
          vb += db * db;
          cov += da * db;
        }
      }
      va /= n;
      vb /= n;
      cov /= n;
      const luminance = (2 * ma * mb + c1) / (ma * ma + mb * mb + c1);
      const contrast = (2 * cov + c2) / (va + vb + c2);
      sum += luminance * contrast;
      count += 1;
    }
  }
  return count === 0 ? 0 : sum / count;
}

/** Per-row mean darkness (255 - gray); the 1-D signal used for coarse alignment. */
export function inkProfile(image: GrayImage): Float64Array {
  const { width: w, height: h } = image;
  const profile = new Float64Array(h);
  for (let y = 0; y < h; y += 1) {
    let sum = 0;
    for (let x = 0; x < w; x += 1) {
      sum += 255 - (image.data[y * w + x] ?? 0);
    }
    profile[y] = sum / w;
  }
  return profile;
}

export interface Alignment {
  /** Strip row that best aligns with row 0 of the PDF page image. */
  offset: number;
  /** Pearson correlation of the ink profiles at the chosen offset (−1..1). */
  score: number;
}

/**
 * Coarse vertical alignment: scans every strip offset and returns the one
 * whose ink profile best correlates with the PDF page's profile. Print
 * pagination breaks at content boundaries (widows/orphans, keep-together
 * blocks), so page N of the PDF rarely starts exactly at the nominal slice —
 * this recovers the true boundary before SSIM scoring. Ties resolve toward the
 * nominal offset so uniform (blank) profiles never drift randomly.
 */
export function alignByCorrelation(pdf: GrayImage, strip: GrayImage, maxOffset: number, nominal: number): Alignment {
  const pdfProfile = inkProfile(pdf);
  const stripProfile = inkProfile(strip);
  const n = pdf.height;
  const scoreAt = (offset: number): number => {
    let sumP = 0;
    let sumS = 0;
    for (let y = 0; y < n; y += 1) {
      sumP += pdfProfile[y] ?? 0;
      sumS += stripProfile[offset + y] ?? 0;
    }
    const meanP = sumP / n;
    const meanS = sumS / n;
    let varP = 0;
    let varS = 0;
    let cov = 0;
    for (let y = 0; y < n; y += 1) {
      const dp = (pdfProfile[y] ?? 0) - meanP;
      const ds = (stripProfile[offset + y] ?? 0) - meanS;
      varP += dp * dp;
      varS += ds * ds;
      cov += dp * ds;
    }
    const denominator = Math.sqrt(Math.max(1e-9, varP * varS));
    return cov / denominator;
  };
  const start = Math.min(Math.max(0, nominal), Math.max(0, maxOffset));
  let best: Alignment = { offset: start, score: scoreAt(start) };
  for (let offset = 0; offset <= maxOffset; offset += 1) {
    if (offset === best.offset) continue;
    const score = scoreAt(offset);
    if (score > best.score) best = { offset, score };
  }
  return best;
}

/**
 * Perceptual hash: resize to 32x32, 2-D DCT, keep the low-frequency 8x8
 * block, and threshold each coefficient against the block median. Returned as
 * 16 hex characters (64 bits). Compared via `phashDistance`, this gives a
 * scale-invariant structural cross-check alongside SSIM.
 */
export function phash(image: GrayImage): string {
  const size = 32;
  const small = resizeWindow(image, 0, image.height, size, size);
  const cos = new Float64Array(size * size);
  for (let u = 0; u < size; u += 1) {
    for (let t = 0; t < size; t += 1) {
      cos[u * size + t] = Math.cos((Math.PI / size) * (t + 0.5) * u);
    }
  }
  // Row transform, then column transform.
  const rows = new Float64Array(size * size);
  for (let y = 0; y < size; y += 1) {
    for (let u = 0; u < size; u += 1) {
      let sum = 0;
      for (let t = 0; t < size; t += 1) {
        sum += (small.data[y * size + t] ?? 0) * (cos[u * size + t] ?? 0);
      }
      rows[y * size + u] = sum;
    }
  }
  const coeffs = new Float64Array(size * size);
  for (let u = 0; u < size; u += 1) {
    for (let v = 0; v < size; v += 1) {
      let sum = 0;
      for (let t = 0; t < size; t += 1) {
        sum += (rows[t * size + u] ?? 0) * (cos[v * size + t] ?? 0);
      }
      coeffs[v * size + u] = sum;
    }
  }
  const low = new Float64Array(64);
  for (let v = 0; v < 8; v += 1) {
    for (let u = 0; u < 8; u += 1) {
      low[v * 8 + u] = coeffs[v * size + u] ?? 0;
    }
  }
  const sorted = Float64Array.from(low).sort();
  const median = ((sorted[31] ?? 0) + (sorted[32] ?? 0)) / 2;
  let hex = "";
  for (let nibble = 0; nibble < 16; nibble += 1) {
    let bits = 0;
    for (let bit = 0; bit < 4; bit += 1) {
      const index = nibble * 4 + bit;
      if ((low[index] ?? 0) > median) bits |= 1 << (3 - bit);
    }
    hex += bits.toString(16);
  }
  return hex;
}

/** Hamming distance between two pHash hex strings: 0 = identical structure, up to 64 = unrelated. */
export function phashDistance(a: string, b: string): number {
  let distance = 0;
  for (let i = 0; i < 16; i += 1) {
    const na = Number.parseInt(a[i] ?? "0", 16);
    const nb = Number.parseInt(b[i] ?? "0", 16);
    let bits = na ^ nb;
    while (bits !== 0) {
      distance += bits & 1;
      bits >>= 1;
    }
  }
  return distance;
}
