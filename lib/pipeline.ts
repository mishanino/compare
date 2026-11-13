/**
 * Full pipeline: preprocess -> observe (1 model call) -> verdict (code)
 * -> evidence crops -> verify (1 model call on the claimed changes) -> report.
 */
import { randomUUID } from "node:crypto";
import { cropEvidence, cropRegion, emptyRegionMismatch, toDataUrl, type Crop, type CropPair } from "./evidence";
import { preprocessImage, PreprocessError, type PreprocessedImage, type SourceFormat } from "./preprocess";
import { measureQuality, qualityProblem } from "./quality";
import { appendRunLog, toLoggedCall, totalCost, type LoggedCall, type Prices, type RunLogEntry } from "./runlog";
import type { PhotoSet, UploadedPhoto } from "./upload";
import { applyVerification, computeReport, declineForPhotos, type ObjectVerdict, type Report, type VerificationResult } from "./verdict";
import { VisionSchemaError, type VisionProvider } from "./vision/provider";
import type { Claim, ClaimKind } from "./vision/verification";

export interface PhotoInfo {
  photo: number;
  name: string;
  sourceFormat: SourceFormat;
  full: { width: number; height: number };
  model: { width: number; height: number };
}

export interface CompareResult {
  report: Report;
  /**
   * Evidence crops as JPEG data URLs, keyed by object id. Pairs for verdicts with
   * evidence; a single side for not_verifiable objects (where they were last seen).
   */
  crops: Record<string, { before?: string; after?: string }>;
  photos: Record<PhotoSet, PhotoInfo[]>;
  /** model_id is null when the run was declined before any model call. */
  run: { id: string; model_id: string | null; wall_ms: number; cost_usd: number | null };
}

/** User-facing progress stages: preprocess, observe, then verdict + crops + verify. */
export type PipelineStage = "prepare" | "observe" | "check";

export interface PipelineDeps {
  /** Created lazily, after the photos are known to be readable. */
  getProvider: () => Promise<VisionProvider>;
  prices: Prices | null;
  logPath?: string;
  /** Called when a user-facing stage starts. */
  onStage?: (stage: PipelineStage) => void;
}

/** The vision call itself failed (network, quota, invalid output twice). */
export class VisionCallError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VisionCallError";
  }
}

const CLAIM_KINDS: ClaimKind[] = ["moved", "added", "removed"];
const short = (msg: string) => (msg.length > 300 ? `${msg.slice(0, 300)}…` : msg);

/** Provider errors often carry a JSON body; keep only its human-readable message. */
export function readableError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  try {
    const body = JSON.parse(msg) as { error?: { message?: string; code?: number } };
    if (body.error?.message) return short(body.error.code ? `${body.error.message} (${body.error.code})` : body.error.message);
  } catch {
    // Not JSON: use as is.
  }
  return short(msg);
}

async function preprocessAll(photos: Record<PhotoSet, UploadedPhoto[]>) {
  const one = async (p: UploadedPhoto) => {
    try {
      return await preprocessImage(p.bytes);
    } catch (err) {
      if (err instanceof PreprocessError) {
        throw new PreprocessError(`${p.set.toUpperCase()} photo ${p.photo} (${p.name}): ${err.message}`);
      }
      throw err;
    }
  };
  const [before, after] = await Promise.all([Promise.all(photos.before.map(one)), Promise.all(photos.after.map(one))]);
  return { before, after };
}

async function photoProblems(images: { before: PreprocessedImage[]; after: PreprocessedImage[] }): Promise<string[]> {
  const problems: string[] = [];
  for (const set of ["before", "after"] as const) {
    for (const [i, img] of images[set].entries()) {
      const p = qualityProblem(await measureQuality(img.model), `${set === "before" ? "BEFORE" : "AFTER"} photo ${i + 1}`);
      if (p) problems.push(p);
    }
  }
  return problems;
}

function photoInfo(p: UploadedPhoto, img: PreprocessedImage): PhotoInfo {
  return {
    photo: p.photo,
    name: p.name,
    sourceFormat: img.sourceFormat,
    full: { width: img.full.width, height: img.full.height },
    model: { width: img.model.width, height: img.model.height },
  };
}

function allVerdicts(report: Report): ObjectVerdict[] {
  return report.status === "ok" ? [...report.changes, ...report.uncertain, ...report.not_verifiable, ...report.unchanged] : [];
}

function counts(report: Report): Record<string, number> | undefined {
  if (report.status !== "ok") return undefined;
  return {
    changes: report.changes.length,
    uncertain: report.uncertain.length,
    not_verifiable: report.not_verifiable.length,
    unchanged: report.unchanged.length,
  };
}

