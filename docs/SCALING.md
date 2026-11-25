# Scaling to 1,000 runs a day

A "run" = crawl one website (up to 30 pages) + find contacts + one successful LLM call + about 15 database writes.

## Load profile

| Metric | Per run | Per day (1,000 runs) |
|---|---|---|
| Wall time | 20 to 60 s (crawl ≤ 26 s, AI 4 to 25 s) | about 11 hours of function time if run back to back |
| Outbound HTTP (crawl) | about 30 to 40 requests | about 35,000 requests to about 1,000 different sites |
| LLM tokens | about 12k in, 0.8k out (Gemini) | about 12M in, 0.8M out |
| DB rows | about 60 (pages, contacts, logs) | about 60k rows, about 40 MB |
| Average rate | | 0.7 runs a minute (peaks of maybe 10 a minute in a working day) |

1,000 runs a day is a modest load. The binding constraints are **LLM free-tier quotas** and **Vercel/Supabase free-plan limits**, not compute.

## LLM limits and cost

| Model (in fallback order) | Free tier (approx.) | Paid price / 1M tokens | Cost of 1,000 runs at paid rates |
|---|---|---|---|
| Gemini 3.5 Flash | about 10 RPM / 250 RPD | $0.50 in / $3.00 out | about $8.40 a day |
| Groq gpt-oss-120b | 30 RPM / 1,000 RPD / 8k TPM | $0.15 / $0.60 | about $2.30 a day |
| Groq Llama 3.3 70B | 30 RPM / 1,000 RPD / 12k TPM | $0.59 / $0.79 | about $7.70 a day |
| Gemini 3.5 Flash Lite | about 15 RPM / 1,000 RPD | $0.10 / $0.40 | about $1.50 a day |
| OpenRouter free Llama 3.3 | 20 RPM / 50 RPD (1,000 with $10 credit) | $0 | $0 |

* **On free tiers alone**, the combined daily quota (250 + 1,000 + 1,000 + 1,000 + 50) is about 3,300 calls, so 1,000 runs a day fits, with Gemini handling the first about 250 and Groq taking the overflow automatically. Groq's TPM limit (8 to 12k tokens a minute) caps it at about 1 run a minute per model. The chain already trims context for Groq (18k chars ≈ 4.5k tokens) to stay under it.
* **Recommended for production:** enable billing on the Gemini key (Tier 1: 1,000+ RPM). Then 1,000 runs cost about **$8 a day (about $250 a month)** on Flash, or about **$1.50 a day** if `LLM_CHAIN` puts Flash Lite first. Usage and estimated spend are tracked live on the *AI usage* page.
* **Swap models without code changes:** `LLM_CHAIN="gemini:gemini-3.5-flash-lite,groq:openai/gpt-oss-120b,..."`.

## Infrastructure

| Component | Free plan | What 1,000 runs a day needs | Action |
|---|---|---|---|
| Vercel Functions (Hobby) | Fluid compute, 300 s max duration, about 4 CPU-hours / 360 GB-hours a month | Functions mostly *wait* on network I/O. Fluid compute bills active CPU, about 2 to 4 s of CPU per run ≈ 1 CPU-hour a day | **Upgrade to Pro ($20 a month)**. Hobby is for non-commercial use and its CPU allowance would run out within the first week at this volume |
| Vercel concurrency | Auto-scales | about 10 concurrent at peak | fine |
| Supabase (Free) | 500 MB DB, 50k MAU, pauses after 7 idle days | about 40 MB a day of growth. Free fills in about 2 weeks unless pruned | **Pro ($25 a month, 8 GB)**, plus a nightly job deleting `crawled_pages` and `ai_usage_logs` older than 90 days (sources are already kept only for the latest run per company) |
| Supabase connections | Supavisor pooler | REST via PostgREST, no direct connections | fine |

## Concurrency and backpressure design

Today each run happens inside one streaming request (the UI shows live progress). That's right for interactive use up to a few concurrent users. For batch use (paste 1,000 URLs), move to a queue:

1. `POST /api/batch` inserts rows into a `jobs` table (`status = queued`).
2. A Vercel Cron (every minute) or **Vercel Queues / Upstash QStash** pulls N jobs and fans out to `/api/worker` with `FOR UPDATE SKIP LOCKED`, so no job runs twice.
3. Workers apply **per-provider token buckets** (stored in Postgres or Upstash Redis), so the app never exceeds RPM/TPM. When a bucket is empty the job waits instead of failing over.
4. **Per-domain politeness:** at most 6 parallel requests per site (already enforced), and batch jobs for the same domain are serialised.
5. Retries with exponential backoff (max 3). Dead-letter after that, visible in the UI.

## Already in place

* Bounded crawl: 30 pages, 26 s budget, 9 s per page, 1.5 MB per page, 6 concurrent fetches. One slow site can't take down a function.
* Model chain with per-model timeouts and automatic failover, plus a deterministic template as a last resort.
* Duplicate suppression: the same domain within 24 h returns the saved result, and a unique partial index blocks two concurrent runs for one company.
* Per-user rate limits (`HOURLY_RUN_LIMIT`, `DAILY_RUN_LIMIT`) counted in the DB so they hold across instances.
* Storage hygiene: full page text is never stored (only a 600-character excerpt), and model sources are kept only on the latest run.
* Indexes on every foreign key and on the dashboard query paths.

## Monthly cost summary at 1,000 runs a day

| Setup | Monthly |
|---|---|
| All free tiers (demo / assignment) | $0, but Gemini caps at about 250 runs a day and Groq picks up the rest |
| Recommended production (Vercel Pro + Supabase Pro + paid Gemini Flash) | about $20 + $25 + $250 ≈ **$295** |
| Cost-optimised (Flash Lite primary) | about $20 + $25 + $45 ≈ **$90** |
