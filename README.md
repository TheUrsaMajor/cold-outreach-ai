# Steward Outreach

A web app that researches a prospect's public website, finds the best founder contact, and writes a short, personalised, inbox-friendly cold email opener for **Steward**, a (fictional) AI management team for software companies doing about $10K to $50K MRR.

**Live:** https://cold-outreach-ai-vision-hack.vercel.app

## What it does

1. **Paste a website** (e.g. `acme.com`).
2. **Crawler** reads up to 30 pages politely. It checks robots.txt and the sitemap, prioritises the about, team, contact, pricing and product pages, blocks private networks (SSRF), and enforces timeouts and size caps. JavaScript-only sites fall back to a rendering reader.
3. **Contact finder** follows a strict fallback order:
   1. **Founder's email**: an address whose mailbox matches a founder named on the site (e.g. `priya@` for Priya Raman), or `founder@`/`ceo@`.
   2. **Any email published on the site**: ranked `hello@` / `team@` / `contact@` first, with `privacy@` and `careers@` last.
   3. **Any other contact method**: contact form, founder LinkedIn, booking link, company LinkedIn, X, phone, GitHub and others.

   Every contact shows its **source page**. Addresses are **never guessed**, and each email domain is **MX-verified**, so undeliverable addresses are crossed out.
4. **AI** builds a sourced business profile and writes a 45 to 90 word hook-style opener plus 3 subject lines. The output is validated: facts must cite a crawled page, founders must appear in the page text, and links and fake "Re:" prefixes are stripped.
5. **Editable email** with To, Subject and Body, a live deliverability score, and one-click **Open in Gmail / Outlook / your mail app**. You can mark it sent, replied or bounced.
6. **Everything is stored** in Postgres: companies, research runs, pages read, founders, contacts, drafts (all versions), the communication timeline, AI usage and the audit log.
7. **CSV import and export**: upload a CSV (a `website`/`url`/`domain` column, or one site per line) and up to 50 sites are researched one after another, with live status for each. Sites researched in the last 24 hours are skipped, and the queue stops cleanly at the usage limit. **Export companies** gives one row per company (founders, best contact, every email, the latest opener and its status). **Export contacts** gives one row per contact with its tier, confidence and source page. Exported cells that start like a spreadsheet formula are neutralised.

## AI model choice (and fallbacks)

| Order | Model | Why |
|---|---|---|
| 1 | Groq **gpt-oss-120b** | Very fast (about 1–3 s), strong reasoning, and a 1,000 requests/day free tier, so most runs succeed on the first try |
| 2 | **Gemini 3.5 Flash** (Google AI Studio) | Different vendor (independent outage), strong writing, 1M-token context, JSON mode. Its free daily quota is small, so it works best as the first backup |
| 3 | Groq **Qwen 3.8 27B** | Separate quota from #2, strong instruction following |
| 4 | Gemini 3.5 **Flash Lite** | Cheap and fast, separate quota from #1 |
| 5, 6 | OpenRouter free **Nemotron 3 Ultra**, then **Gemma 4 31B** | A third vendor |
| 6 | Deterministic template | Built only from the site's own description, so **a draft is always produced** |

The model layer is provider-agnostic (`src/lib/ai/providers.ts`). Change the order or models with one env var, e.g. `LLM_CHAIN="gemini:gemini-3.5-flash,groq:openai/gpt-oss-120b"` to put Gemini first. Each provider gets a context budget that fits its token limits. Invalid JSON, timeouts, 429s and 5xx errors move to the next model, A bad key skips that provider's other models. A daily quota only skips that one model, except on OpenRouter, where the free cap is shared.

## Marketing and deliverability built in

