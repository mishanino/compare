/**
 * Runs the observe step on a folder of photos and saves copies with the boxes
 * and labels drawn on them, so boxes can be checked by eye.
 *
 * Usage:
 *   npm run debug:overlay -- <folder>              (folder has before/ and after/ subfolders)
 *   npm run debug:overlay -- <beforeDir> <afterDir>
 *   options: --out <dir>   (default runs/overlay/<timestamp>)
 *
 * Reads GEMINI_API_KEY, GEMINI_MODEL_ID and VISION_PROVIDER from .env or the environment.
 */
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { preprocessImage, type PreprocessedImage } from "../lib/preprocess";
import { MAX_PHOTOS_PER_SET } from "../lib/upload";
import type { Observation } from "../lib/vision/observation";
import { createVisionProvider } from "../lib/vision/provider";

const IMAGE_EXT = new Set([".jpg", ".jpeg", ".png", ".webp", ".heic", ".heif", ".avif", ".tif", ".tiff"]);
const COLOURS = ["#ff3b30", "#34c759", "#007aff", "#ff9500", "#af52de", "#00c7be", "#ffcc00"];

function usage(msg?: string): never {
  if (msg) console.error(`Error: ${msg}\n`);
  console.error("Usage: npm run debug:overlay -- <folder> | <beforeDir> <afterDir> [--out <dir>]");
  process.exit(1);
}

function parseArgs(argv: string[]) {
  const positional: string[] = [];
  let out: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--out") out = argv[++i] ?? usage("--out needs a value");
    else if (argv[i].startsWith("--")) usage(`unknown option ${argv[i]}`);
    else positional.push(argv[i]);
  }
  if (positional.length === 1) {
    return { before: path.join(positional[0], "before"), after: path.join(positional[0], "after"), out };
  }
  if (positional.length === 2) return { before: positional[0], after: positional[1], out };
  return usage();
}

async function listImages(dir: string): Promise<string[]> {
  if (!(await stat(dir).catch(() => null))?.isDirectory()) usage(`${dir} is not a folder`);
  const files = (await readdir(dir))
    .filter((f) => IMAGE_EXT.has(path.extname(f).toLowerCase()))
    .sort()
    .map((f) => path.join(dir, f));
  if (files.length === 0) usage(`no images in ${dir}`);
  if (files.length > MAX_PHOTOS_PER_SET) usage(`${dir} has ${files.length} images, at most ${MAX_PHOTOS_PER_SET} allowed`);
  return files;
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** Draws every sighting for one photo. Empty locations are dashed. */
async function drawOverlay(img: PreprocessedImage, obs: Observation, set: "before" | "after", photo: number) {
  const { width: W, height: H } = img.model;
  const stroke = Math.max(2, Math.round(Math.min(W, H) / 300));
  const font = Math.max(14, Math.round(Math.min(W, H) / 40));
  const shapes: string[] = [];
  const legend: string[] = [];

  obs.objects.forEach((o, i) => {
    const colour = COLOURS[i % COLOURS.length];
    const s = o.sightings.find((x) => x.set === set && x.photo === photo);
    const status = s?.status ?? "missing";
    legend.push(`<tspan x="8" dy="${font * 1.2}" fill="${colour}">${esc(`${o.id} ${o.label}: ${status}${s?.occluder ? ` (by ${s.occluder})` : ""}`)}</tspan>`);
    if (!s?.box) return;
    const x = s.box.x * W, y = s.box.y * H, w = s.box.w * W, h = s.box.h * H;
    const dash = s.status === "location_empty" ? `stroke-dasharray="${stroke * 4} ${stroke * 3}"` : "";
    const text = esc(`${o.id} ${o.label}${s.status === "location_empty" ? " [empty]" : ""}`);
    const ty = y > font + 4 ? y - 4 : y + h + font;
    shapes.push(
      `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="none" stroke="${colour}" stroke-width="${stroke}" ${dash}/>`,
      `<text x="${x}" y="${ty}" font-size="${font}" font-family="sans-serif" font-weight="bold" fill="${colour}" stroke="#000" stroke-width="${stroke / 2}" paint-order="stroke">${text}</text>`,
    );
  });

  // The legend goes in a strip below the photo so it never hides objects.
  const legendH = Math.ceil(font * 1.2 * (legend.length + 1) + font * 0.6);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H + legendH}">
    ${shapes.join("\n")}
    <text font-size="${font}" font-family="sans-serif" font-weight="bold" fill="#fff" y="${H}">
      <tspan x="8" dy="${font * 1.2}">${set.toUpperCase()} photo ${photo}</tspan>${legend.join("")}
    </text>
  </svg>`;
  return sharp(img.model.jpeg)
    .extend({ bottom: legendH, background: "#000" })
    .composite([{ input: Buffer.from(svg) }])
    .jpeg({ quality: 88 })
    .toBuffer();
}

async function main() {
  try {
    process.loadEnvFile(".env");
  } catch {
    // No .env file: rely on the real environment.
  }
  const args = parseArgs(process.argv.slice(2));
  const files = { before: await listImages(args.before), after: await listImages(args.after) };
  const outDir = args.out ?? path.join("runs", "overlay", new Date().toISOString().replace(/[:.]/g, "-"));

  const images = {
    before: await Promise.all(files.before.map(async (f) => preprocessImage(await readFile(f)))),
    after: await Promise.all(files.after.map(async (f) => preprocessImage(await readFile(f)))),
  };

  const provider = await createVisionProvider();
  console.log(`Observing ${files.before.length} BEFORE + ${files.after.length} AFTER photos with ${provider.name}/${provider.modelId}...`);
  const { observation, usage } = await provider.observe({
    before: images.before.map((i) => i.model),
    after: images.after.map((i) => i.model),
  });

  await mkdir(outDir, { recursive: true });
  for (const set of ["before", "after"] as const) {
    for (const [i, img] of images[set].entries()) {
      const name = `${set}_${i + 1}_${path.parse(files[set][i]).name}.jpg`;
      await writeFile(path.join(outDir, name), await drawOverlay(img, observation, set, i + 1));
    }
  }
  const sources = { before: files.before, after: files.after };
  await writeFile(path.join(outDir, "observation.json"), JSON.stringify({ sources, usage, observation }, null, 2));

  const { scene } = observation;
  console.log(`same_scene=${scene.same_scene} usable=${scene.usable}${scene.issues.length ? ` issues: ${scene.issues.join("; ")}` : ""}`);
  for (const o of observation.objects) {
    console.log(`  ${o.id} ${o.label}  conf=${o.match_confidence}  position_changed=${o.position_changed}`);
  }
  console.log(`tokens in=${usage.inputTokens} out=${usage.outputTokens} retries=${usage.retries} wall=${usage.wallMs}ms`);
  console.log(`Saved to ${outDir}`);
}

main().catch((err) => {
  console.error(err instanceof Error ? `${err.name}: ${err.message}` : err);
  process.exit(1);
});
