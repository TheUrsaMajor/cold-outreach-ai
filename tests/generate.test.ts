import { beforeEach, describe, expect, it, vi } from "vitest";

const calls: string[] = [];
let behaviour: Record<string, () => Promise<unknown>> = {};

vi.mock("../src/lib/ai/providers", async (orig) => {
  const real = await orig<typeof import("../src/lib/ai/providers")>();
  return {
    ...real,
    callModel: vi.fn(async (spec: { provider: string; model: string }) => {
      calls.push(spec.model);
      const fn = behaviour[spec.model];
      if (!fn) throw new real.LlmError("not mocked", "server");
      return fn();
    }),
  };
});

import { LlmError } from "../src/lib/ai/providers";
import { extractJson, generateOutreach, verifyOutput } from "../src/lib/ai/generate";
import { checkDeliverability } from "../src/lib/ai/deliverability";
import { DEFAULT_SENDER } from "../src/lib/ai/prompt";

const sources = [
  { id: "S1", url: "https://ledgerly.io/", title: "Ledgerly", text: "Ledgerly is subscription analytics for bootstrapped SaaS founders. Plans start at $19/month." },
  { id: "S2", url: "https://ledgerly.io/about", title: "About", text: "Ledgerly was founded in 2021 by Priya Raman and Tom Becker." },
];

const goodOutput = {
  company_name: "Ledgerly",
  one_line_summary: "Subscription analytics for bootstrapped SaaS founders",
  business_model: "B2B SaaS",
  target_customers: "Bootstrapped SaaS founders",
  pricing_notes: "From $19/month",
  fit: { level: "high", reason: "Small SaaS" },
  key_facts: [{ fact: "Plans start at $19/month", source: "S1" }, { fact: "Founded in 2021", source: "S2" }, { fact: "Made up fact", source: "S9" }],
  founders: [
    { name: "Priya Raman", title: "Co-founder", evidence_quote: "founded in 2021 by Priya Raman", source: "S2" },
    { name: "Elon Fakename", title: "Founder", evidence_quote: "", source: "S2" },
  ],
  pain_hypotheses: ["Likely juggling finance and growth"],
  email: {
    subject_options: ["Re: ledgerly's $19 plan", "a question on churn"],
    opener: "Hi Priya,\n\nSaw Ledgerly starts at $19/month for bootstrapped SaaS founders, which is a smart wedge. At that price point, small churn swings move the whole month. Steward watches MRR, churn and failed payments daily and nudges you before they bite.\n\nWorth a 2-minute walkthrough?",
    personalization_used: [{ fact: "$19/month plan", source: "S1" }],
    cta: "Worth a 2-minute walkthrough?",
  },
  strategy_notes: "Specific pricing hook.",
};

const ok = (out: unknown = goodOutput) => async () => ({ text: JSON.stringify(out), promptTokens: 1200, completionTokens: 300, totalTokens: 1500 });

const chain = [
  { provider: "gemini" as const, model: "primary" },
  { provider: "groq" as const, model: "secondary" },
  { provider: "openrouter" as const, model: "tertiary" },
];
const base = { sources, domain: "ledgerly.io", companyName: "Ledgerly", description: "Subscription analytics", founders: [], sender: DEFAULT_SENDER, chain, budgetMs: 20_000 };

beforeEach(() => {
  calls.length = 0;
  behaviour = {};
});

