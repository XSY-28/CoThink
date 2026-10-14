/** JSON values passed unchanged to provider generation options. */
export type ModelJsonValue = string | number | boolean | null | ModelJsonValue[] | { [key: string]: ModelJsonValue };

/** Only provider inputs: no session, member, phase, hash or domain snapshot. */
export interface ModelCall {
  protocol: string;
  baseUrl: string;
  modelId: string;
  apiKeyEnv: string;
  messages: Array<{ role: "system" | "user"; content: string }>;
  outputMode: "json_object" | "prompt_json";
  maxOutputTokens: number;
  generationOptions: Record<string, ModelJsonValue>;
}
export interface ModelUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  estimatedCost?: number;
  currency?: string;
  priceSnapshot?: Record<string, ModelJsonValue>;
}
export interface ModelMetadata {
  modelId: string;
  protocol: string;
  generationOptions: Record<string, ModelJsonValue>;
  usage: ModelUsage;
  finishReason: string | null;
}
export interface ModelReply extends ModelMetadata {
  rawContent: string;
  payload: unknown;
}
export interface ModelTransport {
  respond(call: ModelCall, signal: AbortSignal): Promise<ModelReply>;
}
/** Failed attempts retain observations without claiming a valid domain reply. */
export class ModelTransportFailure extends Error {
  constructor(
    readonly error: { code: string; message: string; retryable: boolean },
    readonly details: { runtime?: ModelMetadata; rawContent?: string; payload?: unknown } = {}
  ) {
    super(error.message);
    this.name = "ModelTransportFailure";
  }
}
