import { BOT_NAME, safeFetch } from "./fetcher";

type Rule = { allow: boolean; pattern: string };
export type Robots = {
  rules: Rule[];
  sitemaps: string[];
  crawlDelay?: number;
  fetched: boolean;
  /** Set when robots.txt itself was unreachable in a way that means "disallow all" (5xx). */
  disallowAll?: boolean;
};

/** Parse robots.txt, keeping the most specific group for our bot (falls back to "*"). */
export function parseRobots(txt: string, botName = BOT_NAME): Omit<Robots, "fetched"> {
  const lines = txt.split(/\r?\n/).map((l) => l.replace(/#.*$/, "").trim());
  type Group = { agents: string[]; rules: Rule[]; crawlDelay?: number };
  const groups: Group[] = [];
  const sitemaps: string[] = [];
  let current: Group | null = null;
  let lastWasAgent = false;
  for (const line of lines) {
    if (!line) continue;
    const idx = line.indexOf(":");
    if (idx < 0) continue;
    const key = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();
    if (key === "sitemap") {
      if (value) sitemaps.push(value);
      continue;
    }
    if (key === "user-agent") {
      if (!current || !lastWasAgent) {
        current = { agents: [], rules: [] };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
      continue;
    }
    lastWasAgent = false;
    if (!current) continue;
    if (key === "allow" || key === "disallow") {
      if (key === "disallow" && !value) continue; // empty disallow = allow all
      current.rules.push({ allow: key === "allow", pattern: value });
    } else if (key === "crawl-delay") {
      const n = Number(value);
      if (Number.isFinite(n)) current.crawlDelay = n;
    }
  }
  const me = botName.toLowerCase();
  const specific = groups.filter((g) => g.agents.some((a) => a !== "*" && me.includes(a)));
  const chosen = specific.length ? specific : groups.filter((g) => g.agents.includes("*"));
  return {
    rules: chosen.flatMap((g) => g.rules),
    sitemaps,
    crawlDelay: chosen.find((g) => g.crawlDelay !== undefined)?.crawlDelay,
  };
}

function patternToRegex(pattern: string): RegExp {
  const anchored = pattern.endsWith("$");
  const body = (anchored ? pattern.slice(0, -1) : pattern)
    .split("*")
    .map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${body}${anchored ? "$" : ""}`);
}

/** Google-style evaluation: longest matching rule wins, allow wins ties. */
export function isAllowed(robots: Pick<Robots, "rules" | "disallowAll">, pathWithQuery: string): boolean {
  if (robots.disallowAll) return false;
  let best: Rule | null = null;
  let bestLen = -1;
  for (const rule of robots.rules) {
    let decoded = rule.pattern;
    try {
      decoded = decodeURI(rule.pattern);
    } catch {}
    let path = pathWithQuery;
    try {
      path = decodeURI(pathWithQuery);
    } catch {}
    if (patternToRegex(decoded).test(path)) {
      const len = rule.pattern.length;
      if (len > bestLen || (len === bestLen && rule.allow)) {
        best = rule;
        bestLen = len;
      }
    }
  }
  return best ? best.allow : true;
}

export async function fetchRobots(origin: string, signal?: AbortSignal): Promise<Robots> {
  try {
    const res = await safeFetch(`${origin}/robots.txt`, { timeoutMs: 5000, maxBytes: 300_000, accept: "text/plain,*/*", signal });
    if (res.status >= 500) return { rules: [], sitemaps: [], fetched: false, disallowAll: false };
    if (res.status >= 400) return { rules: [], sitemaps: [], fetched: true };
    if (/<html/i.test(res.text.slice(0, 500))) return { rules: [], sitemaps: [], fetched: true }; // soft-404 HTML page
    return { ...parseRobots(res.text), fetched: true };
  } catch {
    // Unreachable robots.txt: treat as no restrictions (common for small sites), the crawl remains polite.
    return { rules: [], sitemaps: [], fetched: false };
  }
}
