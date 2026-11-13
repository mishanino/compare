/**
 * Evaluation against testset/changelog.json. This is the only code that reads testset/.
 *
 *   npm run eval                              # dev pairs, model from .env, 3 runs each
 *   npm run eval -- --model gemini-3.5-flash-lite --model gemini-3.8-flash
 *   npm run eval -- --pairs P02,P08 --runs 1 --concurrency 2
 *   npm run eval -- --holdout                 # include holdout pairs (only at the very end)
 *
 * Each pair (BEFORE state -> AFTER state) is run through the real pipeline N times.
 * Every run is also appended to runs/log.jsonl with tag source=eval.
 * Prices come from env: PRICE_*_PER_MTOK_USD__<MODEL> or, for the configured
 * GEMINI_MODEL_ID, PRICE_*_PER_MTOK_USD. Without them, cost is shown as n/a.
 */
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { median, SCENE_SYNONYMS, scoreRun, SYNONYMS, type GtItem, type PairSpec, type RunScore } from "../lib/eval/score";
import { runCompare, type CompareResult } from "../lib/pipeline";
import { pricesForModel } from "../lib/runlog";
import type { UploadedPhoto } from "../lib/upload";
import { createVisionProvider } from "../lib/vision/provider";

const ROOT = path.resolve(__dirname, "..");
const TESTSET = path.join(ROOT, "testset");

interface Changelog {
  states: Record<string, { files: string[]; scene?: string }>;
  pairs: (PairSpec & { before: string; after: string; after_photos?: string[]; holdout?: boolean; expected: GtItem[] })[];
}

interface Args {
  models: string[];
  runs: number;
  pairs: string[] | null;
  holdout: boolean;
  concurrency: number;
}

function parseArgs(argv: string[]): Args {
  const a: Args = { models: [], runs: 3, pairs: null, holdout: false, concurrency: 2 };
  for (let i = 0; i < argv.length; i++) {
    const next = () => {
      const v = argv[++i];
      if (!v) throw new Error(`${argv[i - 1]} needs a value`);
      return v;
    };
    switch (argv[i]) {
      case "--model":
        a.models.push(...next().split(",").map((s) => s.trim()).filter(Boolean));
        break;
      case "--runs":
        a.runs = Number(next());
        break;
      case "--pairs":
        a.pairs = next().split(",").map((s) => s.trim().toUpperCase());
        break;
      case "--holdout":
        a.holdout = true;
        break;
      case "--concurrency":
        a.concurrency = Number(next());
        break;
      default:
        throw new Error(`Unknown option ${argv[i]}`);
    }
  }
  if (!Number.isInteger(a.runs) || a.runs < 1) throw new Error("--runs must be a positive integer");
  if (!Number.isInteger(a.concurrency) || a.concurrency < 1) throw new Error("--concurrency must be a positive integer");
  return a;
}

function stateDir(state: string): { dir: string; holdout: boolean } {
  for (const sub of ["dev", "holdout"]) {
    const dir = path.join(TESTSET, sub, state);
    if (existsSync(dir)) return { dir, holdout: sub === "holdout" };
  }
  throw new Error(`State folder ${state} not found under testset/dev or testset/holdout`);
}

async function loadPhotos(set: "before" | "after", state: string, files: string[]): Promise<UploadedPhoto[]> {
  const { dir } = stateDir(state);
  return Promise.all(
    files.map(async (name, i) => ({ set, photo: i + 1, name, bytes: await readFile(path.join(dir, name)) })),
  );
}

interface RunOutcome {
  pair: string;
  model: string;
  run: number;
  result?: CompareResult;
  score?: RunScore;
  error?: string;
}

async function pool<T>(tasks: (() => Promise<T>)[], limit: number): Promise<T[]> {
  const out: T[] = new Array(tasks.length);
  let next = 0;
  const worker = async () => {
    while (next < tasks.length) {
      const i = next++;
      out[i] = await tasks[i]();
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, worker));
  return out;
}

