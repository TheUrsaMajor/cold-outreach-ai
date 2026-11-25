import { safeFetch, FetchError } from "./fetcher";
import { fetchRobots, isAllowed, type Robots } from "./robots";
import { extractPage, type PageExtract } from "./extract";
import { assertPublicHost, canonicalizeLink, isSameSite, normalizeInputUrl, siteKey, urlKey, UrlValidationError } from "./url";

export type CrawledPage = {
  url: string;
  status: number;
  extract?: PageExtract;
  error?: string;
  errorKind?: string;
  priority: number;
  via: "home" | "link" | "sitemap" | "guess" | "reader";
};

export type CrawlResult = {
  inputUrl: string;
  finalUrl: string;
  domain: string;
  pages: CrawledPage[];
  pagesFound: number;
  robotsBlocked: string[];
  errors: string[];
  durationMs: number;
  robotsFetched: boolean;
  usedReaderFallback: boolean;
};

export type CrawlOptions = {
  maxPages?: number;
  concurrency?: number;
  budgetMs?: number;
  pageTimeoutMs?: number;
  /** Use a JS-rendering reader service for JS-only sites (public URLs only). */
  allowReaderFallback?: boolean;
};

const PRIORITY_RULES: [RegExp, number][] = [
  [/(^|\/)(about|about-us|our-story|story|company|who-we-are|mission)(\/|$)/i, 100],
  [/(^|\/)(team|our-team|people|leadership|founders?|management|meet-the-team|staff)(\/|$)/i, 98],
  [/(^|\/)(contact|contact-us|get-in-touch|support|help|reach-us)(\/|$)/i, 96],
  [/(^|\/)(pricing|plans|price)(\/|$)/i, 85],
  [/(^|\/)(product|products|features|platform|solutions?|how-it-works|services?|use-cases?)(\/|$)/i, 80],
  [/(^|\/)(customers?|case-studies|testimonials|clients|stories)(\/|$)/i, 72],
  [/(^|\/)(careers|jobs|hiring|join-us)(\/|$)/i, 65],
  [/(^|\/)(press|media|news|newsroom|announcements?)(\/|$)/i, 60],
  [/(^|\/)(investors?|partners?|integrations?)(\/|$)/i, 55],
  [/(^|\/)(blog|articles|posts|changelog|updates)\/?$/i, 50],
  [/(^|\/)(imprint|impressum|legal-notice)(\/|$)/i, 58], // EU sites list owner + email here
  [/(^|\/)(privacy|terms|legal|cookie|gdpr|security|dpa)(\/|$)/i, 35],
  [/(^|\/)(blog|articles|posts|docs|documentation|help-center|kb|knowledge-base|changelog|tag|tags|category|categories|author|page)\//i, 15],
];
const GUESS_PATHS = ["/about", "/about-us", "/team", "/contact", "/contact-us", "/company", "/pricing", "/imprint"];

export function scorePath(u: URL): number {
  const path = u.pathname.toLowerCase();
  if (path === "/" || path === "") return 1000;
  let score = 40;
  for (const [re, s] of PRIORITY_RULES) {
    if (re.test(path)) {
      score = s;
      break;
    }
  }
  const depth = path.split("/").filter(Boolean).length;
  score -= Math.max(0, depth - 1) * 8;
  if (/^\/(?:[a-z]{2}(?:-[a-z]{2})?)\//i.test(path) && !/^\/(en|us)(-|\/)/i.test(path)) score -= 30; // other locales
  if (u.search) score -= 10;
  return score;
}

async function fetchSitemapUrls(origin: string, robots: Robots, siteHost: string, deadline: number): Promise<URL[]> {
  const seeds = robots.sitemaps.length ? robots.sitemaps.slice(0, 3) : [`${origin}/sitemap.xml`, `${origin}/sitemap_index.xml`];
  const found = new Map<string, URL>();
  const queue = [...seeds];
  let fetched = 0;
  while (queue.length && fetched < 6 && Date.now() < deadline - 2000) {
    const sm = queue.shift()!;
    fetched++;
    try {
      const res = await safeFetch(sm, { timeoutMs: 5000, maxBytes: 3_000_000, accept: "application/xml,text/xml,*/*" });
      if (res.status >= 400) continue;
      const locs = [...res.text.matchAll(/<loc>\s*(?:<!\[CDATA\[)?\s*([^<\]\s]+)\s*(?:\]\]>)?\s*<\/loc>/gi)].map((m) => m[1].replace(/&amp;/g, "&"));
      const isIndex = /<sitemapindex/i.test(res.text);
      for (const loc of locs) {
        if (isIndex) {
          // Prefer page/company sitemaps over blog/product catalogues.
          if (queue.length < 4) {
            if (/page|main|site|company|static|general/i.test(loc)) queue.unshift(loc);
            else if (!/post|blog|product|tag|categor|author|image|video/i.test(loc)) queue.push(loc);
          }
          continue;
        }
        let u: URL;
        try {
          u = new URL(loc);
        } catch {
          continue;
        }
        const c = canonicalizeLink(u.href, u, siteHost);
        if (c && isSameSite(c.hostname, siteHost)) found.set(urlKey(c), c);
        if (found.size >= 1000) break;
      }
    } catch {
      /* sitemap is optional */
    }
  }
  return [...found.values()];
}

async function readerFetch(url: string, timeoutMs: number): Promise<{ text: string; title: string } | null> {
  // r.jina.ai renders JavaScript-heavy pages and returns readable text. Only public URLs are ever sent.
  try {
    const res = await safeFetch(`https://r.jina.ai/${url}`, { timeoutMs, maxBytes: 1_000_000, accept: "text/plain", allowText: true });
    if (res.status !== 200 || res.text.length < 200) return null;
    const title = /^Title:\s*(.+)$/m.exec(res.text)?.[1]?.trim() ?? "";
    const body = res.text.split(/^Markdown Content:\s*$/m)[1] ?? res.text;
    return { text: body.slice(0, 60_000), title };
  } catch {
    return null;
  }
}

function readerToHtml(title: string, md: string): string {
  // Convert markdown-ish text into minimal HTML so the same extractor runs on it.
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const withLinks = esc(md).replace(/\[([^\]]*)\]\((https?:[^)\s]+|mailto:[^)\s]+|tel:[^)\s]+)[^)]*\)/g, (_m, t, h) => `<a href="${h}">${t}</a>`);
  return `<html><head><title>${esc(title)}</title></head><body>${withLinks
    .split(/\n+/)
    .map((l) => `<p>${l}</p>`)
    .join("")}</body></html>`;
}

