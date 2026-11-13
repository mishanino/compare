import type { Observation } from "./observation";
import type { Claim, ClaimCheck } from "./verification";

/** One preprocessed image as sent to the model (EXIF-corrected JPEG). */
export interface ModelImage {
  jpeg: Buffer;
  width: number;
  height: number;
}

export interface ObserveInput {
  before: ModelImage[];
  after: ModelImage[];
}

/** Measurements for one logical model call (including its retry, if any). */
export interface CallUsage {
  modelId: string;
  inputTokens: number;
  /** Output tokens including thinking tokens (both are billed as output). */
  outputTokens: number;
  retries: number;
  wallMs: number;
}

export interface ObserveResult {
  observation: Observation;
  usage: CallUsage;
}

export interface VerifyResult {
  results: ClaimCheck[];
  usage: CallUsage;
}

/**
 * A vision model behind a fixed interface. It only observes and checks crops;
 * it never decides verdicts.
 */
export interface VisionProvider {
  readonly name: string;
  readonly modelId: string;
  observe(input: ObserveInput): Promise<ObserveResult>;
  /** One call for all claims. Must return exactly one result per claim id. */
  verify(claims: Claim[]): Promise<VerifyResult>;
}

/** Raised when the model output fails validation after the allowed retry. */
export class VisionSchemaError extends Error {
  constructor(
    message: string,
    readonly usage: CallUsage,
  ) {
    super(message);
    this.name = "VisionSchemaError";
  }
}

export class VisionConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VisionConfigError";
  }
}

type Env = Record<string, string | undefined>;

function requireEnv(env: Env, name: string): string {
  const v = env[name]?.trim();
  if (!v) throw new VisionConfigError(`Environment variable ${name} is not set.`);
  return v;
}

/** Builds the provider named by VISION_PROVIDER (default "gemini") from env. */
export async function createVisionProvider(env: Env = process.env): Promise<VisionProvider> {
  const name = env.VISION_PROVIDER?.trim() || "gemini";
  switch (name) {
    case "gemini": {
      const { GeminiProvider } = await import("./gemini");
      return GeminiProvider.fromApiKey(requireEnv(env, "GEMINI_API_KEY"), requireEnv(env, "GEMINI_MODEL_ID"));
    }
    default:
      throw new VisionConfigError(`Unknown VISION_PROVIDER "${name}".`);
  }
}