describe("extractJson", () => {
  it("handles fences and preambles", () => {
    expect(extractJson('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(extractJson('Sure! Here it is: {"a":{"b":"}"}} thanks')).toEqual({ a: { b: "}" } });
    expect(() => extractJson("no json")).toThrow();
  });
});

describe("verifyOutput (never fabricate)", () => {
  it("drops facts with unknown sources and founders not in the sources", () => {
    const v = verifyOutput(goodOutput, sources, "Alex");
    expect(v.facts.map((f) => f.fact)).toEqual(["Plans start at $19/month", "Founded in 2021"]);
    expect(v.facts[0].source_url).toBe("https://ledgerly.io/");
    expect(v.founders.map((f) => f.name)).toEqual(["Priya Raman"]);
  });
  it("strips fake Re: from subjects, links from body, and signs with sender name", () => {
    const v = verifyOutput({ ...goodOutput, email: { ...goodOutput.email, opener: goodOutput.email.opener + "\nhttps://evil.example/track" } }, sources, "Alex");
    expect(v.subjects[0]).toBe("ledgerly's $19 plan");
    expect(v.body).not.toMatch(/https?:/);
    expect(v.body.trim().endsWith("Alex")).toBe(true);
  });
  it("rejects malformed output", () => {
    expect(() => verifyOutput({ company_name: "x" }, sources, "Alex")).toThrow(LlmError);
  });
});

describe("generateOutreach fallback chain", () => {
  it("uses the primary model when it works", async () => {
    behaviour.primary = ok();
    const r = await generateOutreach(base);
    expect(r.model).toBe("primary");
    expect(r.isTemplate).toBe(false);
    expect(r.attempts).toHaveLength(1);
    expect(r.attempts[0].totalTokens).toBe(1500);
  });
  it("falls back on rate limit / overload to the next provider", async () => {
    behaviour.primary = async () => {
      throw new LlmError("quota exceeded per day", "rate_limit", 429);
    };
    behaviour.secondary = async () => {
      throw new LlmError("overloaded", "overloaded", 503);
    };
    behaviour.tertiary = ok();
    const r = await generateOutreach(base);
    expect(calls).toEqual(["primary", "secondary", "tertiary"]);
    expect(r.model).toBe("tertiary");
    expect(r.attempts.filter((a) => !a.success)).toHaveLength(2);
  });
  it("treats invalid JSON as a failure and moves on", async () => {
    behaviour.primary = async () => ({ text: "I can't do that", promptTokens: 10, completionTokens: 5, totalTokens: 15 });
    behaviour.secondary = ok();
    const r = await generateOutreach(base);
    expect(r.model).toBe("secondary");
    expect(r.attempts[0].error).toMatch(/Invalid output/);
    expect(r.attempts[0].totalTokens).toBe(15); // tokens still tracked for failed calls
  });
  it("returns a template when every model fails, so there's always a result", async () => {
    behaviour.primary = async () => {
      throw new LlmError("timeout", "timeout");
    };
    behaviour.secondary = async () => {
      throw new LlmError("bad key", "auth", 401);
    };
    behaviour.tertiary = async () => {
      throw new LlmError("server", "server", 500);
    };
    const r = await generateOutreach(base);
    expect(r.isTemplate).toBe(true);
    expect(r.body).toMatch(/Ledgerly/);
    expect(r.spam.level).not.toBe("risky");
  });
  it("skips other models of a provider whose key is invalid", async () => {
    const c = [{ provider: "groq" as const, model: "g1" }, { provider: "groq" as const, model: "g2" }, { provider: "gemini" as const, model: "primary" }];
    behaviour.g1 = async () => {
      throw new LlmError("bad key", "auth", 401);
    };
    behaviour.primary = ok();
    const r = await generateOutreach({ ...base, chain: c });
    expect(calls).toEqual(["g1", "primary"]);
    expect(r.model).toBe("primary");
  });
});

describe("deliverability", () => {
  it("clean opener scores well", () => {
    const s = checkDeliverability("a question on churn", "Hi Priya,\n\nNoticed your pricing page. Curious how you track churn today?\n\nAlex");
    expect(s.level).toBe("good");
  });
  it("spammy copy is flagged", () => {
    const s = checkDeliverability("Re: FREE OFFER!!!", "ACT NOW to get 100% guaranteed results! Click here: https://bit.ly/x https://y.com");
    expect(s.level).toBe("risky");
    expect(s.warnings.length).toBeGreaterThan(3);
  });
});

describe("citations never leak into the email", () => {
  it("strips (S1) style ids", () => {
    const v = verifyOutput({ ...goodOutput, email: { ...goodOutput.email, opener: "Hi Priya,\n\nYour $19 plan (S1) is a smart wedge [S2] for bootstrapped founders who watch every dollar and need to keep churn low every single month.\n\nWorth a look?" } }, sources, "Alex");
    expect(v.body).not.toMatch(/S\d/);
  });
});

describe("primary retry", () => {
  it("retries the primary model once when overloaded", async () => {
    let n = 0;
    behaviour.primary = async () => {
      n++;
      if (n === 1) throw new LlmError("busy", "overloaded", 503);
      return ok()();
    };
    const r = await generateOutreach({ ...base, budgetMs: 40_000 });
    expect(calls).toEqual(["primary", "primary"]);
    expect(r.model).toBe("primary");
  });
});

describe("CTA and targeting guards", () => {
  it("adds the CTA when the opener has no question", () => {
    const v = verifyOutput({ ...goodOutput, email: { ...goodOutput.email, opener: "Hi Priya,\n\nYour $19 plan is a smart wedge for bootstrapped founders who watch every dollar and need to keep churn low.\n\nAlex", cta: "Worth a look?" } }, sources, "Alex");
    expect(v.body).toMatch(/Worth a look\?\n\nAlex$/);
  });
  it("rejects openers that mention our internal MRR band", () => {
    expect(() => verifyOutput({ ...goodOutput, email: { ...goodOutput.email, opener: "Hi Priya,\n\nAt the $10K-$50K MRR stage, founders juggle a lot of things and the numbers slip through the cracks.\n\nWorth a look?" } }, sources, "Alex")).toThrow();
  });
});

describe("rate limit with short retry-after", () => {
  it("waits and retries the same model once", async () => {
    let n = 0;
    behaviour.primary = async () => {
      throw new LlmError("busy", "overloaded", 503);
    };
    behaviour.secondary = async () => {
      n++;
      if (n === 1) throw new LlmError("Rate limit reached, try again in 1.2s", "rate_limit", 429, 300);
      return ok()();
    };
    const r = await generateOutreach({ ...base, budgetMs: 40_000 });
    expect(r.model).toBe("secondary");
    expect(calls.filter((c) => c === "secondary")).toHaveLength(2);
  });
});