const fmtS = (ms: number) => (Number.isFinite(ms) ? (ms / 1000).toFixed(1) : "–");
const fmtUsd = (xs: (number | null)[]) => {
  const known = xs.filter((x): x is number => x !== null);
  if (known.length === 0) return "n/a";
  return `$${(known.reduce((a, b) => a + b, 0) / known.length).toFixed(4)}`;
};

function tableFor(model: string, pairs: Changelog["pairs"], outcomes: RunOutcome[], runs: number): string {
  const lines: string[] = [];
  lines.push(`### ${model}`, "");
  lines.push("| Pair | Runs ok | Errors | TP | FP | Miss (hedged) | Forbidden | Decline ok | Median s | Max s | Mean cost |");
  lines.push("|---|---|---|---|---|---|---|---|---|---|---|");
  const total = { ok: 0, err: 0, tp: 0, fp: 0, miss: 0, hedged: 0, forbidden: 0, decl: 0, times: [] as number[], costs: [] as (number | null)[] };

  for (const p of pairs) {
    const mine = outcomes.filter((o) => o.pair === p.id && o.model === model);
    const ok = mine.filter((o) => o.score && o.result);
    const sum = (k: "tp" | "fp" | "miss" | "hedged" | "forbidden") => ok.reduce((a, o) => a + o.score![k], 0);
    const times = ok.map((o) => o.result!.run.wall_ms);
    const costs = ok.map((o) => o.result!.run.cost_usd);
    const decl = ok.filter((o) => o.score!.declineCorrect).length;
    const row = { tp: sum("tp"), fp: sum("fp"), miss: sum("miss"), hedged: sum("hedged"), forbidden: sum("forbidden") };
    lines.push(
      `| ${p.id} ${p.before}→${p.after} | ${ok.length}/${runs} | ${mine.length - ok.length} | ${row.tp} | ${row.fp} | ${row.miss} (${row.hedged}) | ${row.forbidden} | ${decl}/${ok.length} | ${fmtS(median(times))} | ${fmtS(times.length ? Math.max(...times) : NaN)} | ${fmtUsd(costs)} |`,
    );
    total.ok += ok.length;
    total.err += mine.length - ok.length;
    total.tp += row.tp;
    total.fp += row.fp;
    total.miss += row.miss;
    total.hedged += row.hedged;
    total.forbidden += row.forbidden;
    total.decl += decl;
    total.times.push(...times);
    total.costs.push(...costs);
  }
  lines.push(
    `| **Total** | ${total.ok}/${pairs.length * runs} | ${total.err} | ${total.tp} | ${total.fp} | ${total.miss} (${total.hedged}) | ${total.forbidden} | ${total.decl}/${total.ok} | ${fmtS(median(total.times))} | ${fmtS(total.times.length ? Math.max(...total.times) : NaN)} | ${fmtUsd(total.costs)} |`,
  );
  const precision = total.tp + total.fp ? total.tp / (total.tp + total.fp) : NaN;
  const recall = total.tp + total.miss ? total.tp / (total.tp + total.miss) : NaN;
  lines.push("", `Precision ${Number.isFinite(precision) ? precision.toFixed(2) : "–"} · recall ${Number.isFinite(recall) ? recall.toFixed(2) : "–"} (TP counts change claims that match the ground truth, including allowed ones).`, "");

  // Problems and unmatched labels, for manual review.
  const details: string[] = [];
  for (const p of pairs) {
    for (const o of outcomes.filter((x) => x.pair === p.id && x.model === model)) {
      const items = [
        ...(o.error ? [`error: ${o.error}`] : []),
        ...(o.score?.notes ?? []),
        ...(o.score?.unmatched.length ? [`unmatched labels: ${o.score.unmatched.map((l) => `"${l}"`).join(", ")}`] : []),
      ];
      if (items.length) details.push(`- ${p.id} run ${o.run}: ${items.join("; ")}`);
    }
  }
  if (details.length) lines.push("<details><summary>Problems and unmatched labels</summary>", "", ...details, "", "</details>", "");
  return lines.join("\n");
}

