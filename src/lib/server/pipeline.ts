import "server-only";
import { crawlSite, type CrawlResult } from "../crawler/crawl";
import { normalizeInputUrl, siteKey, UrlValidationError } from "../crawler/url";
import { discoverContacts, type DiscoveredContact, type DiscoveryResult } from "../contacts/discover";
import { generateOutreach, type Attempt, type GenerationResult } from "../ai/generate";
import { buildSources, type SenderProfile, type SourceDoc } from "../ai/prompt";
import { env } from "../env";
import { audit, enforceRunLimits, HttpError, type Ctx } from "./common";

export type Stage = "validating" | "crawling" | "contacts" | "writing" | "saving" | "done";
export type Emit = (event: { stage: Stage; message: string; detail?: Record<string, unknown> }) => void;

function companyNameFrom(crawl: CrawlResult, ai?: string): string {
  if (ai && ai.length <= 80 && !/^unknown$/i.test(ai)) return ai.trim();
  const home = crawl.pages.find((p) => p.extract);
  const e = home?.extract;
  if (e?.orgName && e.orgName.length <= 80) return e.orgName;
  if (e?.siteName && e.siteName.length <= 80) return e.siteName;
  const t = e?.title?.split(/\s[|\-–—:·]\s/)[0]?.trim();
  if (t && t.length >= 2 && t.length <= 60) return t;
  const d = crawl.domain.split(".")[0];
  return d.charAt(0).toUpperCase() + d.slice(1);
}

function pickRecipient(contacts: DiscoveredContact[]) {
  return contacts.find((c) => c.kind === "email" && c.isValid) ?? null;
}

async function logAttempt(ctx: Ctx, runId: string | null, companyId: string, a: Attempt) {
  const { error } = await ctx.supabase.from("ai_usage_logs").insert({
    owner_id: ctx.user.id,
    run_id: runId,
    company_id: companyId,
    provider: a.provider,
    model: a.model,
    attempt: a.attempt,
    success: a.success,
    error: a.error ?? null,
    prompt_tokens: a.promptTokens,
    completion_tokens: a.completionTokens,
    total_tokens: a.totalTokens,
    latency_ms: a.latencyMs,
    cost_usd: a.costUsd,
  });
  if (error) console.error("usage log insert failed", error.message);
}

async function saveDiscovery(ctx: Ctx, companyId: string, discovery: DiscoveryResult) {
  await ctx.supabase.from("contacts").delete().eq("company_id", companyId);
  await ctx.supabase.from("founders").delete().eq("company_id", companyId);
  const founderIds = new Map<string, string>();
  if (discovery.founders.length) {
    const { data, error } = await ctx.supabase
      .from("founders")
      .insert(discovery.founders.map((f) => ({ owner_id: ctx.user.id, company_id: companyId, name: f.name.slice(0, 200), title: f.title.slice(0, 200), source_url: f.sourceUrl, evidence: f.evidence.slice(0, 1000) })))
      .select("id,name");
    if (error) throw new Error(`Saving founders failed: ${error.message}`);
    for (const r of data ?? []) founderIds.set(r.name, r.id);
  }
  let saved: { id: string; kind: string; value: string }[] = [];
  if (discovery.contacts.length) {
    const { data, error } = await ctx.supabase
      .from("contacts")
      .insert(
        discovery.contacts.map((c) => ({
          owner_id: ctx.user.id,
          company_id: companyId,
          founder_id: c.founderName ? (founderIds.get(c.founderName) ?? null) : null,
          kind: c.kind,
          value: c.value.slice(0, 1000),
          label: c.label.slice(0, 200),
          tier: c.tier,
          rank: c.rank,
          confidence: c.confidence,
          source_url: c.sourceUrl,
          mx_valid: c.mxValid ?? null,
          is_valid: c.isValid,
          invalid_reason: c.invalidReason ?? null,
        })),
      )
      .select("id,kind,value");
    if (error) throw new Error(`Saving contacts failed: ${error.message}`);
    saved = data ?? [];
  }
  return saved;
}

