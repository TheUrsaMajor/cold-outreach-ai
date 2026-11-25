import { createClient } from "@supabase/supabase-js";
import { timingSafeEqual } from "node:crypto";
import { crawlSite } from "@/lib/crawler/crawl";
import { discoverContacts } from "@/lib/contacts/discover";
import { buildSources, DEFAULT_SENDER } from "@/lib/ai/prompt";
import { generateOutreach } from "@/lib/ai/generate";
import { callModel, configuredChain, parseChain } from "@/lib/ai/providers";
import { runResearch } from "@/lib/server/pipeline";
import { HttpError } from "@/lib/server/common";

export const runtime = "nodejs";
export const maxDuration = 120;
export const dynamic = "force-dynamic";

/**
 * Operator self-test, disabled unless SELFTEST_TOKEN is set. Lets an operator
 * verify crawling, contact discovery, every AI provider and the full DB pipeline
 * against real websites from the deployed environment. Remove the env var to disable.
 *   ?mode=models                 ping every configured model
 *   ?mode=dry&url=...            crawl + contacts + AI, no database writes
 *   ?mode=full&url=...&force=1   full pipeline as the SELFTEST_EMAIL user
 */
function authorized(req: Request) {
  const expected = process.env.SELFTEST_TOKEN;
  if (!expected || expected.length < 24) return false;
  const got = new URL(req.url).searchParams.get("token") ?? req.headers.get("x-selftest-token") ?? "";
  const a = Buffer.from(got);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function GET(req: Request) {
  if (!authorized(req)) return new Response("Not found", { status: 404 });
  const q = new URL(req.url).searchParams;
  const mode = q.get("mode") ?? "dry";
  const url = q.get("url") ?? "";
  const t0 = Date.now();
  try {
    if (mode === "models") {
      const chain = q.get("chain") ? parseChain(q.get("chain")!) : configuredChain();
      const results = await Promise.all(
        chain.map(async (spec) => {
          const s = Date.now();
          try {
            const r = await callModel(spec, { system: "Return JSON only.", user: 'Return {"ok":true}', timeoutMs: 25000, maxOutputTokens: 200, temperature: 0 });
            return { model: `${spec.provider}:${spec.model}`, ok: true, ms: Date.now() - s, text: r.text.slice(0, 80), tokens: r.totalTokens };
          } catch (e) {
            return { model: `${spec.provider}:${spec.model}`, ok: false, ms: Date.now() - s, error: (e as Error).message.slice(0, 300) };
          }
        }),
      );
      return Response.json({ mode, results });
    }
    if (mode === "list") {
      const [groq, or] = await Promise.all([
        fetch("https://api.groq.com/openai/v1/models", { headers: { authorization: `Bearer ${process.env.GROQ_API_KEY}` } }).then((r) => r.json()).catch((e) => ({ error: String(e) })),
        fetch("https://openrouter.ai/api/v1/models").then((r) => r.json()).catch((e) => ({ error: String(e) })),
      ]);
      return Response.json({
        groq: (groq.data ?? []).map((m: { id: string; context_window?: number }) => `${m.id} (${m.context_window})`),
        openrouterFree: (or.data ?? []).filter((m: { id: string }) => m.id.endsWith(":free")).map((m: { id: string; context_length?: number }) => `${m.id} (${m.context_length})`),
      });
    }
    if (mode === "dry") {
      const crawl = await crawlSite(url, { maxPages: Number(q.get("pages") || 30), budgetMs: 26000 });
      const disc = await discoverContacts(crawl.pages, crawl.domain);
      const out: Record<string, unknown> = {
        mode,
        crawl: { finalUrl: crawl.finalUrl, domain: crawl.domain, pagesFound: crawl.pagesFound, ok: crawl.pages.filter((p) => p.extract).length, failed: crawl.pages.filter((p) => !p.extract).map((p) => `${p.status} ${p.url} ${p.error}`), robotsBlocked: crawl.robotsBlocked.length, errors: crawl.errors, ms: crawl.durationMs, reader: crawl.usedReaderFallback, pages: crawl.pages.filter((p) => p.extract).map((p) => `${p.url} (${p.extract!.wordCount}w)`) },
        founders: disc.founders,
        contacts: disc.contacts.map((c) => ({ tier: c.tier, kind: c.kind, value: c.value, label: c.label, conf: c.confidence, mx: c.mxValid, valid: c.isValid, src: c.sourceUrl })),
        outcome: disc.outcome,
      };
      if (q.get("ai") !== "0" && crawl.pages.some((p) => p.extract)) {
        const sources = buildSources(crawl.pages, 60000);
        const chain = q.get("chain") ? parseChain(q.get("chain")!) : undefined;
        const gen = await generateOutreach({ sources, domain: crawl.domain, companyName: crawl.domain, description: "", founders: disc.founders, recipientName: disc.best?.founderName, sender: DEFAULT_SENDER, chain, budgetMs: 48000 });
        out.ai = { attempts: gen.attempts, subject: gen.subject, alt: gen.altSubjects, body: gen.body, spam: gen.spam, facts: gen.facts, founders: gen.founders.map((f) => f.name), fit: gen.output.fit, summary: gen.output.one_line_summary };
      }
      out.totalMs = Date.now() - t0;
      return Response.json(out);
    }
    if (mode === "full") {
      const email = process.env.SELFTEST_EMAIL;
      const password = process.env.SELFTEST_PASSWORD;
      if (!email || !password) return Response.json({ error: "SELFTEST_EMAIL/PASSWORD not set" }, { status: 400 });
      const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, { auth: { persistSession: false } });
      const { data, error } = await supabase.auth.signInWithPassword({ email, password });
      if (error || !data.user) return Response.json({ error: `sign-in failed: ${error?.message}` }, { status: 500 });
      const events: unknown[] = [];
      try {
        const r = await runResearch({ supabase, user: data.user, ip: "selftest", userAgent: "selftest" }, { url, force: q.get("force") === "1" }, DEFAULT_SENDER, (e) => events.push(e));
        return Response.json({ mode, result: r, events, ms: Date.now() - t0 });
      } catch (e) {
        if (e instanceof HttpError) return Response.json({ mode, httpError: { status: e.status, message: e.message, ...e.extra }, events, ms: Date.now() - t0 });
        throw e;
      }
    }
    return Response.json({ error: "unknown mode" }, { status: 400 });
  } catch (e) {
    return Response.json({ error: (e as Error).name, message: (e as Error).message, ms: Date.now() - t0 }, { status: 200 });
  }
}
