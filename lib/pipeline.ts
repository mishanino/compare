/**
 * Full pipeline: preprocess -> observe (1 model call) -> verdict (code)
 * -> evidence crops -> verify (1 model call on the claimed changes) -> report.
 */
import { randomUUID } from "node:crypto";
import { cropEvidence, toDataUrl, type CropPair } from "./evidence";
import { preprocessImage, PreprocessError, type PreprocessedImage, type SourceFormat } from "./preprocess";
import { appendRunLog, toLoggedCall, totalCost, type LoggedCall, type Prices, type RunLogEntry } from "./runlog";
import type { PhotoSet, UploadedPhoto } from "./upload";
import { applyVerification, computeReport, type ObjectVerdict, type Report, type VerificationResult } from "./verdict";
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
  /** Evidence crops as JPEG data URLs, keyed by object id. */
  crops: Record<string, { before: string; after: string }>;
  photos: Record<PhotoSet, PhotoInfo[]>;
  run: { id: string; model_id: string; wall_ms: number; cost_usd: number | null };
}

export interface PipelineDeps {
  /** Created lazily, after the photos are known to be readable. */
  getProvider: () => Promise<VisionProvider>;
  prices: Prices | null;
  logPath?: string;
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
    const images = await timed("preprocess", () => preprocessAll(photos));
    provider = await deps.getProvider();
    const p = provider;

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

    report = await timed("verdict", () => computeReport(observed.observation));

    const full = { before: images.before.map((i) => i.full), after: images.after.map((i) => i.full) };
    const pairs = new Map<string, CropPair>();
    await timed("evidence", async () => {
      for (const v of allVerdicts(report!)) {
        if (v.evidence) pairs.set(v.object_id, await cropEvidence(full, v.evidence));
      }
    });

    const objects = new Map(observed.observation.objects.map((o) => [o.id, o]));
    const claims: Claim[] = allVerdicts(report)
      .filter((v) => CLAIM_KINDS.includes(v.verdict as ClaimKind) && pairs.has(v.object_id))
      .map((v) => ({
        id: v.object_id,
        kind: v.verdict as ClaimKind,
        label: v.label,
        description: objects.get(v.object_id)?.description ?? v.label,
        before: pairs.get(v.object_id)!.before.jpeg,
        after: pairs.get(v.object_id)!.after.jpeg,
      }));

    // A change is only reported once the verify step confirms it. A claim without
    // crops, or a failed verify call, cannot be confirmed, so it becomes uncertain.
    const results: VerificationResult[] = await timed("verify", async () => {
      const unverifiable = allVerdicts(report!)
        .filter((v) => CLAIM_KINDS.includes(v.verdict as ClaimKind) && !pairs.has(v.object_id))
        .map((v) => ({ object_id: v.object_id, confirmed: false, checked: false, note: "no evidence crops were available" }));
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
    }

    return {
      report,
      crops,
      photos: {
        before: photos.before.map((ph, i) => photoInfo(ph, images.before[i])),
        after: photos.after.map((ph, i) => photoInfo(ph, images.after[i])),
      },
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
