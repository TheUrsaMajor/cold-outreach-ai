import Link from "next/link";
import { notFound } from "next/navigation";
import { requireUser } from "@/lib/supabase/server";
import { EmailComposer, type Draft, type EmailContact } from "@/components/EmailComposer";
import { CompanyActions } from "@/components/CompanyActions";
import { NoteForm } from "@/components/NoteForm";
import { StatusBadge, TIER_LABEL, timeAgo } from "@/components/ui";

type Fact = { fact: string; source_url: string };

const KIND_ICON: Record<string, string> = {
  email: "✉️", phone: "☎️", contact_form: "📝", linkedin: "in", twitter: "𝕏", facebook: "f", instagram: "◎", github: "⌥", youtube: "▶", calendly: "📅", discord: "💬", other: "•",
};

function hrefFor(kind: string, value: string) {
  if (kind === "email") return `mailto:${value}`;
  if (kind === "phone") return `tel:${value.replace(/[^\d+]/g, "")}`;
  return value;
}

export default async function CompanyPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const { supabase } = await requireUser();
  const { data: company } = await supabase.from("companies").select("*").eq("id", id).maybeSingle();
  if (!company) notFound();

  const [runs, contacts, founders, drafts, comms] = await Promise.all([
    supabase.from("research_runs").select("id,status,pages_found,pages_crawled,pages_failed,robots_blocked,facts,summary,errors,duration_ms,started_at,outcome,ai_profile").eq("company_id", id).order("started_at", { ascending: false }).limit(10),
    supabase.from("contacts").select("id,kind,value,label,tier,rank,confidence,source_url,mx_valid,is_valid,invalid_reason").eq("company_id", id).order("rank"),
    supabase.from("founders").select("id,name,title,source_url,evidence").eq("company_id", id),
    supabase.from("outreach_emails").select("id,to_email,subject,body,alt_subjects,personalization,strategy_notes,provider,model,is_fallback_template,spam_score,spam_warnings,status,created_at,contact_id").eq("company_id", id).order("created_at", { ascending: false }).limit(20),
    supabase.from("communications").select("id,event,channel,note,created_at").eq("company_id", id).order("created_at", { ascending: false }).limit(50),
  ]);
  const latest = runs.data?.[0];
  const { data: pages } = latest ? await supabase.from("crawled_pages").select("url,status_code,title,word_count,error").eq("run_id", latest.id).order("fetched_at") : { data: [] };
  const summary = (latest?.summary ?? {}) as Record<string, unknown> & { fit?: { level: string; reason: string }; pain_hypotheses?: string[] };
  const facts = (latest?.facts ?? []) as Fact[];
  const emailContacts: EmailContact[] = (contacts.data ?? []).filter((c) => c.kind === "email").map((c) => ({ id: c.id, value: c.value, label: c.label ?? "", isValid: c.is_valid, tier: c.tier }));
  const errors = (latest?.errors ?? []) as string[];
  const noEmail = !emailContacts.some((c) => c.isValid);

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <Link href="/" className="text-xs text-slate-500 hover:text-slate-700">← All prospects</Link>
          <h1 className="mt-1 flex flex-wrap items-center gap-2 text-2xl font-semibold text-slate-900">
            {company.name || company.domain} <StatusBadge status={company.status} />
          </h1>
          <a href={company.url} target="_blank" rel="noopener noreferrer nofollow" className="text-sm text-indigo-700 hover:underline">{company.domain} ↗</a>
          {company.description && <p className="mt-2 max-w-3xl text-sm text-slate-600">{company.description}</p>}
        </div>
        <CompanyActions companyId={company.id} status={company.status} url={company.url} />
      </div>

      {latest?.status === "failed" && (
        <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800">
          <strong>Last research failed:</strong> {errors[0] ?? "Unknown error"}
        </div>
      )}
      {latest && latest.status !== "failed" && errors.length > 0 && (
        <details className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
          <summary className="cursor-pointer">The research finished with {errors.length} note{errors.length > 1 ? "s" : ""}</summary>
          <ul className="mt-2 list-disc pl-5">{errors.map((e, i) => <li key={i}>{e}</li>)}</ul>
        </details>
      )}

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)]">
        <div className="space-y-6">
          {drafts.data?.length ? (
            <EmailComposer companyId={company.id} drafts={drafts.data as Draft[]} contacts={emailContacts} noEmail={noEmail} />
          ) : (
            <div className="card p-6 text-sm text-slate-500">No email draft yet. {latest?.status === "failed" ? "Fix the issue above and re-run the research." : ""}</div>
          )}

          {(summary.one_line_summary || facts.length > 0) && (
            <section className="card p-5">
              <h2 className="font-semibold text-slate-900">What we learned</h2>
              <dl className="mt-3 grid gap-3 text-sm sm:grid-cols-2">
                {[["Business model", summary.business_model], ["Customers", summary.target_customers], ["Pricing", summary.pricing_notes]].map(([k, v]) =>
                  v ? (
                    <div key={k as string}>
                      <dt className="text-xs text-slate-500">{k as string}</dt>
                      <dd className="text-slate-800">{String(v)}</dd>
                    </div>
                  ) : null,
                )}
                {summary.fit && (
                  <div>
                    <dt className="text-xs text-slate-500">Fit for our product</dt>
                    <dd className="text-slate-800">
                      <span className={`badge mr-1 ${summary.fit.level === "high" ? "bg-emerald-100 text-emerald-800" : summary.fit.level === "low" ? "bg-red-100 text-red-700" : "bg-amber-100 text-amber-800"}`}>{summary.fit.level}</span>
                      {summary.fit.reason}
                    </dd>
                  </div>
                )}
              </dl>
              {facts.length > 0 && (
                <>
                  <h3 className="mt-4 text-xs font-medium uppercase tracking-wide text-slate-500">Facts with sources</h3>
                  <ul className="mt-2 space-y-1.5 text-sm">
                    {facts.map((f, i) => (
                      <li key={i} className="flex gap-2">
                        <span className="text-slate-400">•</span>
                        <span className="text-slate-800">
                          {f.fact}{" "}
                          <a href={f.source_url} target="_blank" rel="noopener noreferrer nofollow" className="text-xs text-indigo-600 hover:underline">[{safePath(f.source_url)}]</a>
                        </span>
                      </li>
                    ))}
                  </ul>
                </>
              )}
              {!!summary.pain_hypotheses?.length && (
                <>
                  <h3 className="mt-4 text-xs font-medium uppercase tracking-wide text-slate-500">Likely pains (hypotheses, not facts)</h3>
                  <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-slate-700">{summary.pain_hypotheses.map((p, i) => <li key={i}>{p}</li>)}</ul>
                </>
              )}
            </section>
          )}
        </div>

        <div className="space-y-6">
          <section className="card p-5">
            <h2 className="font-semibold text-slate-900">Founders</h2>
            {founders.data?.length ? (
              <ul className="mt-3 space-y-3 text-sm">
                {founders.data.map((f) => (
                  <li key={f.id}>
                    <div className="font-medium text-slate-900">{f.name}</div>
                    <div className="text-xs text-slate-500">{f.title}{f.source_url && <> · <a className="text-indigo-600 hover:underline" href={f.source_url} target="_blank" rel="noopener noreferrer nofollow">source</a></>}</div>
                    {f.evidence && <div className="mt-1 line-clamp-2 text-xs italic text-slate-500">“{f.evidence}”</div>}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mt-2 text-sm text-slate-500">No founder is named on the website. We never guess names.</p>
            )}
          </section>

          <section className="card p-5">
            <div className="flex items-center justify-between">
              <h2 className="font-semibold text-slate-900">Contacts</h2>
              {latest?.outcome && <span className="text-xs text-slate-500">Found: {TIER_LABEL[latest.outcome] ?? "nothing"}</span>}
            </div>
            <p className="mt-1 text-xs text-slate-500">Ranked by our fallback order: founder email, then any email on the site, then any other contact method.</p>
            {contacts.data?.length ? (
              <ul className="mt-3 divide-y divide-slate-100 text-sm">
                {contacts.data.map((c) => (
                  <li key={c.id} className="flex items-start gap-3 py-2">
                    <span className="mt-0.5 grid h-6 w-6 shrink-0 place-items-center rounded bg-slate-100 text-xs" aria-hidden>{KIND_ICON[c.kind] ?? "•"}</span>
                    <div className="min-w-0 flex-1">
                      <a href={hrefFor(c.kind, c.value)} target={c.kind === "email" || c.kind === "phone" ? undefined : "_blank"} rel="noopener noreferrer nofollow" className={`block truncate ${c.is_valid ? "text-slate-900 hover:text-indigo-700" : "text-slate-400 line-through"}`}>
                        {c.value.replace(/^https?:\/\/(www\.)?/, "")}
                      </a>
                      <div className="text-xs text-slate-500">
                        {c.label} · {c.confidence} confidence
                        {c.source_url && <> · <a className="text-indigo-600 hover:underline" href={c.source_url} target="_blank" rel="noopener noreferrer nofollow">source</a></>}
                      </div>
                      {!c.is_valid && <div className="text-xs text-red-600">{c.invalid_reason}</div>}
                      {c.kind === "email" && c.is_valid && c.mx_valid && <div className="text-xs text-emerald-600">Domain accepts email (MX verified)</div>}
                    </div>
                    <span className={`badge shrink-0 ${c.tier === "founder_email" ? "bg-emerald-100 text-emerald-800" : c.tier === "company_email" ? "bg-sky-100 text-sky-800" : "bg-slate-100 text-slate-600"}`}>{TIER_LABEL[c.tier]}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mt-2 text-sm text-slate-500">No public contact details were found on the website.</p>
            )}
          </section>

          <section className="card p-5">
            <h2 className="font-semibold text-slate-900">Activity</h2>
            <NoteForm companyId={company.id} />
            <ul className="mt-3 space-y-2 text-sm">
              {(comms.data ?? []).map((c) => (
                <li key={c.id} className="flex gap-2">
                  <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-slate-300" />
                  <div>
                    <span className="font-medium text-slate-800">{c.event.replace(/_/g, " ")}</span>
                    {c.channel && c.channel !== "email" && <span className="text-slate-500"> via {c.channel}</span>}
                    {c.note && <span className="text-slate-600">: {c.note}</span>}
                    <div className="text-xs text-slate-400">{timeAgo(c.created_at)}</div>
                  </div>
                </li>
              ))}
              {!comms.data?.length && <li className="text-slate-500">Nothing yet.</li>}
            </ul>
          </section>

          {latest && (
            <section className="card p-5">
              <h2 className="font-semibold text-slate-900">Pages read</h2>
              <p className="mt-1 text-xs text-slate-500">
                {latest.pages_crawled} read · {latest.pages_failed} failed · {latest.robots_blocked} skipped by robots.txt · {Math.round((latest.duration_ms ?? 0) / 1000)}s · {timeAgo(latest.started_at)}
              </p>
              <ul className="mt-3 max-h-72 space-y-1 overflow-y-auto text-xs">
                {(pages ?? []).map((p, i) => (
                  <li key={i} className="flex gap-2">
                    <span className={`w-9 shrink-0 tabular-nums ${p.error ? "text-red-600" : "text-emerald-600"}`}>{p.status_code || "—"}</span>
                    <a href={p.url} target="_blank" rel="noopener noreferrer nofollow" className="truncate text-slate-700 hover:text-indigo-700" title={p.error ?? p.title ?? p.url}>
                      {safePath(p.url)} {p.error ? <span className="text-red-600">({p.error})</span> : p.word_count ? <span className="text-slate-400">· {p.word_count} words</span> : null}
                    </a>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </div>
      </div>
    </div>
  );
}

function safePath(u: string) {
  try {
    const x = new URL(u);
    return x.pathname === "/" ? x.hostname : x.pathname;
  } catch {
    return u;
  }
}
