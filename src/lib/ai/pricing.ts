/**
 * Estimated list prices in USD per 1M tokens, used to estimate spend when a
 * provider's free tier is exceeded or a paid key is used. Free-tier calls cost
 * $0 in practice; the dashboard shows both. Override with MODEL_PRICING_JSON,
 * e.g. {"gemini-3.5-flash":{"in":0.5,"out":3}}.
 */
export type Price = { in: number; out: number };

const DEFAULT_PRICES: Record<string, Price> = {
  "gemini-3.5-flash": { in: 0.5, out: 3.0 },
  "gemini-3.5-flash-lite": { in: 0.1, out: 0.4 },
  "gemini-3.6-flash": { in: 0.5, out: 3.0 },
  "gemini-flash-latest": { in: 0.5, out: 3.0 },
  "gemini-flash-lite-latest": { in: 0.1, out: 0.4 },
  "gemma-4-31b-it": { in: 0, out: 0 },
  "llama-3.3-70b-versatile": { in: 0.59, out: 0.79 },
  "qwen/qwen3.8-27b": { in: 0.29, out: 0.59 },
  "llama-3.1-8b-instant": { in: 0.05, out: 0.08 },
  "openai/gpt-oss-120b": { in: 0.15, out: 0.6 },
  "openai/gpt-oss-20b": { in: 0.075, out: 0.3 },
  template: { in: 0, out: 0 },
};

let cached: Record<string, Price> | null = null;
export function prices(): Record<string, Price> {
  if (cached) return cached;
  let override: Record<string, Price> = {};
  try {
    if (process.env.MODEL_PRICING_JSON) override = JSON.parse(process.env.MODEL_PRICING_JSON);
  } catch {}
  cached = { ...DEFAULT_PRICES, ...override };
  return cached;
}

export function estimateCostUsd(model: string, promptTokens: number, completionTokens: number): number {
  if (model.endsWith(":free")) return 0;
  const p = prices()[model] ?? prices()[model.replace(/^models\//, "")] ?? { in: 0.5, out: 1.5 };
  return Number(((promptTokens * p.in + completionTokens * p.out) / 1_000_000).toFixed(6));
}

/** Documented free-tier limits (check provider consoles; they change). Used for the usage page meters. */
export const FREE_TIER_LIMITS: Record<string, { rpm?: number; rpd?: number; tpm?: number; note: string }> = {
  "gemini-3.5-flash": { rpm: 10, rpd: 250, tpm: 250_000, note: "Google AI Studio free tier (approx.)" },
  "gemini-3.5-flash-lite": { rpm: 15, rpd: 1000, tpm: 250_000, note: "Google AI Studio free tier (approx.)" },
  "qwen/qwen3.8-27b": { rpm: 60, rpd: 1000, tpm: 6_000, note: "Groq free tier (approx.)" },
  "openai/gpt-oss-120b": { rpm: 30, rpd: 1000, tpm: 8_000, note: "Groq free tier" },
  "nvidia/nemotron-3-ultra-550b-a55b:free": { rpm: 20, rpd: 50, note: "OpenRouter free models share 50/day (1000/day with $10 credit)" },
  "google/gemma-4-31b-it:free": { rpm: 20, rpd: 50, note: "OpenRouter free models share 50/day (1000/day with $10 credit)" },
};