* **Copy strategy** (in `src/lib/ai/prompt.ts`): one verifiable personal observation, a relevance bridge to a stage-specific pain, one-line value, an interest-based soft CTA, peer-to-peer founder tone, no fabricated social proof, and a fit assessment.
* **Spam safety** (`src/lib/ai/deliverability.ts`): checks for about 90 trigger phrases, caps, exclamation marks, links, shorteners, HTML, emoji in subjects, length, and deceptive `Re:`/`Fwd:`. It runs live while you edit.
* **In-app guide** (`/guide`): separate sending domain, SPF/DKIM/DMARC records with examples, BIMI/MTA-STS, warm-up schedule, volume limits, list hygiene, and CAN-SPAM/GDPR/CASL notes.

## Security

* Supabase Auth (email + password). Middleware protects every page and API route. Optional `ALLOWED_SIGNUPS` allowlist.
* **Row Level Security** on every table (`owner_id = auth.uid()`), so users only ever see their own data. Usage and audit logs are append-only.
* API: zod validation on every input, same-origin (CSRF) checks, per-user hourly and daily run limits, UUID checks, and generic error messages.
* **Crawler:** blocks private, loopback, link-local and metadata IPs. Checks DNS at validation time **and at connect time** (defeats DNS rebinding) and re-validates every redirect hop. Only http(s) on ports 80/443, no credentials in URLs, size and time caps. Page text is treated as untrusted in the prompt (prompt-injection guard).
* Secrets live only in Vercel env vars (sensitive type). Nothing secret is in the repo, and only the Supabase publishable key is exposed to the browser.
* Security headers: CSP, HSTS, X-Frame-Options DENY, nosniff, Referrer-Policy, Permissions-Policy.
* Audit log of every research, edit, send, status change, delete and settings change, with IP and user agent.

## Project structure

```
src/lib/crawler/     url.ts (validation + SSRF), fetcher.ts (safe fetch), robots.ts, extract.ts, crawl.ts
src/lib/contacts/    discover.ts (founder → email → other fallback, MX checks)
src/lib/ai/          providers.ts, generate.ts (chain + validation + template), prompt.ts, deliverability.ts, pricing.ts
src/lib/server/      pipeline.ts (end-to-end run + persistence), common.ts (auth ctx, limits, audit)
src/app/             dashboard, company page, usage, guide, settings, API routes
supabase/migrations/ schema + RLS
tests/               vitest unit tests (86)
docs/SCALING.md      1,000 runs a day analysis
docs/TESTING.md      real-site and failure-case test results
```

## Running locally

```bash
npm install
cp .env.example .env.local   # fill in values
npm run dev
npm test
```

### Environment variables

| Name | Required | Notes |
|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY` | yes | Supabase project URL and publishable key |
| `GEMINI_API_KEY` | yes* | https://aistudio.google.com/apikey |
| `GROQ_API_KEY` | recommended | https://console.groq.com/keys |
| `OPENROUTER_API_KEY` | optional | https://openrouter.ai/keys |
| `LLM_CHAIN` | optional | Override model order |
| `GEMINI_THINKING_LEVEL` | optional | `minimal` (default) / `low` / `high` |
| `HOURLY_RUN_LIMIT`, `DAILY_RUN_LIMIT` | optional | Defaults 60 / 300 per user |
| `DEDUPE_HOURS` | optional | Default 24 |
| `CRAWL_MAX_PAGES` | optional | Default 30, max 60 |
| `ALLOWED_SIGNUPS` | optional | e.g. `me@x.com,@mycompany.com` |
| `PRODUCT_NAME`, `PRODUCT_PITCH`, `DEFAULT_SENDER_NAME` | optional | Defaults for new users (each user can edit in Settings) |
| `SELFTEST_TOKEN` (+ `SELFTEST_EMAIL`/`PASSWORD`) | optional | Enables `/api/selftest` for operators. Leave unset to disable |

\* At least one LLM key is needed. Without any, the template fallback still produces drafts.

### Database

Apply `supabase/migrations/*.sql` in order (Supabase SQL editor or `supabase db push`).

## Deployment (Vercel)

The repo is connected to the Vercel project `cold-outreach-ai`, and every push to `main` deploys to production. Functions run in `iad1`, next to the Supabase database in `us-east-1`. The research route uses `maxDuration = 120`.
