import { z } from "zod";
import { callModel, configuredChain, LlmError, type ModelSpec } from "./providers";
import { estimateCostUsd } from "./pricing";
import { fitSources, systemPrompt, userPrompt, type SenderProfile, type SourceDoc } from "./prompt";
import { checkDeliverability, type SpamCheck } from "./deliverability";
import type { DiscoveredFounder } from "../contacts/discover";

const factSchema = z.object({ fact: z.string().min(3).max(400), source: z.string().max(10) });

export const outputSchema = z.object({
  company_name: z.string().min(1).max(200),
  one_line_summary: z.string().max(600).default(""),
  business_model: z.string().max(300).default("unknown"),
  target_customers: z.string().max(400).default("unknown"),
  pricing_notes: z.string().max(600).default("not found"),
  fit: z
    .object({ level: z.enum(["high", "medium", "low"]).catch("medium"), reason: z.string().max(600).default("") })
    .default({ level: "medium", reason: "" }),
  key_facts: z.array(factSchema).max(12).default([]),
  founders: z
    .array(z.object({ name: z.string().min(3).max(100), title: z.string().max(100).default("Founder"), evidence_quote: z.string().max(400).default(""), source: z.string().max(10).default("") }))
    .max(8)
    .default([]),
  pain_hypotheses: z.array(z.string().max(300)).max(5).default([]),
  email: z.object({
    subject_options: z.array(z.string().min(2).max(120)).min(1).max(5),
    opener: z.string().min(80).max(1500),
    personalization_used: z.array(factSchema).max(6).default([]),
    cta: z.string().max(300).default(""),
  }),
  strategy_notes: z.string().max(1000).default(""),
});
export type ModelOutput = z.infer<typeof outputSchema>;

export type Attempt = {
  provider: string;
  model: string;
  attempt: number;
  success: boolean;
  error?: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  latencyMs: number;
  costUsd: number;
};

export type SourcedFact = { fact: string; source_url: string };

export type GenerationResult = {
  output: ModelOutput;
  facts: SourcedFact[];
  personalization: SourcedFact[];
  founders: DiscoveredFounder[];
  subject: string;
  altSubjects: string[];
  body: string;
  spam: SpamCheck;
  provider: string;
  model: string;
  isTemplate: boolean;
  attempts: Attempt[];
  sources: SourceDoc[];
};

/** Pull the first JSON object out of a model response (handles ``` fences and preambles). */
export function extractJson(text: string): unknown {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "");
  try {
    return JSON.parse(trimmed);
  } catch {}
  const start = trimmed.indexOf("{");
  if (start < 0) throw new Error("No JSON object in response");
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < trimmed.length; i++) {
    const c = trimmed[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return JSON.parse(trimmed.slice(start, i + 1));
    }
  }
  throw new Error("Unterminated JSON object in response");
}

const norm = (s: string) => s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, " ").trim();

