/**
 * Deterministic photo quality checks, run before any model call. A photo that is
 * too dark, too bright or too blurred cannot support a verdict, so the report is
 * declined in code with a specific reason (brief rule 5).
 *
 * Thresholds were calibrated on testset/dev only (originals: brightness >= 0.275,
 * sharpness >= 9.1; copies darkened to 10% <= 0.068; blurred sigma 3 <= 2.4).
 */
import sharp from "sharp";
import type { ImageVariant } from "./preprocess";

/** Metrics are measured on a fixed-size copy so they do not depend on resolution. */
const MEASURE_LONG_SIDE = 1024;

export interface PhotoQuality {
  /** Mean luminance, 0 (black) .. 1 (white). */
  brightness: number;
  /** Standard deviation of the Laplacian (0..255 scale); low means blurred or featureless. */
  sharpness: number;
}

export const QUALITY_LIMITS = {
  minBrightness: 0.08,
  maxBrightness: 0.94,
  minSharpness: 4,
};

export async function measureQuality(image: ImageVariant): Promise<PhotoQuality> {
  // Note: sharp's stats() describes the pipeline input, so materialise the
  // greyscale copy first and compute everything from its raw pixels.
  const { data, info } = await sharp(image.jpeg)
    // Never upscale: an enlarged small photo looks soft and would read as blurred.
    .resize({ width: MEASURE_LONG_SIDE, height: MEASURE_LONG_SIDE, fit: "inside", withoutEnlargement: true })
    .greyscale()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const { width: w, height: h } = info;
  const ch = info.channels;
  const px = (x: number, y: number) => data[(y * w + x) * ch];

  let sum = 0;
  for (let i = 0; i < data.length; i += ch) sum += data[i];
  const brightness = sum / (w * h) / 255;

  // 4-neighbour Laplacian over the interior; its spread drops when edges are soft.
  let n = 0;
  let mean = 0;
  let m2 = 0;
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const v = px(x - 1, y) + px(x + 1, y) + px(x, y - 1) + px(x, y + 1) - 4 * px(x, y);
      n++;
      const d = v - mean;
      mean += d / n;
      m2 += d * (v - mean);
    }
  }
  return { brightness, sharpness: n > 1 ? Math.sqrt(m2 / (n - 1)) : 0 };
}

/** Returns a human-readable problem, or null when the photo is usable. */
export function qualityProblem(q: PhotoQuality, name: string): string | null {
  if (q.brightness < QUALITY_LIMITS.minBrightness) {
    return `${name} is too dark to read (average brightness ${Math.round(q.brightness * 100)}%).`;
  }
  if (q.brightness > QUALITY_LIMITS.maxBrightness) {
    return `${name} is overexposed (average brightness ${Math.round(q.brightness * 100)}%).`;
  }
  if (q.sharpness < QUALITY_LIMITS.minSharpness) return `${name} is too blurred to read.`;
  return null;
}