export async function saveDraft(ctx: Ctx, opts: { companyId: string; runId: string | null; gen: GenerationResult; contactId: string | null; toEmail: string | null }) {
  const { gen } = opts;
  const { data, error } = await ctx.supabase
    .from("outreach_emails")
    .insert({
      owner_id: ctx.user.id,
      company_id: opts.companyId,
      run_id: opts.runId,
      contact_id: opts.contactId,
      to_email: opts.toEmail,
      subject: gen.subject.slice(0, 300),
      body: gen.body.slice(0, 10000),
      alt_subjects: gen.altSubjects.slice(0, 4),
      personalization: gen.personalization,
      strategy_notes: [gen.output.strategy_notes, gen.output.fit?.reason ? `Fit (${gen.output.fit.level}): ${gen.output.fit.reason}` : ""].filter(Boolean).join("\n").slice(0, 4000),
      provider: gen.provider,
      model: gen.model,
      is_fallback_template: gen.isTemplate,
      spam_score: gen.spam.score,
      spam_warnings: gen.spam.warnings,
    })
    .select("id")
    .single();
  if (error) throw new Error(`Saving the draft failed: ${error.message}`);
  await ctx.supabase.from("communications").insert({
    owner_id: ctx.user.id,
    company_id: opts.companyId,
    outreach_id: data.id,
    event: "draft_created",
    channel: "email",
    note: `Draft written by ${gen.isTemplate ? "the fallback template" : `${gen.provider} / ${gen.model}`}${opts.toEmail ? ` for ${opts.toEmail}` : ""}.`,
  });
  return data.id as string;
}

/**
 * Full pipeline: validate -> dedupe -> crawl -> find contacts -> write opener -> save.
 * Emits progress events so the UI can show what's happening.
 */
