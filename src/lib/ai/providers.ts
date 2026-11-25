/**
 * Model-agnostic LLM layer. Each provider implements `generateJson`; the chain
 * (see chain.ts) decides order and fallbacks. Swapping a model is a config change:
 * set LLM_CHAIN, e.g. "gemini:gemini-3.5-flash,groq:llama-3.3-70b-versatile".
 */

export type ProviderName = "gemini" | "groq" | "openrouter";

export type LlmRequest = {
  system: string;
  user: string;
  temperature?: number;
  maxOutputTokens?: number;
  timeoutMs: number;
  signal?: AbortSignal;
};

export type LlmResponse = {
  text: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  modelVersion?: string;
};

export class LlmError extends Error {
  constructor(
    message: string,
    public readonly kind: "rate_limit" | "overloaded" | "timeout" | "auth" | "bad_request" | "server" | "network" | "empty" | "invalid_output" | "not_configured" | "safety",
    public readonly status?: number,
    public readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = "LlmError";
  }
  get retryable() {
    return ["rate_limit", "overloaded", "timeout", "server", "network", "empty", "invalid_output"].includes(this.kind);
  }
}

export type ModelSpec = { provider: ProviderName; model: string };

function classifyHttp(status: number, body: string, retryAfter?: string | null): LlmError {
  const short = body.replace(/\s+/g, " ").slice(0, 300);
  const ra = retryAfter ? Number(retryAfter) * 1000 : undefined;
  if (status === 429) return new LlmError(`Rate limited: ${short}`, "rate_limit", status, ra);
  if (status === 503 || status === 529) return new LlmError(`Model overloaded: ${short}`, "overloaded", status, ra);
  if (status === 401 || status === 403) return new LlmError(`Authentication failed: ${short}`, "auth", status);
  if (status === 400 || status === 404 || status === 422) return new LlmError(`Request rejected: ${short}`, "bad_request", status);
  return new LlmError(`Provider error ${status}: ${short}`, "server", status);
}

async function timedFetch(url: string, init: RequestInit, timeoutMs: number, outer?: AbortSignal): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onAbort = () => controller.abort();
  outer?.addEventListener("abort", onAbort);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (e) {
    if (controller.signal.aborted) throw new LlmError(`Timed out after ${timeoutMs} ms`, "timeout");
    throw new LlmError(`Network error: ${(e as Error).message}`, "network");
  } finally {
    clearTimeout(timer);
    outer?.removeEventListener("abort", onAbort);
  }
}

export function providerKey(p: ProviderName): string | undefined {
  const map: Record<ProviderName, string | undefined> = {
    gemini: process.env.GEMINI_API_KEY,
    groq: process.env.GROQ_API_KEY,
    openrouter: process.env.OPENROUTER_API_KEY,
  };
  return map[p]?.trim() || undefined;
}

