import { requireUser } from "@/lib/supabase/server";
import { audit, HttpError, jsonError, requestMeta } from "@/lib/server/common";
import { toCsv, type Cell } from "@/lib/csv";

export const dynamic = "force-dynamic";

const LIMIT = 5000;

/** GET /api/export?type=companies|contacts → CSV download of the signed-in user's data (RLS-scoped). */
export async function GET(req: Request) {
  try {
    const { supabase, user } = await requireUser();
    if (!user) throw new HttpError(401, "Please sign in.");
    const ctx = { supabase, user, ...requestMeta(req) };
    const type = new URL(req.url).searchParams.get("type") === "contacts" ? "contacts" : "companies";

    const [companies, founders, contacts, emails] = await Promise.all([
      supabase.from("companies").select("id,name,domain,url,status,description,last_researched_at,created_at").order("created_at", { ascending: false }).limit(LIMIT),
      supabase.from("founders").select("id,company_id,name,title,source_url").limit(LIMIT * 4),
      supabase.from("contacts").select("company_id,founder_id,kind,value,label,tier,rank,confidence,mx_valid,is_valid,invalid_reason,source_url").order("rank").limit(LIMIT * 10),
      type === "companies"
        ? supabase.from("outreach_emails").select("company_id,to_email,subject,body,status,model,spam_score,created_at").order("created_at", { ascending: false }).limit(LIMIT * 3)
        : Promise.resolve({ data: [], error: null }),
    ]);
    for (const r of [companies, founders, contacts, emails]) if (r.error) throw new Error(r.error.message);

    const byCompany = new Map((companies.data ?? []).map((c) => [c.id, c]));
    const founderName = new Map((founders.data ?? []).map((f) => [f.id, f.name]));
    const stamp = new Date().toISOString().slice(0, 10);
    let csv: string;
    let count: number;

    if (type === "contacts") {
      const rows: Cell[][] = [];
      for (const k of contacts.data ?? []) {
        const c = byCompany.get(k.company_id);
        if (!c) continue;
        rows.push([c.name ?? c.domain, c.domain, k.kind, k.value, k.label, tierLabel(k.tier), k.founder_id ? founderName.get(k.founder_id) : "", k.confidence, k.mx_valid === null ? "" : k.mx_valid ? "yes" : "no", k.is_valid ? "valid" : `invalid${k.invalid_reason ? `: ${k.invalid_reason}` : ""}`, k.source_url]);
      }
      csv = toCsv(["Company", "Domain", "Type", "Contact", "Label", "Tier", "Founder", "Confidence", "Mail server found", "Valid", "Found on page"], rows);
      count = rows.length;
    } else {
      const foundersOf = group(founders.data ?? []);
      const contactsOf = group((contacts.data ?? []).filter((k) => k.is_valid));
      const latestEmail = new Map<string, NonNullable<typeof emails.data>[number]>();
      for (const e of emails.data ?? []) if (!latestEmail.has(e.company_id)) latestEmail.set(e.company_id, e);
      const rows: Cell[][] = (companies.data ?? []).map((c) => {
        const fs = foundersOf.get(c.id) ?? [];
        const ks = contactsOf.get(c.id) ?? [];
        const best = ks[0];
        const e = latestEmail.get(c.id);
        return [
          c.name ?? c.domain,
          c.domain,
          c.url,
          c.status,
          c.description,
          fs.map((f) => (f.title ? `${f.name} (${f.title})` : f.name)).join("; "),
          best ? tierLabel(best.tier) : "",
          best?.value ?? "",
          ks.filter((k) => k.kind === "email").map((k) => k.value).join("; "),
          ks.filter((k) => k.kind !== "email").map((k) => `${k.kind}: ${k.value}`).join("; "),
          e?.to_email ?? "",
          e?.subject ?? "",
          e?.body ?? "",
          e?.status ?? "",
          e?.spam_score ?? "",
          e?.model ?? "",
          c.last_researched_at ?? "",
          c.created_at,
        ];
      });
      csv = toCsv(["Company", "Domain", "Website", "Status", "Description", "Founders", "Best contact type", "Best contact", "All emails", "Other contact methods", "Email to", "Subject", "Opener", "Email status", "Spam score", "AI model", "Last researched", "Added"], rows);
      count = rows.length;
    }

    await audit(ctx, "export.csv", "export", undefined, { type, rows: count });
    // BOM so Excel opens UTF-8 (names with accents, curly quotes) correctly.
    return new Response("﻿" + csv, {
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="steward-${type}-${stamp}.csv"`,
        "cache-control": "no-store",
      },
    });
  } catch (e) {
    return jsonError(e);
  }
}

function group<T extends { company_id: string }>(items: T[]): Map<string, T[]> {
  const m = new Map<string, T[]>();
  for (const it of items) {
    const list = m.get(it.company_id);
    if (list) list.push(it);
    else m.set(it.company_id, [it]);
  }
  return m;
}

function tierLabel(t: string) {
  return t === "founder_email" ? "Founder email" : t === "company_email" ? "Company email" : "Other contact";
}