export async function runCompare(photos: Record<PhotoSet, UploadedPhoto[]>, deps: PipelineDeps): Promise<CompareResult> {
  const runId = randomUUID();
  const started = Date.now();
  const stageMs: Record<string, number> = {};
  const calls: LoggedCall[] = [];
  let provider: VisionProvider | null = null;
  let report: Report | null = null;
  let failure: string | undefined;

  const timed = async <T>(stage: string, fn: () => Promise<T> | T): Promise<T> => {
    const t = Date.now();
    try {
      return await fn();
    } finally {
      stageMs[stage] = Date.now() - t;
    }
  };

  try {
    deps.onStage?.("prepare");
    const images = await timed("preprocess", () => preprocessAll(photos));
    const info = {
      before: photos.before.map((ph, i) => photoInfo(ph, images.before[i])),
      after: photos.after.map((ph, i) => photoInfo(ph, images.after[i])),
    };

    // Unusable photos are declined in code, before paying for a model call.
    const problems = await timed("quality", () => photoProblems(images));
    if (problems.length > 0) {
      report = declineForPhotos(problems);
      return {
        report,
        crops: {},
        photos: info,
        run: { id: runId, model_id: null, wall_ms: Date.now() - started, cost_usd: totalCost(calls, deps.prices) },
      };
    }

    provider = await deps.getProvider();
    const p = provider;

    deps.onStage?.("observe");
    const observed = await timed("observe", async () => {
      try {
        const r = await p.observe({ before: images.before.map((i) => i.model), after: images.after.map((i) => i.model) });
        calls.push(toLoggedCall("observe", r.usage));
        return r;
      } catch (err) {
        if (err instanceof VisionSchemaError) calls.push(toLoggedCall("observe", err.usage, err.message));
        throw new VisionCallError(`The vision model call failed: ${readableError(err)}`);
      }
    });

    deps.onStage?.("check");
    report = await timed("verdict", () => computeReport(observed.observation));

    const full = { before: images.before.map((i) => i.full), after: images.after.map((i) => i.full) };
    const pairs = new Map<string, CropPair>();
    const lastSeen = new Map<string, { set: PhotoSet; crop: Crop }>();
    await timed("evidence", async () => {
      for (const v of allVerdicts(report!)) {
        if (v.evidence) pairs.set(v.object_id, await cropEvidence(full, v.evidence));
        const img = v.last_seen ? full[v.last_seen.set][v.last_seen.photo - 1] : undefined;
        if (v.last_seen && img) lastSeen.set(v.object_id, { set: v.last_seen.set, crop: await cropRegion(img, v.last_seen.box) });
      }
    });

    // Added / removed: the empty-place box must match the object's box, or the
    // pair does not show the same place and the claim cannot be confirmed.
    const mismatched = new Map<string, string>();
    for (const v of allVerdicts(report)) {
      if ((v.verdict !== "added" && v.verdict !== "removed") || !v.evidence) continue;
      const objectSide = v.verdict === "removed" ? "before" : "after";
      const emptySide = v.verdict === "removed" ? "after" : "before";
      const side = (s: PhotoSet) => {
        const img = full[s][v.evidence![s].photo - 1];
        return { box: v.evidence![s].box, width: img.width, height: img.height };
      };
      const why = emptyRegionMismatch(side(objectSide), side(emptySide));
      if (why) mismatched.set(v.object_id, why);
    }

    const objects = new Map(observed.observation.objects.map((o) => [o.id, o]));
    const claims: Claim[] = allVerdicts(report)
      .filter((v) => CLAIM_KINDS.includes(v.verdict as ClaimKind) && pairs.has(v.object_id) && !mismatched.has(v.object_id))
      .map((v) => ({
        id: v.object_id,
        kind: v.verdict as ClaimKind,
        label: v.label,
        description: objects.get(v.object_id)?.description ?? v.label,
        before: pairs.get(v.object_id)!.before.jpeg,
        after: pairs.get(v.object_id)!.after.jpeg,
      }));

    // A change is only reported once the verify step confirms it. A claim without
    // crops, with mismatched regions, or a failed verify call, cannot be confirmed,
    // so it becomes uncertain.
    const results: VerificationResult[] = await timed("verify", async () => {
      const unverifiable: VerificationResult[] = [
        ...allVerdicts(report!)
          .filter((v) => CLAIM_KINDS.includes(v.verdict as ClaimKind) && !pairs.has(v.object_id))
          .map((v) => ({ object_id: v.object_id, confirmed: false, checked: false, note: "no evidence crops were available" })),
        ...[...mismatched].map(([object_id, note]) => ({ object_id, confirmed: false, note })),
      ];
      if (claims.length === 0) return unverifiable;
      try {
        const r = await p.verify(claims);
        calls.push(toLoggedCall("verify", r.usage));
        return [
          ...unverifiable,
          ...r.results.map((c) => ({ object_id: c.id, confirmed: c.confirmed, note: c.reason })),
        ];
      } catch (err) {
        const msg = readableError(err);
        if (err instanceof VisionSchemaError) calls.push(toLoggedCall("verify", err.usage, msg));
        else calls.push({ stage: "verify", model_id: p.modelId, input_tokens: 0, output_tokens: 0, retries: 0, wall_ms: 0, error: msg });
        return [
          ...unverifiable,
          ...claims.map((c) => ({ object_id: c.id, confirmed: false, checked: false, note: "the verification call failed" })),
        ];
      }
    });
    report = applyVerification(report, results);

    const crops: CompareResult["crops"] = {};
    for (const v of allVerdicts(report)) {
      const pair = pairs.get(v.object_id);
      if (pair) crops[v.object_id] = { before: toDataUrl(pair.before.jpeg), after: toDataUrl(pair.after.jpeg) };
      const seen = lastSeen.get(v.object_id);
      if (!pair && seen) crops[v.object_id] = { [seen.set]: toDataUrl(seen.crop.jpeg) };
    }

    return {
      report,
      crops,
      photos: info,
      run: { id: runId, model_id: provider.modelId, wall_ms: Date.now() - started, cost_usd: totalCost(calls, deps.prices) },
    };
  } catch (err) {
    failure = short((err as Error).message);
    throw err;
  } finally {
    const entry: RunLogEntry = {
      ts: new Date(started).toISOString(),
      run_id: runId,
      provider: provider?.name ?? null,
      model_id: provider?.modelId ?? null,
      outcome: failure ? "error" : report?.status === "declined" ? "declined" : "ok",
      ...(failure ? { error: failure } : {}),
      photos: { before: photos.before.length, after: photos.after.length },
      calls,
      stage_ms: stageMs,
      total_ms: Date.now() - started,
      prices: deps.prices,
      cost_usd: totalCost(calls, deps.prices),
      ...(report && !failure ? { counts: counts(report) } : {}),
    };
    await appendRunLog(entry, deps.logPath);
  }
}
