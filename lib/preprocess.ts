import sharp from "sharp";
import heicConvert from "heic-convert";

/** Long side of the copy sent to the vision model. */
export const MODEL_LONG_SIDE = 1536;
const FULL_JPEG_QUALITY = 92;
const MODEL_JPEG_QUALITY = 85;
const HEIC_JPEG_QUALITY = 0.95;

export type SourceFormat = "jpeg" | "png" | "webp" | "heic" | "avif" | "tiff" | "gif";

export interface ImageVariant {
  jpeg: Buffer;
  width: number;
  height: number;
}

export interface PreprocessedImage {
  sourceFormat: SourceFormat;
  /** EXIF-corrected, full resolution. Used for evidence crops. */
  full: ImageVariant;
  /** EXIF-corrected, long side <= MODEL_LONG_SIDE. Sent to the model. */
  model: ImageVariant;
}

export class PreprocessError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PreprocessError";
  }
}

// ISO-BMFF major brands that mean HEVC-coded HEIF (iPhone photos etc).
// AVIF brands are deliberately absent: sharp decodes those itself.
const HEIC_BRANDS = new Set(["heic", "heix", "hevc", "hevx", "heim", "heis", "hevm", "hevs", "mif1", "msf1"]);

/** Detects HEIC by file signature (`....ftyp<brand>`), not by name or MIME type. */
export function isHeic(buf: Uint8Array): boolean {
  if (buf.length < 12) return false;
  const ascii = (from: number, to: number) => String.fromCharCode(...buf.subarray(from, to));
  if (ascii(4, 8) !== "ftyp") return false;
  const major = ascii(8, 12);
  if (major === "avif" || major === "avis") return false;
  if (HEIC_BRANDS.has(major)) {
    // mif1/msf1 are generic; check compatible brands so AVIF-in-mif1 stays with sharp.
    if (major === "mif1" || major === "msf1") {
      const boxSize = Math.min(new DataView(buf.buffer, buf.byteOffset, buf.byteLength).getUint32(0), buf.length);
      const compat: string[] = [];
      for (let i = 16; i + 4 <= boxSize; i += 4) compat.push(ascii(i, i + 4));
      if (compat.some((b) => b === "avif" || b === "avis")) return false;
    }
    return true;
  }
  return false;
}

async function toSharpInput(input: Buffer): Promise<{ buf: Buffer; heic: boolean }> {
  if (!isHeic(input)) return { buf: input, heic: false };
  try {
    // heic-convert applies the HEIF transform boxes (irot/imir) while decoding,
    // and the JPEG it writes carries no EXIF orientation, so nothing rotates twice.
    const out = await heicConvert({ buffer: input, format: "JPEG", quality: HEIC_JPEG_QUALITY });
    return { buf: Buffer.from(out), heic: true };
  } catch (err) {
    throw new PreprocessError(`Could not decode HEIC image: ${(err as Error).message}`);
  }
}

const SHARP_FORMATS: Record<string, SourceFormat> = {
  jpeg: "jpeg",
  jpg: "jpeg",
  png: "png",
  webp: "webp",
  heif: "avif", // sharp reports AVIF as "heif"
  tiff: "tiff",
  gif: "gif",
};

export async function preprocessImage(input: Buffer): Promise<PreprocessedImage> {
  const { buf, heic } = await toSharpInput(input);

  let format: string | undefined;
  try {
    format = (await sharp(buf).metadata()).format;
  } catch {
    throw new PreprocessError("File is not a readable image.");
  }
  const sourceFormat: SourceFormat | undefined = heic ? "heic" : format ? SHARP_FORMATS[format] : undefined;
  if (!sourceFormat) {
    throw new PreprocessError(`Unsupported image format: ${format ?? "unknown"}.`);
  }

  // Bake the EXIF orientation into the pixels. Output metadata is stripped,
  // so all later box coordinates refer to this upright image.
  const full = await sharp(buf)
    .autoOrient()
    .jpeg({ quality: FULL_JPEG_QUALITY, mozjpeg: true })
    .toBuffer({ resolveWithObject: true });

  const model = await sharp(full.data)
    .resize({ width: MODEL_LONG_SIDE, height: MODEL_LONG_SIDE, fit: "inside", withoutEnlargement: true })
    .jpeg({ quality: MODEL_JPEG_QUALITY, mozjpeg: true })
    .toBuffer({ resolveWithObject: true });

  return {
    sourceFormat,
    full: { jpeg: full.data, width: full.info.width, height: full.info.height },
    model: { jpeg: model.data, width: model.info.width, height: model.info.height },
  };
}
