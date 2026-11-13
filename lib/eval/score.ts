/**
 * Scoring of one report against the ground truth of one pair. Pure code, used by
 * scripts/eval.ts and unit-tested on synthetic data (tests never read testset/).
 */
import type { Report, VerdictKind } from "../verdict";

export type GtVerdict = VerdictKind;

export interface GtItem {
  object: string;
  verdict?: GtVerdict;
  allowed?: GtVerdict[];
  forbidden?: GtVerdict[];
}

export interface PairSpec {
  id: string;
  expected: GtItem[];
  decline?: boolean;
}

/**
 * Model labels -> ground-truth object names. Matched as whole words or phrases;
 * the longest matching phrase wins. Unmatched labels are reported for review.
 */
const DESK: Record<string, string[]> = {
  cup: ["cup", "mug", "teacup"],
  scissors: ["scissors"],
  // The only pink object on the desk, often labelled "pink block" or "pink figurine".
  "14": ["14", "fourteen", "pink"],
  tape: ["tape"],
  headphones: ["headphones", "headphone", "headset", "earphones"],
  book: ["book", "booklet"],
};

const RED_MAT: Record<string, string[]> = {
  "gray-green cube": ["gray-green cube", "grey-green cube", "gray green cube", "grey green cube", "green-gray cube", "green-grey cube", "gray cube", "grey cube", "olive cube", "dark green cube"],
  "lime cube": ["lime cube", "lime-green cube", "lime green cube", "light green cube", "yellow-green cube", "yellow green cube", "neon green cube", "bright green cube"],
  "17": ["17", "seventeen"],
  "10": ["10", "ten"],
  multitool: ["multitool", "multi-tool", "multi tool", "pliers", "pocket tool"],
};

/** Synonyms per scene name from changelog.json, so a colour word can be safe in one scene only. */
export const SCENE_SYNONYMS: Record<string, Record<string, string[]>> = { desk: DESK, red_mat: RED_MAT };

/** All scenes together, without scene-only colour words. */
export const SYNONYMS: Record<string, string[]> = {
  ...Object.fromEntries(Object.entries(DESK).map(([k, v]) => [k, v.filter((w) => w !== "pink")])),
  ...RED_MAT,
};

const CHANGES: GtVerdict[] = ["moved", "added", "removed"];
const isChange = (v: GtVerdict) => CHANGES.includes(v);

const norm = (s: string) => ` ${s.toLowerCase().replace(/[^a-z0-9-]+/g, " ").replace(/\s+/g, " ").trim()} `;

/** Returns the ground-truth object name for a model label, or null. */
export function matchLabel(label: string, synonyms: Record<string, string[]> = SYNONYMS): string | null {
  const text = norm(label);
  let best: { key: string; len: number } | null = null;
  for (const [key, list] of Object.entries(synonyms)) {
    for (const syn of list) {
      const phrase = norm(syn);
      if (text.includes(phrase) && (!best || phrase.length > best.len)) best = { key, len: phrase.length };
    }
  }
  return best?.key ?? null;
}

function acceptable(gt: GtItem, v: GtVerdict): boolean {
  return gt.verdict === v || (gt.allowed?.includes(v) ?? false);
}

export interface RunScore {
  declined: boolean;
  declineCorrect: boolean;
  /** Change claims that match the ground truth (verdict or allowed). */
  tp: number;
  /** Change claims that the ground truth does not support (includes unknown objects). */
  fp: number;
  /** Required changes that were not claimed. */
  miss: number;
  /** Of the misses: reported as uncertain / not_verifiable instead (a safe miss). */
  hedged: number;
  /** Verdicts the ground truth explicitly forbids for that object. */
  forbidden: number;
  /** Labels that did not match any known object. */
  unmatched: string[];
  /** One line per problem, for the report. */
  notes: string[];
}

export function scoreRun(pair: PairSpec, report: Report, synonyms: Record<string, string[]> = SYNONYMS): RunScore {
  const s: RunScore = { declined: report.status === "declined", declineCorrect: false, tp: 0, fp: 0, miss: 0, hedged: 0, forbidden: 0, unmatched: [], notes: [] };
  const required = pair.expected.filter((g) => g.verdict && isChange(g.verdict));
  s.declineCorrect = s.declined === Boolean(pair.decline);

  if (report.status === "declined") {
    if (!pair.decline) {
      s.miss = required.length;
      s.notes.push(`declined: ${report.reasons.join(" / ")}`);
    }
    return s;
  }

  const verdicts = [...report.changes, ...report.uncertain, ...report.not_verifiable, ...report.unchanged];
  const gtByName = new Map(pair.expected.map((g) => [g.object, g]));
  const seen = new Map<string, GtVerdict>();

  for (const v of verdicts) {
    const name = matchLabel(v.label, synonyms);
    if (!name) {
      s.unmatched.push(v.label);
      if (isChange(v.verdict)) {
        s.fp++;
        s.notes.push(`FP: "${v.label}" ${v.verdict} (unknown object)`);
      }
      continue;
    }
    if (seen.has(name)) {
      s.unmatched.push(`${v.label} (second match for ${name})`);
      if (isChange(v.verdict)) {
        s.fp++;
        s.notes.push(`FP: "${v.label}" ${v.verdict} (duplicate of ${name})`);
      }
      continue;
    }
    seen.set(name, v.verdict);
    const gt = gtByName.get(name);
    if (gt?.forbidden?.includes(v.verdict)) {
      s.forbidden++;
      s.notes.push(`forbidden: ${name} ${v.verdict}`);
    }
    if (!isChange(v.verdict)) continue;
    if (gt && acceptable(gt, v.verdict)) s.tp++;
    else {
      s.fp++;
      s.notes.push(`FP: ${name} ${v.verdict} (expected ${gt ? (gt.verdict ?? gt.allowed?.join("|")) : "no change"})`);
    }
  }

  for (const g of required) {
    const got = seen.get(g.object);
    if (got && acceptable(g, got)) continue;
    s.miss++;
    if (got === "uncertain" || got === "not_verifiable") s.hedged++;
    s.notes.push(`miss: ${g.object} ${g.verdict} (got ${got ?? "not listed"})`);
  }
  return s;
}

export const median = (xs: number[]) => {
  if (xs.length === 0) return NaN;
  const a = [...xs].sort((x, y) => x - y);
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
};
