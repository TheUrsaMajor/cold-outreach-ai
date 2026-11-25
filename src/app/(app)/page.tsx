import { requireUser } from "@/lib/supabase/server";
import { ResearchForm } from "@/components/ResearchForm";
import { CompaniesTable, type CompanyRow } from "@/components/CompaniesTable";
import { Stat } from "@/components/ui";

export default async function Dashboard() {
  const { supabase } = await requireUser();
  const dayAgo = new Date(Date.now() - 86_400_000).toISOString();
  const [companies, contacts, outreach, usage] = await Promise.all([
    supabase.from("companies").select("id,name,domain,status,last_researched_at,updated_at,description").order("updated_at", { ascending: false }).limit(500),
    supabase.from("contacts").select("company_id,kind,value,tier,rank,is_valid,label").eq("is_valid", true).order("rank").limit(5000),
    supabase.from("outreach_emails").select("status,company_id").limit(5000),
    supabase.from("ai_usage_logs").select("total_tokens,success").gte("created_at", dayAgo).limit(5000),
  ]);
  const best = new Map<string, { kind: string; value: string; tier: string; label: string }>();
  for (const c of contacts.data ?? []) if (!best.has(c.company_id)) best.set(c.company_id, c);
  const rows: CompanyRow[] = (companies.data ?? []).map((c) => ({ ...c, best: best.get(c.id) ?? null }));
  const sent = (outreach.data ?? []).filter((o) => ["sent", "replied"].includes(o.status)).length;
  const replied = (companies.data ?? []).filter((c) => c.status === "replied").length;
  const founderEmails = rows.filter((r) => r.best?.tier === "founder_email").length;
  const tokens = (usage.data ?? []).reduce((n, u) => n + (u.total_tokens ?? 0), 0);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-slate-900">Prospects</h1>
        <p className="mt-1 text-sm text-slate-500">Paste a company website. We read the site, find the best founder contact, and draft a short cold email opener you can edit and send.</p>
      </div>
      <ResearchForm />
      <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
        <Stat label="Companies" value={rows.length} />
        <Stat label="Founder emails found" value={founderEmails} hint={rows.length ? `${Math.round((founderEmails / rows.length) * 100)}% of companies` : undefined} />
        <Stat label="Emails sent" value={sent} />
        <Stat label="Replies" value={replied} hint={sent ? `${Math.round((replied / sent) * 100)}% reply rate` : undefined} />
        <Stat label="AI tokens (24h)" value={tokens.toLocaleString()} />
      </div>
      <CompaniesTable rows={rows} />
    </div>
  );
}
