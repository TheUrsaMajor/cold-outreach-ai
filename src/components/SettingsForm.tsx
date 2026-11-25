"use client";
import { useRouter } from "next/navigation";
import { useState } from "react";
import type { SenderProfile } from "@/lib/ai/prompt";

export function SettingsForm({ initial }: { initial: SenderProfile }) {
  const router = useRouter();
  const [f, setF] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const set = (k: keyof SenderProfile) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setF({ ...f, [k]: e.target.value });
  return (
    <form
      className="card space-y-4 p-5"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setMsg(null);
        const res = await fetch("/api/settings", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...f, calendarLink: f.calendarLink || undefined }) });
        setBusy(false);
        const j = await res.json().catch(() => ({}));
        setMsg(res.ok ? { ok: true, text: "Saved. New drafts will use these details." } : { ok: false, text: j.error ?? "Save failed." });
        router.refresh();
      }}
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <label className="label" htmlFor="sn">Your name</label>
          <input id="sn" className="input" value={f.senderName} onChange={set("senderName")} maxLength={80} required />
        </div>
        <div>
          <label className="label" htmlFor="st">Your title</label>
          <input id="st" className="input" value={f.senderTitle} onChange={set("senderTitle")} maxLength={80} />
        </div>
      </div>
      <div>
        <label className="label" htmlFor="pn">Product name</label>
        <input id="pn" className="input" value={f.productName} onChange={set("productName")} maxLength={80} required />
      </div>
      <div>
        <label className="label" htmlFor="pp">What the product does (the AI pitches this)</label>
        <textarea id="pp" className="input min-h-[140px]" value={f.productPitch} onChange={set("productPitch")} maxLength={1500} required />
      </div>
      <div>
        <label className="label" htmlFor="cl">Booking link (optional, not inserted into first emails for deliverability)</label>
        <input id="cl" className="input" value={f.calendarLink ?? ""} onChange={set("calendarLink")} maxLength={300} placeholder="https://cal.com/you" />
      </div>
      {msg && <p className={`text-sm ${msg.ok ? "text-emerald-700" : "text-red-700"}`}>{msg.text}</p>}
      <button className="btn-primary" disabled={busy}>{busy ? "Saving…" : "Save"}</button>
    </form>
  );
}
