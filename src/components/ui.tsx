export const STATUS_STYLES: Record<string, string> = {
  new: "bg-slate-100 text-slate-700",
  researching: "bg-amber-100 text-amber-800",
  researched: "bg-sky-100 text-sky-800",
  failed: "bg-red-100 text-red-700",
  contacted: "bg-indigo-100 text-indigo-800",
  replied: "bg-emerald-100 text-emerald-800",
  not_interested: "bg-slate-200 text-slate-600",
  do_not_contact: "bg-red-100 text-red-800",
  draft: "bg-slate-100 text-slate-700",
  opened_in_mail: "bg-amber-100 text-amber-800",
  sent: "bg-indigo-100 text-indigo-800",
  bounced: "bg-red-100 text-red-700",
  archived: "bg-slate-100 text-slate-500",
};

export const STATUS_LABELS: Record<string, string> = {
  new: "New",
  researching: "Researching",
  researched: "Ready to contact",
  failed: "Research failed",
  contacted: "Contacted",
  replied: "Replied",
  not_interested: "Not interested",
  do_not_contact: "Do not contact",
  draft: "Draft",
  opened_in_mail: "Opened in mail app",
  sent: "Sent",
  bounced: "Bounced",
  archived: "Archived",
};

export function StatusBadge({ status }: { status: string }) {
  return <span className={`badge ${STATUS_STYLES[status] ?? "bg-slate-100 text-slate-700"}`}>{STATUS_LABELS[status] ?? status}</span>;
}

export function Stat({ label, value, hint }: { label: string; value: React.ReactNode; hint?: string }) {
  return (
    <div className="card p-4">
      <div className="text-xs font-medium text-slate-500">{label}</div>
      <div className="mt-1 text-2xl font-semibold tabular-nums text-slate-900">{value}</div>
      {hint && <div className="mt-0.5 text-xs text-slate-400">{hint}</div>}
    </div>
  );
}

export function timeAgo(iso: string | null | undefined): string {
  if (!iso) return "never";
  const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 86400 * 30) return `${Math.floor(s / 86400)}d ago`;
  return new Date(iso).toLocaleDateString();
}

export const TIER_LABEL: Record<string, string> = {
  founder_email: "Founder email",
  company_email: "Company email",
  other_contact: "Other contact",
};