/**
 * Crawl a public website politely: robots.txt aware, same-site only, prioritised
 * towards pages that describe the business and its people, bounded in pages and time.
 */
export async function crawlSite(input: string, opts: CrawlOptions = {}): Promise<CrawlResult> {
  const started = Date.now();
  const maxPages = Math.min(Math.max(opts.maxPages ?? 30, 1), 60);
  const concurrency = Math.min(Math.max(opts.concurrency ?? 6, 1), 10);
  const budgetMs = opts.budgetMs ?? 28_000;
  const pageTimeoutMs = opts.pageTimeoutMs ?? 9_000;
  const deadline = started + budgetMs;
  const errors: string[] = [];
  const robotsBlocked: string[] = [];

  const start = normalizeInputUrl(input);
  await assertPublicHost(start.hostname);

  // 1. Homepage (follows redirects such as http->https or apex->www).
  let home: Awaited<ReturnType<typeof safeFetch>> | null = null;
  let homeError: FetchError | null = null;
  const tryUrls = [start.href];
  if (start.protocol === "https:") tryUrls.push(start.href.replace(/^https:/, "http:"));
  if (!/^www\./.test(start.hostname)) tryUrls.push(start.href.replace(`//${start.hostname}`, `//www.${start.hostname}`));
  for (const u of tryUrls) {
    try {
      home = await safeFetch(u, { timeoutMs: Math.min(12_000, pageTimeoutMs + 3000), requireHtml: true });
      if (home.status < 400) break;
      homeError = new FetchError(`HTTP ${home.status}`, "http", home.status);
      if (home.status === 404 && start.pathname !== "/") {
        // Deep link that 404s: retry the root.
        tryUrls.push(`${start.origin}/`);
      }
      if (home.status >= 400 && ![403, 429, 503, 404].includes(home.status)) break;
    } catch (e) {
      homeError = e as FetchError;
      home = null;
      if ((e as FetchError).kind === "blocked") break;
    }
  }

  const finalHome = home && home.status < 400 ? new URL(home.url) : null;
  if (finalHome) await assertPublicHost(finalHome.hostname).catch((e) => {
    throw e;
  });
  const siteHost = finalHome?.hostname ?? start.hostname;
  const origin = finalHome?.origin ?? start.origin;
  const domain = siteKey(siteHost);
  if (finalHome && !isSameSite(finalHome.hostname, start.hostname)) {
    errors.push(`The site redirected from ${start.hostname} to ${finalHome.hostname}; researching the destination.`);
  }

  const robots = await fetchRobots(origin);
  const pages: CrawledPage[] = [];
  const seen = new Set<string>();
  const queue: { url: URL; priority: number; via: CrawledPage["via"] }[] = [];
  let usedReaderFallback = false;

  const enqueue = (u: URL, via: CrawledPage["via"]) => {
    const k = urlKey(u);
    if (seen.has(k)) return;
    seen.add(k);
    const pathQ = u.pathname + u.search;
    if (!isAllowed(robots, pathQ)) {
      robotsBlocked.push(u.href);
      return;
    }
    queue.push({ url: u, priority: scorePath(u), via });
  };

  if (home && home.status < 400) {
    const homeUrl = new URL(home.url);
    seen.add(urlKey(homeUrl));
    if (!isAllowed(robots, homeUrl.pathname + homeUrl.search)) {
      robotsBlocked.push(homeUrl.href);
      errors.push("robots.txt asks crawlers not to read this site's homepage, so it was skipped.");
    } else {
      let extract = extractPage(home.text, home.url);
      if ((extract.looksJsRendered || extract.wordCount < 40) && opts.allowReaderFallback !== false) {
        const r = await readerFetch(home.url, 12_000);
        if (r) {
          const viaReader = extractPage(readerToHtml(r.title, r.text), home.url);
          if (viaReader.wordCount > extract.wordCount) {
            extract = { ...viaReader, title: extract.title || viaReader.title, description: extract.description, emails: [...extract.emails, ...viaReader.emails], socials: [...extract.socials, ...viaReader.socials] };
            usedReaderFallback = true;
          }
        }
      }
      pages.push({ url: home.url, status: home.status, extract, priority: 1000, via: "home" });
      for (const href of extract.links) {
        const c = canonicalizeLink(href, homeUrl, siteHost);
        if (c) enqueue(c, "link");
      }
    }
  } else {
    const reason = homeError ? describeFetchError(homeError) : "unknown error";
    errors.push(`Homepage could not be loaded: ${reason}.`);
    if (homeError?.kind === "blocked") {
      throw new UrlValidationError("That address points to a private or blocked network location.");
    }
    if (homeError?.kind === "network" && /ENOTFOUND|EAI_AGAIN/.test(homeError.message)) {
      throw new UrlValidationError(`The domain ${start.hostname} could not be reached. Check the spelling.`);
    }
    // Site may block bots (403) or be JS-only: try the reader for the homepage.
    if (opts.allowReaderFallback !== false) {
      const r = await readerFetch(start.href, 12_000);
      if (r) {
        const extract = extractPage(readerToHtml(r.title, r.text), start.href);
        pages.push({ url: start.href, status: 200, extract, priority: 1000, via: "reader" });
        usedReaderFallback = true;
        for (const href of extract.links) {
          const c = canonicalizeLink(href, start, siteHost);
          if (c) enqueue(c, "link");
        }
      }
    }
  }

  // 2. Sitemap + common paths (skipped when the server itself is unreachable / has broken TLS,
  // since every other page on it would fail the same way).
  const serverBroken = !home && homeError && (homeError.kind === "network" || homeError.kind === "timeout");
  if (!serverBroken) {
    const sitemapUrls = await fetchSitemapUrls(origin, robots, siteHost, deadline);
    for (const u of sitemapUrls) enqueue(u, "sitemap");
    for (const p of GUESS_PATHS) enqueue(new URL(p, origin), "guess");
  } else {
    queue.length = 0;
  }
  const pagesFound = seen.size;

  // 3. Prioritised BFS with bounded concurrency.
  const takeNext = () => {
    if (!queue.length) return null;
    let bi = 0;
    for (let i = 1; i < queue.length; i++) if (queue[i].priority > queue[bi].priority) bi = i;
    return queue.splice(bi, 1)[0];
  };

  const worker = async () => {
    while (pages.length < maxPages && Date.now() < deadline - 1500) {
      const item = takeNext();
      if (!item) return;
      const remaining = deadline - Date.now();
      try {
        const res = await safeFetch(item.url, { timeoutMs: Math.max(2000, Math.min(pageTimeoutMs, remaining - 1000)), requireHtml: true });
        if (res.status >= 400) {
          // Guessed paths that 404 are expected; don't record them as failures.
          if (item.via !== "guess") pages.push({ url: item.url.href, status: res.status, error: `HTTP ${res.status}`, errorKind: "http", priority: item.priority, via: item.via });
          continue;
        }
        const finalUrl = new URL(res.url);
        if (!isSameSite(finalUrl.hostname, siteHost)) continue; // redirected off-site
        const fk = urlKey(finalUrl);
        if (fk !== urlKey(item.url)) {
          if (pages.some((p) => urlKey(new URL(p.url)) === fk)) continue;
          seen.add(fk);
        }
        const extract = extractPage(res.text, res.url);
        if (pages.length >= maxPages) return;
        pages.push({ url: res.url, status: res.status, extract, priority: item.priority, via: item.via });
        if (item.priority >= 30) {
          for (const href of extract.links) {
            const c = canonicalizeLink(href, finalUrl, siteHost);
            if (c) enqueue(c, "link");
          }
        }
      } catch (e) {
        const fe = e as FetchError;
        if (item.via === "guess" && fe.kind === "not_html") continue;
        pages.push({ url: item.url.href, status: fe.status ?? 0, error: describeFetchError(fe), errorKind: fe.kind, priority: item.priority, via: item.via });
      }
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));

  if (Date.now() >= deadline - 1500 && queue.length) errors.push(`Stopped after the time budget with ${queue.length} lower-priority pages left unvisited.`);
  if (!pages.some((p) => p.extract)) errors.push("No readable pages could be fetched from this website.");

  return {
    inputUrl: start.href,
    finalUrl: finalHome?.href ?? start.href,
    domain,
    pages: pages.sort((a, b) => b.priority - a.priority),
    pagesFound: Math.max(pagesFound, pages.length),
    robotsBlocked,
    errors,
    durationMs: Date.now() - started,
    robotsFetched: robots.fetched,
    usedReaderFallback,
  };
}

export function describeFetchError(e: FetchError | Error): string {
  const fe = e as FetchError;
  switch (fe.kind) {
    case "timeout":
      return "the site took too long to respond";
    case "blocked":
      return "the address is blocked for security reasons";
    case "too_large":
      return "the page is too large";
    case "not_html":
      return "it isn't a web page";
    case "http":
      return fe.status === 403 ? "the site refused automated access (HTTP 403)" : fe.status === 429 ? "the site is rate limiting requests (HTTP 429)" : `HTTP ${fe.status}`;
    case "network":
      return /ENOTFOUND|EAI_AGAIN/.test(fe.message) ? "the domain does not exist" : /ECONNREFUSED/.test(fe.message) ? "the server refused the connection" : /CERT|SSL|TLS/i.test(fe.message) ? "the site's security certificate is invalid" : "the site could not be reached";
    default:
      return fe.message || "unknown error";
  }
}
