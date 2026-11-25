"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useRef, useState } from "react";

type Step = { stage: string; message: string; ok?: boolean };
const STAGES = [
  { key: "crawling", label: "Read the website" },
  { key: "contacts", label: "Find founders and contacts" },
  { key: "writing", label: "Write the opener" },
  { key: "saving", label: "Save to your database" },
];

export function ResearchForm() {
  const router = useRouter();
  const [url, setUrl] = useState("");
  const [tone, setTone] = useState("friendly");
  const [extra, setExtra] = useState("");
  const [showMore, setShowMore] = useState(false);
  const [busy, setBusy] = useState(false);
  const [steps, setSteps] = useState<Step[]>([]);
  const [stage, setStage] = useState<string | null>(null);
  const [error, setError] = useState<{ message: string; companyId?: string } | null>(null);
  const [duplicate, setDuplicate] = useState<string | null>(null);
  const inFlight = useRef(false);

  async function run(force = false) {
    if (inFlight.current) return; // guards against double submits
    setError(null);
    setDuplicate(null);
    const value = url.trim();
    if (!value) return setError({ message: "Enter a website address, like acme.com." });
    inFlight.current = true;
    setBusy(true);
    setSteps([]);
    setStage("validating");
    try {
      const res = await fetch("/api/research", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url: value, force, tone, extraInstructions: extra.trim() || undefined }),
      });
      if (!res.ok || !res.body) {
        const j = await res.json().catch(() => ({}));
        throw Object.assign(new Error(j.error || `Request failed (${res.status})`), { companyId: j.companyId });
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      let finished = false;
      while (true) {
        const { done, value: chunk } = await reader.read();
        if (done) break;
        buf += decoder.decode(chunk, { stream: true });
        let idx;
        while ((idx = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, idx).trim();
          buf = buf.slice(idx + 1);
          if (!line) continue;
          const ev = JSON.parse(line);
          if (ev.type === "progress") {
            setStage(ev.stage);
            setSteps((s) => [...s, { stage: ev.stage, message: ev.message, ok: ev.detail?.success }]);
          } else if (ev.type === "result") {
            finished = true;
            if (ev.duplicate) {
              setDuplicate(ev.companyId);
            } else {
              setStage("done");
              router.push(`/companies/${ev.companyId}`);
              router.refresh();
            }
          } else if (ev.type === "error") {
            finished = true;
            throw Object.assign(new Error(ev.error), { companyId: ev.companyId });
          }
        }
      }
      if (!finished) throw new Error("The connection closed before the research finished. Check the prospect list; the run may still have been saved.");
    } catch (e) {
      setError({ message: (e as Error).message, companyId: (e as { companyId?: string }).companyId });
      setStage(null);
      router.refresh();
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  const activeIndex = STAGES.findIndex((s) => s.key === stage);
  return (
    <div className="card p-4 sm:p-5">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          run(false);
        }}
        className="flex flex-col gap-3 sm:flex-row"
      >
        <label htmlFor="url" className="sr-only">Prospect website</label>
        <input id="url" className="input flex-1 text-base sm:text-sm" placeholder="Prospect website, e.g. acme.com" value={url} onChange={(e) => setUrl(e.target.value)} disabled={busy} autoComplete="off" inputMode="url" maxLength={2048} />
        <button className="btn-primary sm:w-48" disabled={busy}>
          {busy ? "Researching…" : "Research & write email"}
        </button>
      </form>
      <button type="button" onClick={() => setShowMore((v) => !v)} className="mt-2 text-xs text-slate-500 hover:text-slate-700">
        {showMore ? "Hide options" : "Options: tone and extra instructions"}
      </button>
      {showMore && (
        <div className="mt-3 grid gap-3 sm:grid-cols-[180px_1fr]">
          <div>
            <label className="label" htmlFor="tone">Tone</label>
            <select id="tone" className="input" value={tone} onChange={(e) => setTone(e.target.value)} disabled={busy}>
              <option value="friendly">Friendly</option>
              <option value="direct">Direct</option>
              <option value="formal">Formal</option>
              <option value="playful">Playful</option>
            </select>
          </div>
          <div>
            <label className="label" htmlFor="extra">Extra instructions (optional)</label>
            <input id="extra" className="input" value={extra} onChange={(e) => setExtra(e.target.value)} maxLength={500} placeholder="e.g. mention we're also bootstrapped" disabled={busy} />
          </div>
        </div>
      )}
      {(busy || stage === "done") && (
        <ol className="mt-4 grid gap-2 sm:grid-cols-4" aria-live="polite">
          {STAGES.map((s, i) => {
            const done = stage === "done" || i < activeIndex;
            const active = i === activeIndex && stage !== "done";
            const last = [...steps].reverse().find((x) => x.stage === s.key);
            return (
              <li key={s.key} className={`rounded-lg border px-3 py-2 text-xs ${done ? "border-emerald-200 bg-emerald-50 text-emerald-800" : active ? "border-indigo-200 bg-indigo-50 text-indigo-800" : "border-slate-200 text-slate-400"}`}>
                <div className="flex items-center gap-1.5 font-medium">
                  {active ? <span className="h-2 w-2 animate-pulse rounded-full bg-indigo-500" /> : done ? "✓" : "○"} {s.label}
                </div>
                {last && <div className="mt-0.5 truncate opacity-80" title={last.message}>{last.message}</div>}
              </li>
            );
          })}
        </ol>
      )}
      {busy && <p className="mt-2 text-xs text-slate-400">This usually takes 20 to 60 seconds.</p>}
      {duplicate && (
        <div className="mt-4 flex flex-wrap items-center gap-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
          <span>You researched this company recently.</span>
          <Link className="btn-secondary py-1" href={`/companies/${duplicate}`}>Open saved research</Link>
          <button className="btn-ghost py-1" onClick={() => run(true)} disabled={busy}>Research again</button>
        </div>
      )}
      {error && (
        <div className="mt-4 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800" role="alert">
          {error.message}
          {error.companyId && (
            <Link className="ml-2 underline" href={`/companies/${error.companyId}`}>
              View details
            </Link>
          )}
        </div>
      )}
    </div>
  );
}
