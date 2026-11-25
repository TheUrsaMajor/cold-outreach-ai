import type { Metadata } from "next";
import { requireUser } from "@/lib/supabase/server";
import { Stat, timeAgo } from "@/components/ui";
import { configuredChain } from "@/lib/ai/providers";
import { FREE_TIER_LIMITS } from "@/lib/ai/pricing";

export const metadata: Metadata = { title: "AI usage" };

type Row = { provider: string; model: string; success: boolean; error: string | null; prompt_tokens: number; completion_tokens: number; total_tokens: number; latency_ms: number; cost_usd: number; created_at: string; attempt: number };

function pct(arr: number[], p: number) {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
}

export default async function UsagePage() {
  const { supabase } = await requireUser();
  const since = new Date(Date.now() - 30 * 86_400_000).toISOString();
  const { data } = await supabase.from("ai_usage_logs").select("provider,model,success,error,prompt_tokens,completion_tokens,total_tokens,latency_ms,cost_usd,created_at,attempt").gte("created_at", since).order("created_at", { ascending: false }).limit(5000);
  const rows = (data ?? []) as Row[];
  const dayAgo = Date.now() - 86_400_000;
  const today = rows.filter((r) => new Date(r.created_at).getTime() >= dayAgo);
  const llm = rows.filter((r) => r.provider !== "template");
  const sum = (rs: Row[], k: keyof Row) => rs.reduce((n, r) => n + Number(r[k] ?? 0), 0);
  const generations = rows.filter((r) => r.success).length;
  const templateCount = rows.filter((r) => r.provider === "template").length;
  const successRate = llm.length ? Math.round((llm.filter((r) => r.success).length / llm.length) * 100) : 100;

  const byModel = new Map<string, Row[]>();
  for (const r of rows) byModel.set(`${r.provider}:${r.model}`, [...(byModel.get(`${r.provider}:${r.model}`) ?? []), r]);
  const chain = configuredChain();

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-slate-900">AI usage</h1>
        <p className="mt-1 text-sm text-slate-500">Real token counts reported by each provider, latency, estimated spend and free-tier headroom. Last 30 days, your account only.</p>
      </div>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-6">
        <Stat label="Tokens (24h)" value={sum(today, "total_tokens").toLocaleString()} />
        <Stat label="Tokens (30d)" value={sum(rows, "total_tokens").toLocaleString()} />
        <Stat label="Emails generated (30d)" value={generations} hint={templateCount ? `${templateCount} via template fallback` : undefined} />
        <Stat label="Model success rate" value={`${successRate}%`} hint={`${llm.length - llm.filter((r) => r.success).length} failed calls fell back`} />
        <Stat label="Median latency" value={`${(pct(llm.filter((r) => r.success).map((r) => r.latency_ms), 50) / 1000).toFixed(1)}s`} hint={`p95 ${(pct(llm.filter((r) => r.success).map((r) => r.latency_ms), 95) / 1000).toFixed(1)}s`} />
        <Stat label="Est. spend (30d)" value={`$${sum(rows, "cost_usd").toFixed(4)}`} hint="At paid list prices; $0 on free tiers" />
      </div>

      <section className="card overflow-hidden">
        <div className="border-b border-slate-200 p-4">
          <h2 className="font-semibold text-slate-900">Models</h2>
          <p className="text-xs text-slate-500">Fallback order: {chain.map((c) => c.model).join(" → ")} → template</p>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="bg-slate-50 text-xs text-slate-500">
              <tr>
                {["Model", "Calls", "Success", "Prompt tokens", "Output tokens", "Avg latency", "Est. cost", "Today vs free limit"].map((h) => <th key={h} className="whitespace-nowrap px-4 py-2 font-medium">{h}</th>)}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {[...byModel.entries()].map(([k, rs]) => {
                const model = k.split(":").slice(1).join(":");
                const lim = FREE_TIER_LIMITS[model];
                const used = rs.filter((r) => new Date(r.created_at).getTime() >= dayAgo).length;
                const ok = rs.filter((r) => r.success);
                return (
                  <tr key={k}>
                    <td className="px-4 py-2"><div className="font-medium text-slate-800">{model}</div><div className="text-xs text-slate-400">{k.split(":")[0]}</div></td>
                    <td className="px-4 py-2 tabular-nums">{rs.length}</td>
                    <td className="px-4 py-2 tabular-nums">{Math.round((ok.length / rs.length) * 100)}%</td>
                    <td className="px-4 py-2 tabular-nums">{sum(rs, "prompt_tokens").toLocaleString()}</td>
                    <td className="px-4 py-2 tabular-nums">{sum(rs, "completion_tokens").toLocaleString()}</td>
                    <td className="px-4 py-2 tabular-nums">{ok.length ? (sum(ok, "latency_ms") / ok.length / 1000).toFixed(1) : "—"}s</td>
                    <td className="px-4 py-2 tabular-nums">${sum(rs, "cost_usd").toFixed(4)}</td>
                    <td className="min-w-[160px] px-4 py-2">
                      {lim?.rpd ? (
                        <div title={lim.note}>
                          <div className="h-1.5 rounded bg-slate-100"><div className={`h-1.5 rounded ${used / lim.rpd > 0.8 ? "bg-red-500" : "bg-indigo-500"}`} style={{ width: `${Math.min(100, (used / lim.rpd) * 100)}%` }} /></div>
                          <div className="mt-0.5 text-xs text-slate-500">{used} / {lim.rpd} requests per day</div>
                        </div>
                      ) : <span className="text-xs text-slate-400">{model === "template" ? "no limit" : "—"}</span>}
                    </td>
                  </tr>
                );
              })}
              {!byModel.size && <tr><td colSpan={8} className="px-4 py-6 text-center text-slate-500">No AI calls yet.</td></tr>}
            </tbody>
          </table>
        </div>
      </section>

      <section className="card overflow-hidden">
        <h2 className="border-b border-slate-200 p-4 font-semibold text-slate-900">Recent calls</h2>
        <div className="max-h-[480px] overflow-auto">
          <table className="w-full text-left text-xs">
            <thead className="sticky top-0 bg-slate-50 text-slate-500">
              <tr>{["When", "Model", "Result", "Tokens (in / out)", "Latency", "Cost"].map((h) => <th key={h} className="px-4 py-2 font-medium">{h}</th>)}</tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {rows.slice(0, 200).map((r, i) => (
                <tr key={i}>
                  <td className="whitespace-nowrap px-4 py-1.5 text-slate-500">{timeAgo(r.created_at)}</td>
                  <td className="px-4 py-1.5">{r.model}</td>
                  <td className="max-w-[360px] px-4 py-1.5">{r.success ? <span className="text-emerald-700">ok</span> : <span className="text-red-700" title={r.error ?? ""}>{(r.error ?? "failed").slice(0, 90)}</span>}</td>
                  <td className="px-4 py-1.5 tabular-nums">{r.prompt_tokens.toLocaleString()} / {r.completion_tokens.toLocaleString()}</td>
                  <td className="px-4 py-1.5 tabular-nums">{(r.latency_ms / 1000).toFixed(1)}s</td>
                  <td className="px-4 py-1.5 tabular-nums">${Number(r.cost_usd).toFixed(5)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