async function callGemini(model: string, req: LlmRequest): Promise<LlmResponse> {
  const key = providerKey("gemini");
  if (!key) throw new LlmError("GEMINI_API_KEY is not set", "not_configured");
  const generationConfig: Record<string, unknown> = {
    temperature: req.temperature ?? 0.7,
    maxOutputTokens: req.maxOutputTokens ?? 4096,
    responseMimeType: "application/json",
  };
  // Keep "thinking" short so latency stays predictable; lite/gemma models ignore it.
  if (/^gemini-(3|flash-latest|pro)/.test(model) && !/lite/.test(model)) generationConfig.thinkingConfig = { thinkingLevel: process.env.GEMINI_THINKING_LEVEL || "minimal" };
  const body = {
    systemInstruction: { parts: [{ text: req.system }] },
    contents: [{ role: "user", parts: [{ text: req.user }] }],
    generationConfig,
    safetySettings: [
      { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_ONLY_HIGH" },
      { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_ONLY_HIGH" },
      { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_ONLY_HIGH" },
      { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_ONLY_HIGH" },
    ],
  };
  const isGemma = model.startsWith("gemma");
  if (isGemma) {
    // Gemma models don't accept systemInstruction or JSON mode.
    delete (body as Record<string, unknown>).systemInstruction;
    body.contents[0].parts[0].text = `${req.system}\n\n${req.user}`;
    delete generationConfig.responseMimeType;
  }
  const res = await timedFetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
    { method: "POST", headers: { "content-type": "application/json", "x-goog-api-key": key }, body: JSON.stringify(body) },
    req.timeoutMs,
    req.signal,
  );
  const raw = await res.text();
  if (!res.ok) throw classifyHttp(res.status, raw, res.headers.get("retry-after"));
  let data: {
    candidates?: { content?: { parts?: { text?: string; thought?: boolean }[] }; finishReason?: string }[];
    usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; thoughtsTokenCount?: number; totalTokenCount?: number };
    promptFeedback?: { blockReason?: string };
    modelVersion?: string;
  };
  try {
    data = JSON.parse(raw);
  } catch {
    throw new LlmError("Gemini returned a non-JSON response", "server");
  }
  if (data.promptFeedback?.blockReason) throw new LlmError(`Blocked by safety filter: ${data.promptFeedback.blockReason}`, "safety");
  const cand = data.candidates?.[0];
  const text = (cand?.content?.parts ?? [])
    .filter((p) => !p.thought && typeof p.text === "string")
    .map((p) => p.text)
    .join("");
  const u = data.usageMetadata ?? {};
  const completion = (u.candidatesTokenCount ?? 0) + (u.thoughtsTokenCount ?? 0);
  if (!text.trim()) throw new LlmError(`Empty response (finish reason ${cand?.finishReason ?? "unknown"})`, cand?.finishReason === "SAFETY" ? "safety" : "empty");
  return {
    text,
    promptTokens: u.promptTokenCount ?? 0,
    completionTokens: completion,
    totalTokens: u.totalTokenCount ?? (u.promptTokenCount ?? 0) + completion,
    modelVersion: data.modelVersion,
  };
}

async function callOpenAiCompatible(provider: "groq" | "openrouter", model: string, req: LlmRequest): Promise<LlmResponse> {
  const key = providerKey(provider);
  if (!key) throw new LlmError(`${provider === "groq" ? "GROQ_API_KEY" : "OPENROUTER_API_KEY"} is not set`, "not_configured");
  const url = provider === "groq" ? "https://api.groq.com/openai/v1/chat/completions" : "https://openrouter.ai/api/v1/chat/completions";
  const headers: Record<string, string> = { "content-type": "application/json", authorization: `Bearer ${key}` };
  if (provider === "openrouter") {
    headers["x-title"] = "Outreach Research";
    if (process.env.APP_URL) headers["http-referer"] = process.env.APP_URL;
  }
  const body: Record<string, unknown> = {
    model,
    temperature: req.temperature ?? 0.7,
    max_tokens: req.maxOutputTokens ?? 4096,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: req.system },
      { role: "user", content: req.user },
    ],
  };
  if (provider === "groq" && /gpt-oss|qwen3|deepseek-r1/.test(model)) body.reasoning_effort = "low";
  const res = await timedFetch(url, { method: "POST", headers, body: JSON.stringify(body) }, req.timeoutMs, req.signal);
  const raw = await res.text();
  if (!res.ok) {
    // Some free models reject json mode; caller may retry without it via a different chain entry.
    throw classifyHttp(res.status, raw, res.headers.get("retry-after"));
  }
  let data: { choices?: { message?: { content?: string }; finish_reason?: string }[]; usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number }; model?: string; error?: { message?: string } };
  try {
    data = JSON.parse(raw);
  } catch {
    throw new LlmError(`${provider} returned a non-JSON response`, "server");
  }
  if (data.error) throw new LlmError(`${provider} error: ${data.error.message}`, "server");
  const text = data.choices?.[0]?.message?.content ?? "";
  if (!text.trim()) throw new LlmError("Empty response", "empty");
  const u = data.usage ?? {};
  return {
    text,
    promptTokens: u.prompt_tokens ?? 0,
    completionTokens: u.completion_tokens ?? 0,
    totalTokens: u.total_tokens ?? (u.prompt_tokens ?? 0) + (u.completion_tokens ?? 0),
    modelVersion: data.model,
  };
}

export async function callModel(spec: ModelSpec, req: LlmRequest): Promise<LlmResponse> {
  switch (spec.provider) {
    case "gemini":
      return callGemini(spec.model, req);
    case "groq":
    case "openrouter":
      return callOpenAiCompatible(spec.provider, spec.model, req);
    default:
      throw new LlmError(`Unknown provider ${(spec as ModelSpec).provider}`, "not_configured");
  }
}

export const DEFAULT_CHAIN: ModelSpec[] = [
  { provider: "gemini", model: "gemini-3.5-flash" },
  { provider: "groq", model: "openai/gpt-oss-120b" },
  { provider: "groq", model: "qwen/qwen3.8-27b" },
  { provider: "gemini", model: "gemini-3.5-flash-lite" },
  { provider: "openrouter", model: "nvidia/nemotron-3-ultra-550b-a55b:free" },
  { provider: "openrouter", model: "google/gemma-4-31b-it:free" },
];

export function parseChain(value: string | undefined): ModelSpec[] {
  if (!value?.trim()) return DEFAULT_CHAIN;
  const out: ModelSpec[] = [];
  for (const part of value.split(",")) {
    const [provider, ...rest] = part.trim().split(":");
    const model = rest.join(":").trim();
    if ((provider === "gemini" || provider === "groq" || provider === "openrouter") && model) out.push({ provider, model });
  }
  return out.length ? out : DEFAULT_CHAIN;
}

export function configuredChain(): ModelSpec[] {
  return parseChain(process.env.LLM_CHAIN).filter((s) => !!providerKey(s.provider));
}