export async function runResearch(
  ctx: Ctx,
  input: { url: string; force?: boolean; tone?: string; extraInstructions?: string },
  sender: SenderProfile,
  emit: Emit,
): Promise<{ companyId: string; duplicate?: boolean; outreachId?: string }> {
  emit({ stage: "validating", message: "Checking the address" });
  let start: URL;
  try {
    start = normalizeInputUrl(input.url);
  } catch (e) {
    throw new HttpError(400, (e as Error).message);
  }
  const domain = siteKey(start.hostname);

  // Duplicate submission handling
  const { data: existing } = await ctx.supabase.from("companies").select("id,last_researched_at,status").eq("domain", domain).maybeSingle();
  if (existing && !input.force && existing.last_researched_at) {
    const ageH = (Date.now() - new Date(existing.last_researched_at).getTime()) / 3600_000;
    if (ageH < env.dedupeHours()) {
      return { companyId: existing.id, duplicate: true };
    }
  }
  if (existing?.status === "do_not_contact" && !input.force) {
    throw new HttpError(409, "This company is marked Do not contact. Change its status first if you really want to research it again.", { companyId: existing.id });
  }

  await enforceRunLimits(ctx);

  // Upsert company row
  let companyId = existing?.id as string | undefined;
  if (!companyId) {
    const { data, error } = await ctx.supabase.from("companies").insert({ owner_id: ctx.user.id, domain, url: start.href, status: "researching" }).select("id").single();
    if (error) {
      if (error.code === "23505") {
        const { data: again } = await ctx.supabase.from("companies").select("id").eq("domain", domain).single();
        companyId = again?.id;
      } else throw new Error(`Creating the company failed: ${error.message}`);
    } else companyId = data.id;
  }
  if (!companyId) throw new Error("Could not create the company record.");

  // Clear runs stuck in "running" (e.g. a crashed function) older than 5 minutes.
  await ctx.supabase
    .from("research_runs")
    .update({ status: "failed", errors: ["Run timed out or was interrupted."], finished_at: new Date().toISOString() })
    .eq("company_id", companyId)
    .eq("status", "running")
    .lt("started_at", new Date(Date.now() - 5 * 60_000).toISOString());

  const { data: run, error: runErr } = await ctx.supabase.from("research_runs").insert({ owner_id: ctx.user.id, company_id: companyId, input_url: start.href, status: "running" }).select("id").single();
  if (runErr) {
    if (runErr.code === "23505") throw new HttpError(409, "This company is already being researched. Wait for that run to finish.", { companyId });
    throw new Error(`Starting the run failed: ${runErr.message}`);
  }
  const runId = run.id as string;
  const prevStatus = existing?.status;
  await ctx.supabase.from("companies").update({ status: "researching", url: start.href }).eq("id", companyId);
  await audit(ctx, "research.start", "company", companyId, { url: start.href, force: !!input.force });

  const t0 = Date.now();
  const fail = async (message: string, errors: string[] = []) => {
    await ctx.supabase.from("research_runs").update({ status: "failed", errors: [message, ...errors], finished_at: new Date().toISOString(), duration_ms: Date.now() - t0 }).eq("id", runId);
    await ctx.supabase.from("companies").update({ status: prevStatus && !["new", "researching", "failed"].includes(prevStatus) ? prevStatus : "failed" }).eq("id", companyId);
    await audit(ctx, "research.failed", "company", companyId, { message });
  };

  try {
    emit({ stage: "crawling", message: `Reading ${start.hostname}` });
    let crawl: CrawlResult;
    try {
      crawl = await crawlSite(start.href, { maxPages: env.maxPages(), budgetMs: 26_000 });
    } catch (e) {
      const msg = e instanceof UrlValidationError ? e.message : `The website could not be crawled: ${(e as Error).message}`;
      await fail(msg);
      throw new HttpError(422, msg, { companyId });
    }
    const okPages = crawl.pages.filter((p) => p.extract);
    emit({ stage: "crawling", message: `Read ${okPages.length} page${okPages.length === 1 ? "" : "s"}`, detail: { pages: okPages.length, failed: crawl.pages.length - okPages.length, blocked: crawl.robotsBlocked.length } });

    // Save crawled pages (metadata + short excerpt; full text is not stored)
    if (crawl.pages.length) {
      await ctx.supabase.from("crawled_pages").insert(
        crawl.pages.slice(0, 80).map((p) => ({
          owner_id: ctx.user.id,
          run_id: runId,
          company_id: companyId,
          url: p.url.slice(0, 2000),
          status_code: p.status || null,
          title: p.extract?.title?.slice(0, 300) ?? null,
          word_count: p.extract?.wordCount ?? null,
          excerpt: p.extract ? (p.extract.description || p.extract.text).slice(0, 600) : null,
          error: p.error ?? null,
        })),
      );
    }

    const totalWords = okPages.reduce((n, p) => n + (p.extract?.wordCount ?? 0), 0);
    if (okPages.length && totalWords < 25) {
      const msg = `The website has almost no readable text (${totalWords} words)${crawl.errors[0] ? `. ${crawl.errors[0]}` : ""}`;
      await fail(msg, crawl.errors);
      throw new HttpError(422, `${msg} There isn't enough real information to write a truthful email, so none was written.`, { companyId });
    }
    if (!okPages.length) {
      const msg = crawl.errors[0] ?? "No readable pages were found on this website.";
      await fail(msg, crawl.errors.slice(1));
      throw new HttpError(422, `${msg} We couldn't read any content, so no email was written.`, { companyId });
    }

    emit({ stage: "contacts", message: "Looking for founders and contact details" });
    let discovery = await discoverContacts(crawl.pages, crawl.domain);
    emit({ stage: "contacts", message: discovery.best ? `Best contact: ${discovery.best.label}` : "No direct contact found yet", detail: { founders: discovery.founders.length, contacts: discovery.contacts.length } });

    const sources: SourceDoc[] = buildSources(crawl.pages, 60_000);
    const homeExtract = okPages[0].extract!;
    const description = homeExtract.description || homeExtract.headings[0] || "";
    const prelimName = companyNameFrom(crawl);
    let recipient = pickRecipient(discovery.contacts);
    const recipientFounder = recipient?.founderName ?? (recipient?.tier === "founder_email" ? discovery.founders[0]?.name : undefined);

    emit({ stage: "writing", message: "Writing the opener" });
    const gen = await generateOutreach({
      sources,
      domain: crawl.domain,
      companyName: prelimName,
      description,
      founders: discovery.founders,
      recipientName: recipientFounder,
      sender,
      tone: input.tone,
      extraInstructions: input.extraInstructions,
      budgetMs: 48_000,
      onAttempt: (a) => {
        emit({ stage: "writing", message: a.success ? `Written by ${a.provider === "template" ? "the fallback template" : a.model}` : `${a.model} failed, trying the next model`, detail: { provider: a.provider, model: a.model, success: a.success } });
        return logAttempt(ctx, runId, companyId!, a);
      },
    });

    // Founders confirmed by the AI (and verified against page text) can unlock founder-email matches.
    const newFounders = gen.founders.filter((f) => !discovery.founders.some((d) => d.name.toLowerCase() === f.name.toLowerCase()));
    if (newFounders.length) {
      discovery = await discoverContacts(crawl.pages, crawl.domain, newFounders);
      recipient = pickRecipient(discovery.contacts);
    }

    emit({ stage: "saving", message: "Saving everything" });
    const saved = await saveDiscovery(ctx, companyId, discovery);
    const recipientRow = recipient ? saved.find((s) => s.kind === recipient!.kind && s.value === recipient!.value.slice(0, 1000)) : undefined;
    const outreachId = await saveDraft(ctx, { companyId, runId, gen, contactId: recipientRow?.id ?? null, toEmail: recipient?.value ?? null });

    const name = companyNameFrom(crawl, gen.isTemplate ? undefined : gen.output.company_name);
    const status = prevStatus && ["contacted", "replied", "not_interested", "do_not_contact"].includes(prevStatus) ? prevStatus : "researched";
    await ctx.supabase
      .from("companies")
      .update({
        name: name.slice(0, 300),
        description: (gen.output.one_line_summary || description).slice(0, 5000),
        industry: gen.output.business_model?.slice(0, 300) ?? null,
        status,
        last_researched_at: new Date().toISOString(),
      })
      .eq("id", companyId);

    // Keep sources only on the newest run (storage hygiene).
    await ctx.supabase.from("research_runs").update({ sources: [] }).eq("company_id", companyId).neq("id", runId);
    const partial = crawl.errors.length > 0 || gen.isTemplate;
    await ctx.supabase
      .from("research_runs")
      .update({
        status: partial ? "partial" : "completed",
        pages_found: crawl.pagesFound,
        pages_crawled: okPages.length,
        pages_failed: crawl.pages.length - okPages.length,
        robots_blocked: crawl.robotsBlocked.length,
        facts: gen.facts,
        summary: {
          one_line_summary: gen.output.one_line_summary,
          business_model: gen.output.business_model,
          target_customers: gen.output.target_customers,
          pricing_notes: gen.output.pricing_notes,
          fit: gen.output.fit,
          pain_hypotheses: gen.output.pain_hypotheses,
          final_url: crawl.finalUrl,
          used_reader_fallback: crawl.usedReaderFallback,
          robots_fetched: crawl.robotsFetched,
        },
        ai_profile: { provider: gen.provider, model: gen.model, attempts: gen.attempts.length, template: gen.isTemplate },
        sources,
        outcome: discovery.outcome,
        errors: crawl.errors,
        duration_ms: Date.now() - t0,
        finished_at: new Date().toISOString(),
      })
      .eq("id", runId);
    await audit(ctx, "research.complete", "company", companyId, { outcome: discovery.outcome, provider: gen.provider, model: gen.model, pages: okPages.length });
    emit({ stage: "done", message: "Done" });
    return { companyId, outreachId };
  } catch (e) {
    if (e instanceof HttpError) throw e;
    await fail(`Unexpected error: ${(e as Error).message}`).catch(() => {});
    throw e;
  }
}

