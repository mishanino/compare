/**
 * Full pipeline: preprocess -> observe (1 model call) -> verdict (code)
 * -> evidence crops -> verify (1 model call on the claimed changes) -> report.
 */
import { randomUUID } from "node:crypto";
import { cropEvidence, cropRegion, emptyRegionMismatch, toDataUrl, type Crop, type CropPair } from "./evidence";
import { preprocessImage, PreprocessError, type ImageVariant, type PreprocessedImage, type SourceFormat } from "./preprocess";
import { measureQuality, qualityProblem } from "./quality";
import { appendRunLog, toLoggedCall, totalCost, type LoggedCall, type Prices, type RunLogEntry } from "./runlog";
import type { PhotoSet, UploadedPhoto } from "./upload";
import {
  allVerdicts,
  applyVerification,
  computeReport,
  declineForPhotos,
  isChangeKind,
  type ChangeKind,
  type ObjectVerdict,
  type Report,
  type VerificationResult,
} from "./verdict";
import type { Observation } from "./vision/observation";
import { VisionSchemaError, type VisionProvider } from "./vision/provider";
import type { Claim } from "./vision/verification";

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
  /** Copied into the run log entry. */
  tag?: Record<string, string>;
  /** Cancels the run: checked between stages and passed to every model call. */
  signal?: AbortSignal;
}

/** The run was cancelled through `PipelineDeps.signal`. */
export class CancelledError extends Error {
  constructor() {
    super("The comparison was cancelled.");
    this.name = "CancelledError";
  }
}

/** The vision call itself failed (network, quota, invalid output twice). */
export class VisionCallError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VisionCallError";
  }
}

type Images = Record<PhotoSet, PreprocessedImage[]>;
type FullImages = Record<PhotoSet, ImageVariant[]>;
type ChangeVerdict = ObjectVerdict & { verdict: ChangeKind };

const isChange = (v: ObjectVerdict): v is ChangeVerdict => isChangeKind(v.verdict);
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

