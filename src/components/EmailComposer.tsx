"use client";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { checkDeliverability } from "@/lib/ai/deliverability";
import { StatusBadge, timeAgo } from "./ui";

export type Draft = {
  id: string;
  to_email: string | null;
  subject: string;
  body: string;
  alt_subjects: string[];
  personalization: { fact: string; source_url: string }[];
  strategy_notes: string | null;
  provider: string | null;
  model: string | null;
  is_fallback_template: boolean;
  spam_score: number | null;
  status: string;
  created_at: string;
};
export type EmailContact = { id: string; value: string; label: string; isValid: boolean; tier: string };

const EMAIL_RE = /^[^\s@<>(),;:"]{1,64}@[a-z0-9.-]+\.[a-z]{2,24}$/i;

function composeLinks(to: string, subject: string, body: string) {
  const e = encodeURIComponent;
  return {
    gmail: `https://mail.google.com/mail/?view=cm&fs=1&to=${e(to)}&su=${e(subject)}&body=${e(body)}`,
    outlook: `https://outlook.office.com/mail/deeplink/compose?to=${e(to)}&subject=${e(subject)}&body=${e(body)}`,
    mailto: `mailto:${to.split(",").map((x) => e(x.trim())).join(",")}?subject=${e(subject)}&body=${e(body.replace(/\r?\n/g, "\r\n"))}`,
  };
}

async function api(url: string, method: string, body?: unknown) {
  const res = await fetch(url, { method, headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(j.error || `Request failed (${res.status})`);
  return j;
}

export function EmailComposer({ companyId, drafts, contacts, noEmail }: { companyId: string; drafts: Draft[]; contacts: EmailContact[]; noEmail: boolean }) {
  const router = useRouter();
  const [draftId, setDraftId] = useState(drafts[0].id);
  const draft = drafts.find((d) => d.id === draftId) ?? drafts[0];
  const [to, setTo] = useState(draft.to_email ?? "");
  const [subject, setSubject] = useState(draft.subject);
  const [body, setBody] = useState(draft.body);
  const [saving, setSaving] = useState(false);
  const [regen, setRegen] = useState(false);
  const [tone, setTone] = useState("friendly");
  const [instr, setInstr] = useState("");
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    setTo(draft.to_email ?? "");
    setSubject(draft.subject);
    setBody(draft.body);
    setMsg(null);
  }, [draft.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const dirty = to !== (draft.to_email ?? "") || subject !== draft.subject || body !== draft.body;
  const spam = useMemo(() => checkDeliverability(subject, body), [subject, body]);
  const words = body.split(/\s+/).filter(Boolean).length;
  const toValid = to.trim() === "" || EMAIL_RE.test(to.trim());

  async function save(quiet = false) {
    if (!toValid) {
      setMsg({ kind: "err", text: "The recipient email address isn't valid." });
      return false;
    }
    if (!subject.trim() || !body.trim()) {
      setMsg({ kind: "err", text: "Subject and body can't be empty." });
      return false;
    }
    setSaving(true);
    try {
      await api(`/api/outreach/${draft.id}`, "PATCH", { subject, body, toEmail: to.trim() });
      if (!quiet) setMsg({ kind: "ok", text: "Saved." });
      router.refresh();
      return true;
    } catch (e) {
      setMsg({ kind: "err", text: (e as Error).message });
      return false;
    } finally {
      setSaving(false);
    }
  }

  async function openIn(kind: "gmail" | "outlook" | "mailto") {
    if (!to.trim()) {
      setMsg({ kind: "err", text: "Add a recipient email first (none was found on the site, so check the Contacts panel for other ways to reach them)." });
      return;
    }
    if (!toValid) return setMsg({ kind: "err", text: "The recipient email address isn't valid." });
    const links = composeLinks(to.trim(), subject, body);
    // Open synchronously (popup blockers), then record in the background.
    if (kind === "mailto") window.location.href = links.mailto;
    else window.open(links[kind], "_blank", "noopener,noreferrer");
    if (dirty) await save(true);
    api(`/api/outreach/${draft.id}/events`, "POST", { event: "opened_in_mail", channel: kind }).then(() => router.refresh()).catch(() => {});
  }

  async function mark(event: "marked_sent" | "reply_received" | "bounced") {
    try {
      if (dirty) await save(true);
      await api(`/api/outreach/${draft.id}/events`, "POST", { event });
      setMsg({ kind: "ok", text: event === "marked_sent" ? "Marked as sent." : event === "reply_received" ? "Marked as replied. Nice!" : "Marked as bounced." });
      router.refresh();
    } catch (e) {
      setMsg({ kind: "err", text: (e as Error).message });
    }
  }

  async function regenerate() {
    setRegen(true);
    setMsg(null);
    try {
      const contact = contacts.find((c) => c.value === to.trim());
      const r = await api(`/api/companies/${companyId}/generate`, "POST", { tone, extraInstructions: instr.trim() || undefined, contactId: contact?.id });
      setMsg({ kind: "ok", text: r.template ? "AI models were unavailable, so a template draft was created." : `New draft written by ${r.model}.` });
      router.refresh();
      setDraftId(r.outreachId);
    } catch (e) {
      setMsg({ kind: "err", text: (e as Error).message });
    } finally {
      setRegen(false);
    }
  }

  return (
    <section className="card p-5">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="font-semibold text-slate-900">Email opener</h2>
        <StatusBadge status={draft.status} />
        {drafts.length > 1 && (
          <select className="input ml-auto w-auto py-1 text-xs" value={draftId} onChange={(e) => setDraftId(e.target.value)} aria-label="Draft version">
            {drafts.map((d, i) => (
              <option key={d.id} value={d.id}>
                Version {drafts.length - i} · {timeAgo(d.created_at)}{d.is_fallback_template ? " (template)" : ""}
              </option>
            ))}
          </select>
        )}
      </div>
      {draft.is_fallback_template && (
        <p className="mt-2 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800">All AI models were unavailable when this was written, so it&apos;s a safe template built from the site&apos;s own description. Try “Write a new version”.</p>
      )}
      {noEmail && (
        <p className="mt-2 rounded-lg bg-sky-50 px-3 py-2 text-xs text-sky-800">No email address was published on this website. Use the contact form, LinkedIn or other methods in the Contacts panel, or paste an address you have permission to use.</p>
      )}

      <div className="mt-4 space-y-3">
        <div>
          <label className="label" htmlFor="to">To</label>
          <input id="to" list="to-options" className={`input ${toValid ? "" : "border-red-400"}`} value={to} onChange={(e) => setTo(e.target.value)} placeholder="name@company.com" autoComplete="off" />
          <datalist id="to-options">
            {contacts.filter((c) => c.isValid).map((c) => <option key={c.id} value={c.value}>{c.label}</option>)}
          </datalist>
          {contacts.filter((c) => c.isValid).length > 1 && (
            <div className="mt-1.5 flex flex-wrap gap-1.5">
              {contacts.filter((c) => c.isValid).slice(0, 4).map((c) => (
                <button key={c.id} type="button" onClick={() => setTo(c.value)} className={`rounded-full border px-2 py-0.5 text-xs ${to === c.value ? "border-indigo-300 bg-indigo-50 text-indigo-700" : "border-slate-200 text-slate-600 hover:bg-slate-50"}`}>
                  {c.value}
                </button>
              ))}
            </div>
          )}
        </div>
        <div>
          <label className="label" htmlFor="subject">Subject</label>
          <input id="subject" className="input" value={subject} onChange={(e) => setSubject(e.target.value)} maxLength={300} />
          {draft.alt_subjects?.length > 0 && (
            <div className="mt-1.5 flex flex-wrap gap-1.5">
              <span className="text-xs text-slate-400">Alternatives:</span>
              {draft.alt_subjects.map((s) => (
                <button key={s} type="button" onClick={() => setSubject(s)} className="rounded-full border border-slate-200 px-2 py-0.5 text-xs text-slate-600 hover:bg-slate-50">
                  {s}
                </button>
              ))}
            </div>
          )}
        </div>
        <div>
          <div className="flex items-end justify-between">
            <label className="label" htmlFor="body">Body</label>
            <span className={`mb-1 text-xs ${words > 120 ? "text-amber-600" : "text-slate-400"}`}>{words} words</span>
          </div>
          <textarea id="body" className="input min-h-[220px] font-[inherit] leading-relaxed" value={body} onChange={(e) => setBody(e.target.value)} maxLength={10000} />
        </div>

        <div className={`rounded-lg border px-3 py-2 text-xs ${spam.level === "good" ? "border-emerald-200 bg-emerald-50 text-emerald-800" : spam.level === "ok" ? "border-amber-200 bg-amber-50 text-amber-800" : "border-red-200 bg-red-50 text-red-800"}`}>
          <div className="font-medium">
            Deliverability check: {spam.level === "good" ? "looks inbox-friendly" : spam.level === "ok" ? "a few risks" : "likely to hit spam"} (spam score {spam.score}/100)
          </div>
          {spam.warnings.length > 0 && <ul className="mt-1 list-disc pl-4">{spam.warnings.map((w) => <li key={w}>{w}</li>)}</ul>}
        </div>

        <div className="flex flex-wrap gap-2">
          <button className="btn-primary" onClick={() => openIn("gmail")}>Open in Gmail</button>
          <button className="btn-secondary" onClick={() => openIn("outlook")}>Open in Outlook</button>
          <button className="btn-secondary" onClick={() => openIn("mailto")}>Open in mail app</button>
          <button
            className="btn-secondary"
            onClick={async () => {
              await navigator.clipboard.writeText(`Subject: ${subject}\n\n${body}`);
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            }}
          >
            {copied ? "Copied" : "Copy"}
          </button>
          <button className="btn-ghost" disabled={!dirty || saving} onClick={() => save()}>
            {saving ? "Saving…" : dirty ? "Save changes" : "Saved"}
          </button>
        </div>
        <div className="flex flex-wrap items-center gap-2 border-t border-slate-100 pt-3">
          <span className="text-xs text-slate-500">After sending:</span>
          <button className="btn-ghost py-1 text-xs" onClick={() => mark("marked_sent")}>Mark as sent</button>
          <button className="btn-ghost py-1 text-xs" onClick={() => mark("reply_received")}>They replied</button>
          <button className="btn-ghost py-1 text-xs" onClick={() => mark("bounced")}>Bounced</button>
        </div>
        {msg && <p className={`text-sm ${msg.kind === "ok" ? "text-emerald-700" : "text-red-700"}`} role="status">{msg.text}</p>}
      </div>

      <details className="mt-4 rounded-lg bg-slate-50 p-3 text-sm">
        <summary className="cursor-pointer font-medium text-slate-700">Write a new version</summary>
        <div className="mt-3 grid gap-2 sm:grid-cols-[160px_1fr_auto]">
          <select className="input" value={tone} onChange={(e) => setTone(e.target.value)} aria-label="Tone">
            <option value="friendly">Friendly</option>
            <option value="direct">Direct</option>
            <option value="formal">Formal</option>
            <option value="playful">Playful</option>
          </select>
          <input className="input" value={instr} onChange={(e) => setInstr(e.target.value)} placeholder="Optional: e.g. focus on their pricing change" maxLength={500} />
          <button className="btn-primary" onClick={regenerate} disabled={regen}>
            {regen ? "Writing…" : "Write"}
          </button>
        </div>
      </details>

      <details className="mt-3 text-sm">
        <summary className="cursor-pointer text-slate-600">Why this email works & personalisation sources</summary>
        <div className="mt-2 space-y-2 text-slate-700">
          {draft.strategy_notes && <p className="whitespace-pre-line">{draft.strategy_notes}</p>}
          {draft.personalization?.length > 0 && (
            <ul className="list-disc pl-5">
              {draft.personalization.map((p, i) => (
                <li key={i}>
                  {p.fact}{" "}
                  <a className="text-xs text-indigo-600 hover:underline" href={p.source_url} target="_blank" rel="noopener noreferrer nofollow">source</a>
                </li>
              ))}
            </ul>
          )}
          <p className="text-xs text-slate-400">Written by {draft.is_fallback_template ? "fallback template" : `${draft.provider} · ${draft.model}`}</p>
        </div>
      </details>
    </section>
  );
}
