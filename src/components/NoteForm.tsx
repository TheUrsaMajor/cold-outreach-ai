"use client";
import { useRouter } from "next/navigation";
import { useState } from "react";

export function NoteForm({ companyId }: { companyId: string }) {
  const router = useRouter();
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  return (
    <form
      className="mt-3 flex gap-2"
      onSubmit={async (e) => {
        e.preventDefault();
        if (!note.trim()) return;
        setBusy(true);
        setErr(null);
        const res = await fetch(`/api/companies/${companyId}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ note: note.trim() }) });
        setBusy(false);
        if (!res.ok) return setErr((await res.json().catch(() => ({}))).error ?? "Couldn't save the note.");
        setNote("");
        router.refresh();
      }}
    >
      <input className="input" placeholder="Add a note (call, LinkedIn message, follow-up…)" value={note} onChange={(e) => setNote(e.target.value)} maxLength={4000} aria-label="Note" />
      <button className="btn-secondary" disabled={busy || !note.trim()}>Add</button>
      {err && <span className="text-xs text-red-600">{err}</span>}
    </form>
  );
}
