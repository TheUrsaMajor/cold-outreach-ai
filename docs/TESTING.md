# Testing

There are three layers of tests:

1. **Unit tests** (`npm test`, Vitest, 108 tests). They need no network and no keys.
2. **Live pipeline tests** against real websites, run on the deployed app through the token-protected `/api/selftest` route.
3. **Browser end-to-end test** of the deployed UI with Playwright (login → research → edit → open in Gmail → usage, plus a mobile check).

## 1. Unit tests

| File | What it covers |
| --- | --- |
| `tests/url.test.ts` | URL normalisation, the hostname shape check, private, loopback, link-local, CGNAT and IPv6 ranges (SSRF), same-site checks, link canonicalisation, and stripping tracking parameters for dedupe |
| `tests/robots.test.ts` | robots.txt parsing, user-agent groups, and longest-match allow/disallow |
| `tests/extract.test.ts` | Page extraction from a fixture: title, headings, text, emails (mailto, plain, Cloudflare-encoded, `[at]`/`[dot]` obfuscation), JSON-LD founders, founder phrases in text and DOM, socials, phones, contact forms, and placeholder emails being ignored |
| `tests/discover.test.ts` | The contact fallback order (founder email, then company email, then other contact method), matching emails to founders by name, ranking generic inboxes, dropping third-party domains, filtering testimonial people, and the MX-check hook |
| `tests/csv.test.ts` | CSV escaping, formula-injection guard, a round trip through the parser, and pulling websites from a CSV: header column, plain list, emails turned into domains, dedupe, Excel semicolon files with a BOM, and the 50-site cap |
| `tests/generate.test.ts` | The model fallback chain with mocked providers: primary success, rate-limit/overload fallback, invalid JSON, every model failing (falls back to the deterministic template), a bad key skipping that provider's other models, a per-model Gemini quota not skipping the rest of Gemini, and the OpenRouter daily cap skipping the other free models. Also output verification (citations stripped from the email, the CTA guaranteed, the MRR band never leaking) and the deliverability scorer |

```bash
npm test          # all unit tests
npx tsc --noEmit  # type check
npm run lint
```

## 2. Live tests on real websites

These were run on the production deployment (`/api/selftest`, mode `full`, which runs the same `runResearch` pipeline as the UI as a dedicated test user, writing to the database).

| Site | Result |
| --- | --- |
| plausible.io | 30 pages read in about 2s. Founders found from the about page with evidence quotes. Company email chosen. Opener cites a real product detail |
| buttondown.com | 30 pages. Founder found. Opener produced |
| savvycal.com | 30 pages. Vendor Calendly links on help/pricing pages are no longer treated as the company's booking link |
| usefathom.com | 30 pages, 0 failed. 4 founders found. Best contact was a general inbox (no founder email is published). Gemini Flash hit its daily free quota, Groq gpt-oss-120b wrote the email, 5.3s end to end |
| tuple.app (via the UI) | 9.3s from submit to the finished draft page |
| baremetrics.com (via the UI, Groq first) | 9.2s. Founder email found (CEO, matched by name on the about page, mail server verified) and used as the recipient |
| simpleanalytics.com (via the UI) | 17.1s. No email on the site, so the composer asks for a recipient and points to the other contact methods. This run caught gpt-oss writing a 【S1】 source tag, which is now stripped (unit test added) |

### Failure cases

| Case | Expected behaviour | Result |
| --- | --- | --- |
| Domain that doesn't exist | Friendly 422 "could not be found" error, run marked failed | Pass (0.5s) |
| Expired or broken TLS | Falls back to http, then the reader. Guessed paths are skipped on a broken server so the budget isn't wasted | Pass |
| JS-only site or 403 to bots | Reader fallback (r.jina.ai) | Pass |
| Page that returns only a few words | Run fails with "not enough readable text" (minimum 25 words) instead of a made-up email | Pass |
| SSRF (`localtest.me`, `127.0.0.1`, private IPs, redirects to private IPs) | Blocked at DNS-lookup/connect time and again on every redirect hop | Pass |
| Incomplete info (no founder named) | No founder invented. Falls back to a company email or another contact method | Pass |
| Wrong or third-party emails on the page (vendor, testimonial, `notifications@`) | Dropped or ranked below real inboxes. Domains without MX/A records are marked invalid | Pass |
| Testimonial people ("Jane Doe, CEO at OtherCo") | Not listed as the prospect's founders | Pass |
| Primary AI overloaded (503) or out of quota (429) | Next model in the chain is used | Pass |
| All AI models fail | Deterministic, fact-only template, so there is always a result | Pass (forced with a bad chain) |
| AI provider hangs mid-response | The whole body read has a deadline, so the run continues to the next model. Stale "running" runs older than 5 minutes are cleaned up | Pass (fixed after a live hang) |
| AI output leaks citations "(S1)", the MRR band, links or markdown | Removed by `verifyOutput` | Pass |
| Duplicate submission (same site, different case/www/path) | Detected within 24h, and the UI offers "Research again" | Pass |
| Double-click / concurrent runs for one company | Blocked by the button guard and a unique partial index (409) | Pass |
| Another user's data | RLS returns 0 rows. Anonymous access is denied | Pass |

## 3. Browser end-to-end test

Run with Playwright (Chromium) against the production URL:

- Login with the demo account redirects to the dashboard.
- Submitting `tuple.app` streams progress and lands on the company page in 9.3s.
- The draft has a subject, a 45–90 word opener ending with a one-line question, and the sender's first name.
- Editing the subject and pressing **Open in Gmail** opens a Gmail compose URL with the edited subject and the found address in `to`.
- The usage page shows tokens, success rate, latency, estimated spend and free-tier headroom. The guide and settings pages return 200.
- On an iPhone 13 viewport there is no horizontal overflow.
- **CSV import** of a list with a site researched earlier today, a junk row, a domain that doesn't exist and a new site: the junk row is reported as skipped, the first site shows "Already researched" with a link, the bad domain shows "could not be found", and the new site completes. The queue keeps going after a per-site failure.
- **CSV export**: both files download as `text/csv` with a dated filename. The companies file has one row per company, and the contacts file lists the founder email first with its tier, confidence and source page. Without a login the export returns 401.
- No page errors or console errors throughout.

## Running the live checks yourself

Set `SELFTEST_TOKEN` (and `SELFTEST_EMAIL`/`SELFTEST_PASSWORD` for `mode=full`) in the Vercel env, then:

```bash
H="x-selftest-token: $SELFTEST_TOKEN"
APP=https://<your-app>.vercel.app
curl -H "$H" "$APP/api/selftest?mode=models"                            # ping every model in the chain
curl -H "$H" "$APP/api/selftest?mode=dry&url=plausible.io&ai=0"          # crawl and contacts only
curl -H "$H" "$APP/api/selftest?mode=full&url=plausible.io&force=1"      # full pipeline, writes to the DB
```

Without the token the route returns 404. Remove `SELFTEST_TOKEN` to turn it off completely.
