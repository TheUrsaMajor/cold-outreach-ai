"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { extractSites } from "@/lib/csv";

const MAX_SITES = 50;

type ItemState = "waiting" | "running" | "done" | "duplicate" | "failed" | "cancelled";
type Item = { site: string; state: ItemState; message?: string; companyId?: string };

const STATE_STYLE: Record<ItemState, string> = {
  waiting: "text-slate-400",
  running: "text-indigo-600",
  done: "text-emerald-700",
  duplicate: "text-slate-500",
  failed: "text-red-600",
  cancelled: "text-slate-400",
};
const STATE_LABEL: Record<ItemState, string> = {
  waiting: "Waiting",
  running: "Researching",
  done: "Done",
  duplicate: "Already researched",
  failed: "Failed",
  cancelled: "Not run",
};

/** Run one site through the same streaming /api/research endpoint the single-site form uses. */
async function researchOne(site: string, onStage: (msg: string) => void, signal: AbortSignal): Promise<{ companyId: string; duplicate: boolean }> {
  const res = await fetch("/api/research", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ url: site, force: false }),
    signal,
  });
  if (!res.ok || !res.body) {
    const j = await res.json().catch(() => ({}));
    throw Object.assign(new Error(j.error || `Request failed (${res.status})`), { companyId: j.companyId, status: res.status });
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line) continue;
      const ev = JSON.parse(line);
      if (ev.type === "progress") onStage(ev.message);
      else if (ev.type === "result") return { companyId: ev.companyId, duplicate: !!ev.duplicate };
      else if (ev.type === "error") throw Object.assign(new Error(ev.error), { companyId: ev.companyId, status: ev.status });
    }
  }
  throw new Error("The connection closed before the research finished.");
}

export function BulkImport() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [items, setItems] = useState<Item[]>([]);
  const [note, setNote] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const abort = useRef<AbortController | null>(null);
  const stopRequested = useRef(false);

  function load(raw: string) {
    setText(raw);
    const r = extractSites(raw, MAX_SITES);
    setItems(r.sites.map((site) => ({ site, state: "waiting" })));
    const parts: string[] = [];
    if (r.truncated) parts.push(`Only the first ${MAX_SITES} sites are used (${r.truncated} more left out).`);
    if (r.skipped.length) parts.push(`${r.skipped.length} row${r.skipped.length > 1 ? "s" : ""} had no website and ${r.skipped.length > 1 ? "were" : "was"} skipped.`);
    setNote(parts.join(" ") || null);
  }

  async function onFile(file: File | undefined) {
    if (!file) return;
    if (file.size > 1_000_000) return setNote("That file is over 1 MB. Use a CSV with just your list of websites.");
    load(await file.text());
  }

  function update(i: number, patch: Partial<Item>) {
    setItems((list) => list.map((it, j) => (j === i ? { ...it, ...patch } : it)));
  }

  async function start() {
    if (running || !items.length) return;
    setRunning(true);
    stopRequested.current = false;
    let stoppedFor: string | null = null;
    for (let i = 0; i < items.length; i++) {
      if (items[i].state === "done" || items[i].state === "duplicate") continue;
      if (stopRequested.current || stoppedFor) {
        update(i, { state: "cancelled", message: stoppedFor ?? undefined });
        continue;
      }
      update(i, { state: "running", message: "Starting" });
      abort.current = new AbortController();
      try {
        const r = await researchOne(items[i].site, (m) => update(i, { message: m }), abort.current.signal);
        update(i, r.duplicate ? { state: "duplicate", companyId: r.companyId, message: "Researched in the last 24 hours, so it was skipped" } : { state: "done", companyId: r.companyId, message: undefined });
        router.refresh();
      } catch (e) {
        const err = e as Error & { companyId?: string; status?: number };
        if (err.name === "AbortError") {
          update(i, { state: "cancelled", message: "Stopped" });
          continue;
        }
        update(i, { state: "failed", message: err.message, companyId: err.companyId });
        // A run/day limit or a lost session stops the queue; per-site errors don't.
        if (err.status === 429 || /limit reached/i.test(err.message)) stoppedFor = "Stopped: usage limit reached";
        if (err.status === 401 || /sign in/i.test(err.message)) stoppedFor = "Stopped: please sign in again";
      }
    }
    abort.current = null;
    setRunning(false);
    router.refresh();
  }

  function stop() {
    stopRequested.current = true;
    abort.current?.abort();
  }

  const finished = items.filter((i) => ["done", "duplicate", "failed"].includes(i.state)).length;
  return (
    <div className="card p-4 sm:p-5">
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" className="btn-secondary" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
          {open ? "Close import" : "Import CSV"}
        </button>
        <a className="btn-ghost" href="/api/export?type=companies" download>Export companies (CSV)</a>
        <a className="btn-ghost" href="/api/export?type=contacts" download>Export contacts (CSV)</a>
      </div>

      {open && (
        <div className="mt-4 space-y-3">
          <p className="text-sm text-slate-600">
            Upload a CSV with a <span className="font-medium">website</span>, <span className="font-medium">url</span> or <span className="font-medium">domain</span> column, or paste one website per line. Up to {MAX_SITES} sites are researched one after another. Keep this tab open while it runs.
          </p>
          <div className="flex flex-col gap-3 sm:flex-row">
            <label className="btn-secondary cursor-pointer sm:w-48">
              Choose CSV file
              <input type="file" accept=".csv,.txt,text/csv,text/plain" className="sr-only" disabled={running} onChange={(e) => onFile(e.target.files?.[0])} />
            </label>
            <textarea
              className="input min-h-[80px] flex-1 font-mono text-xs"
              placeholder={"plausible.io\nbuttondown.com\nhttps://usefathom.com"}
              value={text}
              onChange={(e) => load(e.target.value)}
              disabled={running}
              aria-label="Websites to import"
              maxLength={200_000}
            />
          </div>
          {note && <p className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800">{note}</p>}
          {items.length > 0 && (
            <>
              <div className="flex flex-wrap items-center gap-2">
                {!running ? (
                  <button type="button" className="btn-primary" onClick={start} disabled={finished === items.length}>
                    {finished ? "Resume" : `Research ${items.length} site${items.length > 1 ? "s" : ""}`}
                  </button>
                ) : (
                  <button type="button" className="btn-danger" onClick={stop}>Stop</button>
                )}
                <span className="text-xs text-slate-500">{finished} of {items.length} finished</span>
              </div>
              <ul className="max-h-80 divide-y divide-slate-100 overflow-y-auto rounded-lg border border-slate-200 text-sm" aria-live="polite">
                {items.map((it, i) => (
                  <li key={`${it.site}-${i}`} className="flex flex-col gap-0.5 px-3 py-2 sm:flex-row sm:items-center sm:gap-3">
                    <span className="min-w-0 truncate font-medium text-slate-800 sm:w-56">{it.site}</span>
                    <span className={`text-xs font-medium ${STATE_STYLE[it.state]}`}>{STATE_LABEL[it.state]}</span>
                    {it.message && <span className="min-w-0 truncate text-xs text-slate-500">{it.message}</span>}
                    {it.companyId && (it.state === "done" || it.state === "duplicate") && (
                      <Link href={`/companies/${it.companyId}`} className="text-xs text-indigo-600 hover:underline sm:ml-auto">Open</Link>
                    )}
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      )}
    </div>
  );
}