async function main() {
  try {
    process.loadEnvFile(path.join(ROOT, ".env"));
  } catch {
    // No .env: use the real environment.
  }
  const args = parseArgs(process.argv.slice(2));
  const models = args.models.length ? args.models : [process.env.GEMINI_MODEL_ID?.trim() ?? ""];
  if (!models[0]) throw new Error("No model: set GEMINI_MODEL_ID or pass --model.");

  const changelog = JSON.parse(await readFile(path.join(TESTSET, "changelog.json"), "utf8")) as Changelog & { _status?: string };
  const isHoldout = (p: Changelog["pairs"][number]) => p.holdout || stateDir(p.before).holdout || stateDir(p.after).holdout;
  let pairs = changelog.pairs.filter((p) => args.holdout || !isHoldout(p));
  if (args.pairs) pairs = pairs.filter((p) => args.pairs!.includes(p.id.toUpperCase()));
  if (pairs.length === 0) throw new Error("No pairs selected.");
  const skipped = changelog.pairs.filter((p) => !args.holdout && isHoldout(p)).map((p) => p.id);

  console.log(`Models: ${models.join(", ")} · pairs: ${pairs.map((p) => p.id).join(", ")} · runs: ${args.runs}`);
  if (skipped.length) console.log(`Holdout pairs skipped (use --holdout at the very end): ${skipped.join(", ")}`);
  if (changelog._status) console.log(`changelog status: ${changelog._status}`);

  const stamp = new Date().toISOString().replace(/:/g, "").slice(0, 15);
  const tasks: (() => Promise<RunOutcome>)[] = [];
  for (const model of models) {
    const prices = pricesForModel(model);
    if (!prices) console.log(`No prices in env for ${model}: cost will be n/a.`);
    for (const p of pairs) {
      for (let run = 1; run <= args.runs; run++) {
        tasks.push(async () => {
          const t0 = Date.now();
          try {
            const photos = {
              before: await loadPhotos("before", p.before, changelog.states[p.before].files),
              after: await loadPhotos("after", p.after, p.after_photos ?? changelog.states[p.after].files),
            };
            const result = await runCompare(photos, {
              getProvider: () => createVisionProvider({ ...process.env, GEMINI_MODEL_ID: model }),
              prices,
              tag: { source: "eval", pair: p.id, model, run: String(run), stamp },
            });
            const scene = changelog.states[p.before].scene;
            const score = scoreRun(p, result.report, (scene && SCENE_SYNONYMS[scene]) || SYNONYMS);
            console.log(`${model} ${p.id} #${run}: ${result.report.status} tp=${score.tp} fp=${score.fp} miss=${score.miss} ${((Date.now() - t0) / 1000).toFixed(1)}s`);
            return { pair: p.id, model, run, result, score };
          } catch (err) {
            const error = (err as Error).message.slice(0, 300);
            console.log(`${model} ${p.id} #${run}: ERROR ${error}`);
            return { pair: p.id, model, run, error };
          }
        });
      }
    }
  }
  const outcomes = await pool(tasks, args.concurrency);

  const header = [
    `# Eval ${new Date().toISOString().slice(0, 16).replace("T", " ")} UTC`,
    "",
    `Models: ${models.join(", ")} · runs per pair: ${args.runs} · pairs: ${pairs.map((p) => p.id).join(", ")}${skipped.length ? ` · holdout skipped: ${skipped.join(", ")}` : ""}`,
    "",
    changelog._status ? `> changelog status: ${changelog._status}\n` : "",
  ].join("\n");
  const md = [header, ...models.map((m) => tableFor(m, pairs, outcomes, args.runs))].join("\n");
  console.log("\n" + md);

  await mkdir(path.join(ROOT, "runs"), { recursive: true });
  const out = path.join(ROOT, "runs", `eval-${stamp}.md`);
  await writeFile(out, md);
  // Raw verdicts per run, without the crop images, for later review.
  const raw = outcomes.map((o) => ({ pair: o.pair, model: o.model, run: o.run, error: o.error, score: o.score, report: o.result?.report, run_info: o.result?.run }));
  await writeFile(out.replace(/\.md$/, ".json"), JSON.stringify(raw, null, 2));
  console.log(`Saved ${path.relative(ROOT, out)} (+ .json with raw verdicts)`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