/** Write a new draft from the saved research (no re-crawl). */
export async function regenerate(ctx: Ctx, companyId: string, opts: { tone?: string; extraInstructions?: string; contactId?: string }, sender: SenderProfile) {
  await enforceRunLimits(ctx);
  const { data: company } = await ctx.supabase.from("companies").select("id,name,domain,description").eq("id", companyId).maybeSingle();
  if (!company) throw new HttpError(404, "Company not found.");
  const { data: run } = await ctx.supabase.from("research_runs").select("id,sources").eq("company_id", companyId).in("status", ["completed", "partial"]).order("started_at", { ascending: false }).limit(1).maybeSingle();
  const sources = (run?.sources ?? []) as SourceDoc[];
  if (!run || !sources.length) throw new HttpError(409, "There's no saved research for this company yet. Run the research again first.");
  const [{ data: founders }, { data: contacts }] = await Promise.all([
    ctx.supabase.from("founders").select("id,name,title,source_url,evidence").eq("company_id", companyId),
    ctx.supabase.from("contacts").select("id,kind,value,tier,is_valid,founder_id,rank").eq("company_id", companyId).order("rank"),
  ]);
  let contact = opts.contactId ? contacts?.find((c) => c.id === opts.contactId) : contacts?.find((c) => c.kind === "email" && c.is_valid);
  if (opts.contactId && !contact) throw new HttpError(400, "That contact doesn't belong to this company.");
  if (contact && contact.kind !== "email") contact = undefined;
  const recipientFounder = contact?.founder_id ? founders?.find((f) => f.id === contact!.founder_id)?.name : contact?.tier === "founder_email" ? founders?.[0]?.name : undefined;

  const gen = await generateOutreach({
    sources,
    domain: company.domain,
    companyName: company.name || company.domain,
    description: company.description || "",
    founders: (founders ?? []).map((f) => ({ name: f.name, title: f.title ?? "Founder", sourceUrl: f.source_url ?? "", evidence: f.evidence ?? "", method: "pattern" as const })),
    recipientName: recipientFounder,
    sender,
    tone: opts.tone,
    extraInstructions: opts.extraInstructions,
    budgetMs: 50_000,
    onAttempt: (a) => logAttempt(ctx, run.id, companyId, a),
  });
  const outreachId = await saveDraft(ctx, { companyId, runId: run.id, gen, contactId: contact?.id ?? null, toEmail: contact?.value ?? null });
  await audit(ctx, "outreach.regenerate", "company", companyId, { provider: gen.provider, model: gen.model });
  return { outreachId, provider: gen.provider, model: gen.model, template: gen.isTemplate };
}
