"use client";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { STATUS_LABELS } from "./ui";

const EDITABLE = ["researched", "contacted", "replied", "not_interested", "do_not_contact"];

export function CompanyActions({ companyId, status, url }: { companyId: string; status: string; url: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  async function setStatus(s: string) {
    setBusy("status");
    setErr(null);
    const res = await fetch(`/api/companies/${companyId}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ status: s }) });
    setBusy(null);
    if (!res.ok) setErr((await res.json().catch(() => ({}))).error ?? "Update failed.");
    router.refresh();
  }

  async function rerun() {
    setBusy("rerun");
    setErr(null);
    try {
      const res = await fetch("/api/research", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ url, force: true }) });
      if (!res.ok || !res.body) throw new Error((await res.json().catch(() => ({}))).error ?? "Research failed.");
      const text = await res.text();
      const last = text.trim().split("\n").map((l) => JSON.parse(l)).filter((e) => e.type === "result" || e.type === "error").pop();
      if (!last) throw new Error("The connection closed before the research finished.");
      if (last.type === "error") throw new Error(last.error);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(null);
      router.refresh();
    }
  }

  async function remove() {
    setBusy("delete");
    const res = await fetch(`/api/companies/${companyId}`, { method: "DELETE" });
    setBusy(null);
    if (!res.ok) return setErr((await res.json().catch(() => ({}))).error ?? "Delete failed.");
    router.replace("/");
    router.refresh();
  }

  return (
    <div className="flex flex-col items-stretch gap-2 sm:items-end">
      <div className="flex flex-wrap gap-2">
        <select className="input w-auto" value={EDITABLE.includes(status) ? status : ""} onChange={(e) => setStatus(e.target.value)} disabled={!!busy} aria-label="Status">
          {!EDITABLE.includes(status) && <option value="">{STATUS_LABELS[status] ?? status}</option>}
          {EDITABLE.map((s) => <option key={s} value={s}>{STATUS_LABELS[s]}</option>)}
        </select>
        <button className="btn-secondary" onClick={rerun} disabled={!!busy}>{busy === "rerun" ? "Re-researching… (up to a minute)" : "Re-run research"}</button>
        {confirmDelete ? (
          <>
            <button className="btn-danger" onClick={remove} disabled={!!busy}>Confirm delete</button>
            <button className="btn-ghost" onClick={() => setConfirmDelete(false)}>Cancel</button>
          </>
        ) : (
          <button className="btn-ghost text-red-600" onClick={() => setConfirmDelete(true)} disabled={!!busy}>Delete</button>
        )}
      </div>
      {err && <p className="text-sm text-red-700">{err}</p>}
    </div>
  );
}