async function preprocessAll(photos: Record<PhotoSet, UploadedPhoto[]>): Promise<Images> {
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

async function photoProblems(images: Images): Promise<string[]> {
  const problems: string[] = [];
  for (const set of ["before", "after"] as const) {
    for (const [i, img] of images[set].entries()) {
      const p = qualityProblem(await measureQuality(img.model), `${set.toUpperCase()} photo ${i + 1}`);
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

function counts(report: Report): Record<string, number> | undefined {
  if (report.status !== "ok") return undefined;
  return {
    changes: report.changes.length,
    uncertain: report.uncertain.length,
    not_verifiable: report.not_verifiable.length,
    unchanged: report.unchanged.length,
  };
}

/** Log entry for a model call that threw. Tokens are only known for schema failures. */
function failedCall(stage: LoggedCall["stage"], provider: VisionProvider, err: unknown, wallMs: number): LoggedCall {
  const error = readableError(err);
  if (err instanceof VisionSchemaError) return toLoggedCall(stage, err.usage, error);
  return { stage, model_id: provider.modelId, input_tokens: 0, output_tokens: 0, retries: 0, wall_ms: wallMs, error };
}

function throwIfCancelled(signal: AbortSignal | undefined) {
  if (signal?.aborted) throw new CancelledError();
}

async function observe(provider: VisionProvider, images: Images, calls: LoggedCall[], signal?: AbortSignal): Promise<Observation> {
  const t = Date.now();
  try {
    const input = { before: images.before.map((i) => i.model), after: images.after.map((i) => i.model) };
    const r = await provider.observe(input, { signal });
    calls.push(toLoggedCall("observe", r.usage));
    return r.observation;
  } catch (err) {
    if (signal?.aborted) {
      calls.push(failedCall("observe", provider, new CancelledError(), Date.now() - t));
      throw new CancelledError();
    }
    calls.push(failedCall("observe", provider, err, Date.now() - t));
    throw new VisionCallError(`The vision model call failed: ${readableError(err)}`);
  }
}

interface EvidenceCrops {
  /** Before / after pairs for verdicts with evidence. */
  pairs: Map<string, CropPair>;
  /** A single crop for not_verifiable objects: where they were last seen. */
  lastSeen: Map<string, { set: PhotoSet; crop: Crop }>;
}

async function cropAll(report: Report, full: FullImages): Promise<EvidenceCrops> {
  const crops: EvidenceCrops = { pairs: new Map(), lastSeen: new Map() };
  for (const v of allVerdicts(report)) {
    if (v.evidence) crops.pairs.set(v.object_id, await cropEvidence(full, v.evidence));
    const img = v.last_seen ? full[v.last_seen.set][v.last_seen.photo - 1] : undefined;
    if (v.last_seen && img) crops.lastSeen.set(v.object_id, { set: v.last_seen.set, crop: await cropRegion(img, v.last_seen.box) });
  }
  return crops;
}

/**
 * Added / removed: the empty-place box must match the object's box, or the pair
 * does not show the same place and the claim cannot be confirmed.
 * Returns the reason, or null when the regions match or the check does not apply.
 */
function regionMismatch(v: ChangeVerdict, full: FullImages): string | null {
  const { evidence } = v;
  if (v.verdict === "moved" || !evidence) return null;
  const side = (set: PhotoSet) => {
    const img = full[set][evidence[set].photo - 1];
    return { box: evidence[set].box, width: img.width, height: img.height };
  };
  return v.verdict === "removed"
    ? emptyRegionMismatch(side("before"), side("after"))
    : emptyRegionMismatch(side("after"), side("before"));
}

/**
 * A change is only reported once the verify step confirms it. A claim without
 * crops, with mismatched regions, without an answer, or a failed verify call,
 * cannot be confirmed, so it becomes uncertain.
 */
async function verifyChanges(
  provider: VisionProvider,
  changes: ChangeVerdict[],
  ctx: { pairs: Map<string, CropPair>; full: FullImages; observation: Observation; calls: LoggedCall[]; signal?: AbortSignal },
): Promise<VerificationResult[]> {
  const descriptions = new Map(ctx.observation.objects.map((o) => [o.id, o.description]));
  const unchecked = (object_id: string, note: string): VerificationResult => ({ object_id, confirmed: false, checked: false, note });
  const results: VerificationResult[] = [];
  const claims: Claim[] = [];
  for (const v of changes) {
    const pair = ctx.pairs.get(v.object_id);
    if (!pair) {
      results.push(unchecked(v.object_id, "no evidence crops were available"));
      continue;
    }
    const mismatch = regionMismatch(v, ctx.full);
    if (mismatch) {
      results.push({ object_id: v.object_id, confirmed: false, note: mismatch });
      continue;
    }
    claims.push({
      id: v.object_id,
      kind: v.verdict,
      label: v.label,
      description: descriptions.get(v.object_id) ?? v.label,
      before: pair.before.jpeg,
      after: pair.after.jpeg,
    });
  }
  if (claims.length === 0) return results;

  throwIfCancelled(ctx.signal);
  const t = Date.now();
  try {
    const r = await provider.verify(claims, { signal: ctx.signal });
    ctx.calls.push(toLoggedCall("verify", r.usage));
    const answers = new Map(r.results.map((c) => [c.id, c]));
    for (const c of claims) {
      const a = answers.get(c.id);
      results.push(a ? { object_id: c.id, confirmed: a.confirmed, note: a.reason } : unchecked(c.id, "the verification step gave no answer"));
    }
  } catch (err) {
    // A cancelled run has no report, so it must not turn into "could not be checked".
    if (ctx.signal?.aborted) {
      ctx.calls.push(failedCall("verify", provider, new CancelledError(), Date.now() - t));
      throw new CancelledError();
    }
    ctx.calls.push(failedCall("verify", provider, err, Date.now() - t));
    for (const c of claims) results.push(unchecked(c.id, "the verification call failed"));
  }
  return results;
}

function cropUrls(report: Report, { pairs, lastSeen }: EvidenceCrops): CompareResult["crops"] {
  const crops: CompareResult["crops"] = {};
  for (const v of allVerdicts(report)) {
    const pair = pairs.get(v.object_id);
    const seen = lastSeen.get(v.object_id);
    if (pair) crops[v.object_id] = { before: toDataUrl(pair.before.jpeg), after: toDataUrl(pair.after.jpeg) };
    else if (seen) crops[v.object_id] = { [seen.set]: toDataUrl(seen.crop.jpeg) };
  }
  return crops;
}

export async function runCompare(photos: Record<PhotoSet, UploadedPhoto[]>, deps: PipelineDeps): Promise<CompareResult> {
  const runId = randomUUID();
  const started = Date.now();
  const stageMs: Record<string, number> = {};
  const calls: LoggedCall[] = [];
  let provider: VisionProvider | null = null;
  let report: Report | null = null;
  let failure: string | undefined;
  let cancelled = false;
  const { signal } = deps;

  const timed = async <T>(stage: string, fn: () => Promise<T> | T): Promise<T> => {
    const t = Date.now();
    try {
      return await fn();
    } finally {
      stageMs[stage] = Date.now() - t;
    }
  };

  try {
    throwIfCancelled(signal);
    deps.onStage?.("prepare");
    const images = await timed("preprocess", () => preprocessAll(photos));
    const info = {
      before: photos.before.map((ph, i) => photoInfo(ph, images.before[i])),
      after: photos.after.map((ph, i) => photoInfo(ph, images.after[i])),
    };
    const result = (r: Report, crops: CompareResult["crops"], modelId: string | null): CompareResult => ({
      report: r,
      crops,
      photos: info,
      run: { id: runId, model_id: modelId, wall_ms: Date.now() - started, cost_usd: totalCost(calls, deps.prices) },
    });

    // Unusable photos are declined in code, before paying for a model call.
    const problems = await timed("quality", () => photoProblems(images));
    throwIfCancelled(signal);
    if (problems.length > 0) {
      report = declineForPhotos(problems);
      return result(report, {}, null);
    }

    const model = await deps.getProvider();
    provider = model;

    throwIfCancelled(signal);
    deps.onStage?.("observe");
    const observation = await timed("observe", () => observe(model, images, calls, signal));

    throwIfCancelled(signal);
    deps.onStage?.("check");
    const judged = await timed("verdict", () => computeReport(observation));
    report = judged;

    const full = { before: images.before.map((i) => i.full), after: images.after.map((i) => i.full) };
    const crops = await timed("evidence", () => cropAll(judged, full));
    const results = await timed("verify", () =>
      verifyChanges(model, allVerdicts(judged).filter(isChange), { pairs: crops.pairs, full, observation, calls, signal }),
    );
    throwIfCancelled(signal);
    report = applyVerification(judged, results);

    return result(report, cropUrls(report, crops), model.modelId);
  } catch (err) {
    if (err instanceof CancelledError) cancelled = true;
    else failure = short(err instanceof Error ? err.message : String(err)) || "unknown error";
    throw err;
  } finally {
    const entry: RunLogEntry = {
      ts: new Date(started).toISOString(),
      run_id: runId,
      provider: provider?.name ?? null,
      model_id: provider?.modelId ?? null,
      outcome: cancelled ? "cancelled" : failure ? "error" : report?.status === "declined" ? "declined" : "ok",
      ...(failure ? { error: failure } : {}),
      photos: { before: photos.before.length, after: photos.after.length },
      calls,
      stage_ms: stageMs,
      total_ms: Date.now() - started,
      prices: deps.prices,
      cost_usd: totalCost(calls, deps.prices),
      ...(report && !failure && !cancelled ? { counts: counts(report) } : {}),
      ...(deps.tag ? { tag: deps.tag } : {}),
    };
    await appendRunLog(entry, deps.logPath);
  }
}
