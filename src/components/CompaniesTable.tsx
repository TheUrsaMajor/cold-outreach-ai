"use client";
import Link from "next/link";
import { useMemo, useState } from "react";
import { StatusBadge, STATUS_LABELS, TIER_LABEL, timeAgo } from "./ui";

export type CompanyRow = {
  id: string;
  name: string | null;
  domain: string;
  status: string;
  last_researched_at: string | null;
  updated_at: string;
  description: string | null;
  best: { kind: string; value: string; tier: string; label: string } | null;
};

export function CompaniesTable({ rows }: { rows: CompanyRow[] }) {
  const [q, setQ] = useState("");
  const [status, setStatus] = useState("all");
  const filtered = useMemo(() => {
    const term = q.trim().toLowerCase();
    return rows.filter((r) => (status === "all" || r.status === status) && (!term || `${r.name ?? ""} ${r.domain} ${r.best?.value ?? ""}`.toLowerCase().includes(term)));
  }, [rows, q, status]);

  if (!rows.length) {
    return (
      <div className="card p-10 text-center text-sm text-slate-500">
        No prospects yet. Paste a company website above to research your first one.
      </div>
    );
  }
  return (
    <div className="card overflow-hidden">
      <div className="flex flex-col gap-2 border-b border-slate-200 p-3 sm:flex-row">
        <input className="input sm:max-w-xs" placeholder="Search companies or contacts" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search" />
        <select className="input sm:max-w-[200px]" value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Filter by status">
          <option value="all">All statuses</option>
          {Object.entries(STATUS_LABELS)
            .filter(([k]) => !["draft", "opened_in_mail", "sent", "bounced", "archived"].includes(k))
            .map(([k, v]) => (
              <option key={k} value={k}>{v}</option>
            ))}
        </select>
        <span className="self-center text-xs text-slate-400 sm:ml-auto">{filtered.length} of {rows.length}</span>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-left text-sm">
          <thead className="bg-slate-50 text-xs text-slate-500">
            <tr>
              <th className="px-4 py-2 font-medium">Company</th>
              <th className="px-4 py-2 font-medium">Best contact</th>
              <th className="px-4 py-2 font-medium">Status</th>
              <th className="px-4 py-2 font-medium">Researched</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {filtered.map((r) => (
              <tr key={r.id} className="hover:bg-slate-50">
                <td className="max-w-[320px] px-4 py-3">
                  <Link href={`/companies/${r.id}`} className="font-medium text-slate-900 hover:text-indigo-700">
                    {r.name || r.domain}
                  </Link>
                  <div className="truncate text-xs text-slate-500">{r.domain}{r.description ? ` · ${r.description}` : ""}</div>
                </td>
                <td className="px-4 py-3">
                  {r.best ? (
                    <>
                      <div className="max-w-[260px] truncate text-slate-800">{r.best.value.replace(/^https?:\/\/(www\.)?/, "")}</div>
                      <div className="text-xs text-slate-500">{TIER_LABEL[r.best.tier]}</div>
                    </>
                  ) : (
                    <span className="text-xs text-slate-400">None found</span>
                  )}
                </td>
                <td className="px-4 py-3"><StatusBadge status={r.status} /></td>
                <td className="whitespace-nowrap px-4 py-3 text-xs text-slate-500">{timeAgo(r.last_researched_at)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