/** Validate the model output against the sources and clean it. Throws LlmError(invalid_output) if unusable. */
export function verifyOutput(raw: unknown, sources: SourceDoc[], senderFirstName: string) {
  const parsed = outputSchema.safeParse(raw);
  if (!parsed.success) {
    throw new LlmError(`Output failed validation: ${parsed.error.issues.slice(0, 3).map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}`, "invalid_output");
  }
  const out = parsed.data;
  const byId = new Map(sources.map((s) => [s.id.toUpperCase(), s]));
  const resolve = (id: string) => byId.get(id.trim().toUpperCase().replace(/[^S0-9]/g, ""));

  const facts: SourcedFact[] = [];
  for (const f of out.key_facts) {
    const src = resolve(f.source);
    if (src) facts.push({ fact: f.fact, source_url: src.url });
  }
  const personalization: SourcedFact[] = [];
  for (const f of out.email.personalization_used) {
    const src = resolve(f.source);
    if (src) personalization.push({ fact: f.fact, source_url: src.url });
  }
  // Founders must literally appear in the cited source (or anywhere in sources) to be kept.
  const allText = norm(sources.map((s) => s.text).join(" "));
  const founders: DiscoveredFounder[] = [];
  for (const f of out.founders) {
    const src = resolve(f.source);
    const n = norm(f.name);
    const inSource = src ? norm(src.text).includes(n) : allText.includes(n);
    if (!inSource || n.split(" ").length < 2) continue;
    if (!/founder|ceo|chief executive|owner|managing director|president/i.test(f.title)) continue;
    founders.push({ name: f.name.trim(), title: f.title.trim(), sourceUrl: src?.url ?? sources[0]?.url ?? "", evidence: f.evidence_quote.slice(0, 300), method: "ai" });
  }

  let body = out.email.opener.replace(/\r\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  // Strip any links the model slipped in (deliverability rule) and markdown.
  body = body
    .replace(/\s*[\[(]\s*S\d+(?:\s*[,;]\s*S\d+)*\s*[\])]/g, "")
    .replace(/[\u2010\u2011\u2012]/g, "-")
    .replace(/\u00a0/g, " ");
  body = body.replace(/\*\*(.+?)\*\*/g, "$1").replace(/\[(.+?)\]\((.+?)\)/g, "$1").replace(/https?:\/\/\S+/g, "").replace(/[ \t]+\n/g, "\n").trim();
  // Guarantee a call to action: if the body has no question, add the model's CTA before the sign-off.
  const cta = out.email.cta.trim();
  if (!body.includes("?") && cta) {
    const lines = body.split("\n");
    const last = lines[lines.length - 1]?.trim() ?? "";
    const signOff = last && last.split(/\s+/).length <= 3 && !/[.?!]$/.test(last);
    body = signOff ? `${lines.slice(0, -1).join("\n").trim()}\n\n${cta}\n\n${last}` : `${body}\n\n${cta}`;
  }
  // Never leak the targeting band into an email.
  if (/\$?10k\s*[-–to]+\s*\$?50k/i.test(body)) throw new LlmError("Opener mentions our internal MRR targeting band", "invalid_output");
  const first = senderFirstName.trim();
  if (first && !new RegExp(`\\b${first.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*$`).test(body)) body = `${body}\n\n${first}`;
  const words = body.split(/\s+/).filter(Boolean).length;
  if (words < 20) throw new LlmError("Opener too short", "invalid_output");
  if (words > 220) throw new LlmError("Opener too long", "invalid_output");

  const subjects = out.email.subject_options.map((s) => s.replace(/^(re|fwd?|fw)\s*:\s*/i, "").replace(/["“”]/g, "").replace(/\s*[\[(]S\d+[\])]/g, "").replace(/[\u2010\u2011\u2012]/g, "-").trim()).filter(Boolean);
  if (!subjects.length) throw new LlmError("No subject line", "invalid_output");
  return { out, facts, personalization, founders, body, subjects };
}

/** Deterministic last-resort opener built only from crawled facts, so a result is always returned. */
export function templateOpener(opts: { companyName: string; description: string; recipientFirstName?: string; sender: SenderProfile }) {
  const greet = opts.recipientFirstName ? `Hi ${opts.recipientFirstName},` : `Hi ${opts.companyName} team,`;
  const desc = opts.description
    .replace(/\s+/g, " ")
    .replace(/[.!]+$/, "")
    .trim();
  const observation = desc && desc.length > 20 && desc.length < 220 ? `I was reading about ${opts.companyName}: "${desc}".` : `I spent a few minutes on the ${opts.companyName} site this morning.`;
  const body = `${greet}

${observation} At your stage, the founders I talk to are usually the CFO, head of growth and ops lead all at once, and the numbers (churn, failed payments, runway) only get looked at when something breaks.

${opts.sender.productName} gives you an AI management team that watches those numbers daily and acts on them.

Worth a 2-minute walkthrough?

${opts.sender.senderName.split(" ")[0]}`;
  return { subject: `${opts.companyName.toLowerCase()} + the boring numbers`.slice(0, 60), altSubjects: ["quick idea for your metrics", `a management team for ${opts.companyName}`.slice(0, 60)], body };
}

export type GenerateOptions = {
  /** Numbered website sources (from buildSources at crawl time, or loaded from the DB). */
  sources: SourceDoc[];
  domain: string;
  companyName: string;
  description: string;
  founders: DiscoveredFounder[];
  recipientName?: string;
  sender: SenderProfile;
  tone?: string;
  extraInstructions?: string;
  budgetMs?: number;
  chain?: ModelSpec[];
  onAttempt?: (a: Attempt) => void | Promise<void>;
};

const CONTEXT_CHARS: Record<string, number> = { gemini: 60_000, groq: 14_000, openrouter: 30_000 };

/**
 * Runs the model chain until one returns a valid, source-grounded result.
 * Falls back to a deterministic template if every model fails, so the user
 * always gets an editable draft.
 */
export async function generateOutreach(opts: GenerateOptions): Promise<GenerationResult> {
  const started = Date.now();
  const budget = opts.budgetMs ?? 45_000;
  const chain = opts.chain ?? configuredChain();
  const attempts: Attempt[] = [];
  const firstName = opts.recipientName?.split(/\s+/)[0];
  const sys = systemPrompt(opts.sender);
  let lastSources: SourceDoc[] = opts.sources;
  const failedProviders = new Map<string, number>(); // provider -> consecutive auth/rate failures
  let retriedPrimary = false;

  for (let i = 0; i < chain.length; i++) {
    const spec = chain[i];
    const remaining = budget - (Date.now() - started);
    if (remaining < 4000) break;
    // If a provider is rate-limited or has a bad key, skip its other models.
    if ((failedProviders.get(spec.provider) ?? 0) > 0) continue;
    const sources = fitSources(opts.sources, CONTEXT_CHARS[spec.provider] ?? 30_000);
    lastSources = sources;
    if (!sources.length) break;
    const user = userPrompt({ domain: opts.domain, sources, founders: opts.founders, recipientName: opts.recipientName, tone: opts.tone, extraInstructions: opts.extraInstructions });
    // Slow "thinking" models get more time when they're first; later fallbacks get what's left.
    const isLast = i === chain.length - 1;
    const timeoutMs = Math.max(3000, Math.min(isLast ? remaining - 1000 : spec.provider === "gemini" && !/lite/.test(spec.model) ? 20_000 : 18_000, remaining - 3000));
    const t0 = Date.now();
    try {
      const res = await callModel(spec, { system: sys, user, temperature: 0.7, maxOutputTokens: spec.provider === "groq" ? 2000 : 3000, timeoutMs });
      const latencyMs = Date.now() - t0;
      const costUsd = estimateCostUsd(spec.model, res.promptTokens, res.completionTokens);
      let verified: ReturnType<typeof verifyOutput>;
      try {
        verified = verifyOutput(extractJson(res.text), sources, opts.sender.senderName.split(" ")[0]);
      } catch (e) {
        const a: Attempt = { provider: spec.provider, model: spec.model, attempt: attempts.length + 1, success: false, error: `Invalid output: ${(e as Error).message}`.slice(0, 500), promptTokens: res.promptTokens, completionTokens: res.completionTokens, totalTokens: res.totalTokens, latencyMs, costUsd };
        attempts.push(a);
        await opts.onAttempt?.(a);
        continue;
      }
      const a: Attempt = { provider: spec.provider, model: spec.model, attempt: attempts.length + 1, success: true, promptTokens: res.promptTokens, completionTokens: res.completionTokens, totalTokens: res.totalTokens, latencyMs, costUsd };
      attempts.push(a);
      await opts.onAttempt?.(a);
      const subject = verified.subjects[0];
      return {
        output: verified.out,
        facts: verified.facts,
        personalization: verified.personalization,
        founders: verified.founders,
        subject,
        altSubjects: verified.subjects.slice(1),
        body: verified.body,
        spam: checkDeliverability(subject, verified.body),
        provider: spec.provider,
        model: res.modelVersion && spec.provider === "gemini" ? spec.model : spec.model,
        isTemplate: false,
        attempts,
        sources,
      };
    } catch (e) {
      const err = e instanceof LlmError ? e : new LlmError((e as Error).message, "server");
      const a: Attempt = { provider: spec.provider, model: spec.model, attempt: attempts.length + 1, success: false, error: `${err.kind}: ${err.message}`.slice(0, 500), promptTokens: 0, completionTokens: 0, totalTokens: 0, latencyMs: Date.now() - t0, costUsd: 0 };
      attempts.push(a);
      await opts.onAttempt?.(a);
      // The preferred model is often only briefly overloaded: retry it once before falling back.
      if (i === 0 && !retriedPrimary && (err.kind === "overloaded" || (err.kind === "rate_limit" && !/quota|per day|daily/i.test(err.message))) && budget - (Date.now() - started) > 25_000) {
        retriedPrimary = true;
        await new Promise((r) => setTimeout(r, Math.min(err.retryAfterMs ?? 1500, 3000)));
        i--;
        continue;
      }
      if (err.kind === "auth" || err.kind === "not_configured") failedProviders.set(spec.provider, 1);
      if (err.kind === "rate_limit" && /quota|per day|RPD|daily/i.test(err.message)) failedProviders.set(spec.provider, 1);
    }
  }

  // Every model failed: deterministic, fact-only template.
  const t = templateOpener({ companyName: opts.companyName, description: opts.description, recipientFirstName: firstName, sender: opts.sender });
  const a: Attempt = { provider: "template", model: "template", attempt: attempts.length + 1, success: true, promptTokens: 0, completionTokens: 0, totalTokens: 0, latencyMs: 0, costUsd: 0 };
  attempts.push(a);
  await opts.onAttempt?.(a);
  const homepage = opts.sources[0]?.url ?? "";
  return {
    output: {
      company_name: opts.companyName,
      one_line_summary: opts.description,
      business_model: "unknown",
      target_customers: "unknown",
      pricing_notes: "not found",
      fit: { level: "medium", reason: "AI analysis unavailable. This draft was built from a template." },
      key_facts: [],
      founders: [],
      pain_hypotheses: [],
      email: { subject_options: [t.subject, ...t.altSubjects], opener: t.body, personalization_used: [], cta: "Worth a 2-minute walkthrough?" },
      strategy_notes: "All AI models were unavailable, so this is a safe template that uses only the site's own description. Edit before sending.",
    },
    facts: opts.description ? [{ fact: opts.description, source_url: homepage }] : [],
    personalization: [],
    founders: [],
    subject: t.subject,
    altSubjects: t.altSubjects,
    body: t.body,
    spam: checkDeliverability(t.subject, t.body),
    provider: "template",
    model: "template",
    isTemplate: true,
    attempts,
    sources: lastSources,
  };
}
