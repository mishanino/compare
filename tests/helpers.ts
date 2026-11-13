import sharp from "sharp";

/** Solid image with a red block in the top-left corner, so orientation is checkable. */
export async function makeImage(
  width: number,
  height: number,
  opts: { format?: "jpeg" | "png"; orientation?: number } = {},
): Promise<Buffer> {
  const marker = await sharp({
    create: { width: Math.round(width / 4), height: Math.round(height / 4), channels: 3, background: "#ff0000" },
  })
    .png()
    .toBuffer();
  let img = sharp({ create: { width, height, channels: 3, background: "#2040c0" } }).composite([
    { input: marker, left: 0, top: 0 },
  ]);
  if (opts.orientation) img = img.withMetadata({ orientation: opts.orientation });
  return opts.format === "png" ? img.png().toBuffer() : img.jpeg().toBuffer();
}

/** Minimal ISO-BMFF ftyp box: size, "ftyp", major brand, minor version, compatible brands. */
export function ftyp(major: string, compatible: string[] = []): Buffer {
  const size = 16 + compatible.length * 4;
  const b = Buffer.alloc(size + 16);
  b.writeUInt32BE(size, 0);
  b.write("ftyp", 4, "ascii");
  b.write(major, 8, "ascii");
  compatible.forEach((c, i) => b.write(c, 16 + i * 4, "ascii"));
  return b;
}

export async function pixel(buf: Buffer, x: number, y: number): Promise<[number, number, number]> {
  const { data, info } = await sharp(buf).raw().toBuffer({ resolveWithObject: true });
  const i = (y * info.width + x) * info.channels;
  return [data[i], data[i + 1], data[i + 2]];
}

/**
 * Mid-grey image with deterministic pixel noise: passes the photo quality gate
 * (not dark, not overexposed, not blurred), unlike the flat images above.
 */
export async function makeTexturedImage(width: number, height: number, opts: { format?: "jpeg" | "png" } = {}): Promise<Buffer> {
  const raw = Buffer.alloc(width * height * 3);
  let seed = 42;
  for (let i = 0; i < raw.length; i++) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    raw[i] = 70 + (seed % 120);
  }
  const img = sharp(raw, { raw: { width, height, channels: 3 } });
  return opts.format === "png" ? img.png().toBuffer() : img.jpeg().toBuffer();
}
