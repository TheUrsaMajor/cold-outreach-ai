import * as cheerio from "cheerio";
import type { AnyNode, Element } from "domhandler";

export type ExtractedEmail = { email: string; context: string; viaMailto: boolean };
export type ExtractedPerson = { name: string; title: string; evidence: string; method: "jsonld" | "pattern" | "dom" };
export type SocialKind = "linkedin" | "twitter" | "facebook" | "instagram" | "github" | "youtube" | "calendly" | "discord";
export type ExtractedSocial = { kind: SocialKind; url: string; personal: boolean };

export type PageExtract = {
  title: string;
  description: string;
  siteName: string;
  headings: string[];
  text: string;
  wordCount: number;
  links: string[];
  emails: ExtractedEmail[];
  phones: string[];
  socials: ExtractedSocial[];
  hasContactForm: boolean;
  people: ExtractedPerson[];
  orgName?: string;
  looksJsRendered: boolean;
};

const EMAIL_RE = /[a-z0-9][a-z0-9._%+-]{0,63}@(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24}/gi;

export function decodeCfEmail(hex: string): string | null {
  if (!/^[0-9a-f]+$/i.test(hex) || hex.length < 4 || hex.length % 2) return null;
  const key = parseInt(hex.slice(0, 2), 16);
  let out = "";
  for (let i = 2; i < hex.length; i += 2) out += String.fromCharCode(parseInt(hex.slice(i, i + 2), 16) ^ key);
  return out.includes("@") ? out : null;
}

/** Turn "jane [at] acme [dot] com" style obfuscation back into an address. */
export function deobfuscate(text: string): string {
  return text
    .replace(/\s*(?:\[|\(|\{|<)\s*(?:at|@)\s*(?:\]|\)|\}|>)\s*/gi, "@")
    .replace(/\s*(?:\[|\(|\{|<)\s*(?:dot|\.)\s*(?:\]|\)|\}|>)\s*/gi, ".")
    .replace(/([a-z0-9._%+-]+)\s+at\s+([a-z0-9-]+)\s+dot\s+([a-z]{2,24})\b/gi, "$1@$2.$3");
}

const BAD_EMAIL_DOMAINS = /(^|\.)(example\.(com|org|net)|domain\.com|email\.com|yourdomain\.|yourcompany\.|company\.com|sentry\.io|sentry-next\.wixpress\.com|wixpress\.com|test\.com|mysite\.com|website\.com|acme\.com|sentry\.wixpress\.com|ingest\.sentry\.io)$/i;
const BAD_EMAIL_LOCAL = /^(noreply|no-reply|donotreply|do-not-reply|mailer-daemon|postmaster|bounce|bounces|example|test|user|username|name|your\.?name|yourname|email|you|firstname|first\.last|john\.?doe|jane\.?doe)$/i;

export function cleanEmail(raw: string): string | null {
  let e = raw.trim().toLowerCase().replace(/^mailto:/, "");
  e = e.split("?")[0];
  try {
    e = decodeURIComponent(e);
  } catch {}
  e = e.replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, "");
  const m = e.match(/^[a-z0-9][a-z0-9._%+-]{0,63}@(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24}$/);
  if (!m) return null;
  const [local, domain] = e.split("@");
  if (/\.(png|jpe?g|gif|webp|svg|avif|css|js)$/.test(domain)) return null; // image@2x.png
  if (/^\d+x$/.test(domain.split(".")[0])) return null;
  if (BAD_EMAIL_DOMAINS.test(domain)) return null;
  if (BAD_EMAIL_LOCAL.test(local)) return null;
  if (/^[0-9a-f]{16,}$/.test(local)) return null; // hashes (sentry DSNs etc.)
  if (local.includes("..")) return null;
  return e;
}

function textOf($: cheerio.CheerioAPI, el: AnyNode): string {
  return $(el).text().replace(/\s+/g, " ").trim();
}

const NAME_STOP = new Set(
  "our the team about meet company inc llc ltd founder founders cofounder co-founder ceo cto coo cfo chief officer get contact read more privacy terms home blog careers join us we you your and with for from by in on at of to who what why how sign log new all view see learn product products pricing customers story mission today welcome hello hi head lead director manager engineer designer partner partners investor investors board advisor advisors support sales marketing operations business software platform startup startups open source community press news faq help cookie cookies policy san new york london berlin paris remote global united states america india email phone call book demo free trial started now here more".split(
    " ",
  ),
);

export function looksLikeName(s: string): boolean {
  const name = s.trim();
  if (name.length < 4 || name.length > 40) return false;
  const parts = name.split(/\s+/);
  if (parts.length < 2 || parts.length > 4) return false;
  return parts.every((p, i) => {
    if (NAME_STOP.has(p.toLowerCase().replace(/[^a-z-]/g, ""))) return false;
    if (i > 0 && /^(van|von|de|da|del|der|di|du|la|le|bin|al)$/i.test(p)) return true;
    return /^[A-ZÀ-ɏ][a-zÀ-ɏ'’.\-]{0,20}$/.test(p) || /^[A-Z]\.$/.test(p);
  });
}

const ROLE_RE = /\b((?:co[\s-]?)?founder(?:s)?(?:\s*(?:&|and|,|\/)\s*(?:ceo|cto|coo|chief [a-z]+ officer|president|managing director))?|ceo(?:\s*(?:&|and|,|\/)\s*(?:co[\s-]?)?founder)?|chief executive officer|managing director|owner|president)\b/i;

function normalizeTitle(t: string): string {
  return t
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^the\s+/i, "")
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .replace(/\bCeo\b/g, "CEO")
    .replace(/\bCto\b/g, "CTO")
    .replace(/\bCoo\b/g, "COO")
    .replace(/\bCo Founder\b/gi, "Co-Founder")
    .slice(0, 80);
}

/** Find founders / key people in visible text using conservative patterns. */
export function findPeopleInText(text: string): ExtractedPerson[] {
  const out: ExtractedPerson[] = [];
  const NAME = "([A-Z\\u00C0-\\u024F][a-z\\u00C0-\\u024F'’\\-]+(?:\\s+(?:[A-Z]\\.\\s+)?[A-Z\\u00C0-\\u024F][a-z\\u00C0-\\u024F'’\\-]+){1,2})";
  const ROLE = "((?:[Cc]o[\\s-]?)?[Ff]ounder(?:\\s*(?:&|and|,|/)\\s*(?:CEO|CTO|COO|[Cc]hief [A-Za-z]+ [Oo]fficer|President))?|CEO(?:\\s*(?:&|and|,|/)\\s*(?:[Cc]o[\\s-]?)?[Ff]ounder)?|[Cc]hief [Ee]xecutive [Oo]fficer|[Mm]anaging [Dd]irector)";
  const patterns: RegExp[] = [
    new RegExp(`${NAME}\\s*(?:,|–|—|-|\\||·|:|\\(|\\bis\\b(?:\\s+(?:the|our|a))?|\\bour\\b)\\s*(?:the\\s+|our\\s+)?${ROLE}`, "g"),
    new RegExp(`${ROLE}\\s*(?:,|–|—|-|\\||·|:)?\\s*(?:and\\s+)?${NAME}`, "g"),
  ];
  for (const re of patterns) {
    for (const m of text.matchAll(re)) {
      const [full, a, b] = m;
      const nameFirst = re === patterns[0];
      const name = (nameFirst ? a : b).trim();
      const title = (nameFirst ? b : a).trim();
      if (!looksLikeName(name)) continue;
      const idx = m.index ?? 0;
      out.push({ name, title: normalizeTitle(title), evidence: text.slice(Math.max(0, idx - 40), idx + full.length + 40).trim(), method: "pattern" });
    }
  }
  const founded = /\b(?:[Cc]o-?founded|[Ff]ounded|[Ss]tarted|[Cc]reated|[Bb]uilt)\s+(?:in\s+\d{4}\s+)?by\s+([^.;\n]{4,120})/g;
  for (const m of text.matchAll(founded)) {
    const chunk = m[1];
    const names = chunk.split(/\s*(?:,|\band\b|&)\s*/).map((s) => s.trim().split(/\s+/).slice(0, 3).join(" "));
    for (const n of names) {
      const clean = n.replace(/[^A-Za-zÀ-ɏ'’\-\s.]/g, "").trim();
      const words = clean.split(/\s+/);
      for (let len = Math.min(3, words.length); len >= 2; len--) {
        const cand = words.slice(0, len).join(" ");
        if (looksLikeName(cand)) {
          const idx = m.index ?? 0;
          out.push({ name: cand, title: "Founder", evidence: text.slice(idx, idx + m[0].length).trim().slice(0, 200), method: "pattern" });
          break;
        }
      }
    }
  }
  return out;
}

function findPeopleInDom($: cheerio.CheerioAPI): ExtractedPerson[] {
  const out: ExtractedPerson[] = [];
  $("h1,h2,h3,h4,h5,h6,p,span,div,li,small,em,strong,figcaption,dd,dt").each((_, el) => {
    const e = el as Element;
    if ($(e).children().length > 3) return;
    const t = textOf($, e);
    if (t.length > 70 || !ROLE_RE.test(t)) return;
    if (!/founder|ceo|chief executive|managing director|owner|president/i.test(t)) return;
    const candidates: string[] = [];
    const prev = $(e).prev();
    if (prev.length) candidates.push(textOf($, prev[0]));
    const next = $(e).next();
    if (next.length) candidates.push(textOf($, next[0]));
    const parent = $(e).parent();
    parent.find("h1,h2,h3,h4,h5,h6,strong,b").each((_, h) => {
      candidates.push(textOf($, h));
    });
    const own = t.replace(ROLE_RE, "").replace(/[,|·\-–—:()&]/g, " ").replace(/\s+/g, " ").trim();
    candidates.push(own);
    for (const c of candidates) {
      if (c && c !== t && looksLikeName(c)) {
        out.push({ name: c, title: normalizeTitle(t.match(ROLE_RE)?.[0] ?? t), evidence: `${c} — ${t}`.slice(0, 200), method: "dom" });
        break;
      }
      if (c === own && looksLikeName(own)) {
        out.push({ name: own, title: normalizeTitle(t.match(ROLE_RE)?.[0] ?? t), evidence: t, method: "dom" });
        break;
      }
    }
  });
  return out;
}

type JsonLd = Record<string, unknown>;
function walkJsonLd(node: unknown, visit: (n: JsonLd) => void, depth = 0) {
  if (!node || depth > 8) return;
  if (Array.isArray(node)) return node.forEach((n) => walkJsonLd(n, visit, depth + 1));
  if (typeof node === "object") {
    visit(node as JsonLd);
    for (const v of Object.values(node as JsonLd)) if (v && typeof v === "object") walkJsonLd(v, visit, depth + 1);
  }
}

function asArray<T>(v: T | T[] | undefined | null): T[] {
  return v == null ? [] : Array.isArray(v) ? v : [v];
}

const SOCIAL_PATTERNS: [SocialKind, RegExp][] = [
  ["linkedin", /^https?:\/\/([a-z]{2,3}\.)?linkedin\.com\/(company|in|school)\/[^/?#]+/i],
  ["twitter", /^https?:\/\/(www\.|mobile\.)?(twitter|x)\.com\/(?!intent|share|home|search|hashtag|i\/)[A-Za-z0-9_]{1,15}\/?(\?.*)?$/i],
  ["facebook", /^https?:\/\/([a-z]+\.)?facebook\.com\/(?!sharer|share|dialog|plugins|tr\b)[^?#]+/i],
  ["instagram", /^https?:\/\/(www\.)?instagram\.com\/(?!p\/|reel\/|explore)[A-Za-z0-9_.]+/i],
  ["github", /^https?:\/\/(www\.)?github\.com\/[A-Za-z0-9-]+\/?$/i],
  ["youtube", /^https?:\/\/(www\.)?youtube\.com\/(@|c\/|channel\/|user\/)[^?#]+/i],
  ["calendly", /^https?:\/\/(www\.)?(calendly\.com|cal\.com)\/[^?#]+/i],
  ["discord", /^https?:\/\/(www\.)?(discord\.gg|discord\.com\/invite)\/[^?#]+/i],
];

export function classifySocial(href: string): ExtractedSocial | null {
  for (const [kind, re] of SOCIAL_PATTERNS) {
    if (re.test(href)) {
      const url = href.split("#")[0].replace(/\?.*$/, "").replace(/\/$/, "");
      return { kind, url, personal: kind === "linkedin" ? /\/in\//i.test(href) : false };
    }
  }
  return null;
}

/** Extract everything useful from one HTML page. */
export function extractPage(html: string, pageUrl: string): PageExtract {
  const $ = cheerio.load(html);
  const emails = new Map<string, ExtractedEmail>();
  const addEmail = (raw: string, context: string, viaMailto: boolean) => {
    const e = cleanEmail(raw);
    if (!e) return;
    const prev = emails.get(e);
    if (!prev || (viaMailto && !prev.viaMailto)) emails.set(e, { email: e, context: context.slice(0, 300), viaMailto });
  };

  // Cloudflare email protection
  $("[data-cfemail]").each((_, el) => {
    const d = decodeCfEmail($(el).attr("data-cfemail") || "");
    if (d) addEmail(d, textOf($, $(el).parent()[0] ?? el), true);
  });
  $('a[href*="/cdn-cgi/l/email-protection#"]').each((_, el) => {
    const hex = ($(el).attr("href") || "").split("#")[1] || "";
    const d = decodeCfEmail(hex);
    if (d) addEmail(d, textOf($, $(el).parent()[0] ?? el), true);
  });

  // mailto links (context = surrounding block text)
  $('a[href^="mailto:" i]').each((_, el) => {
    const href = $(el).attr("href") || "";
    const addrs = href.replace(/^mailto:/i, "").split("?")[0].split(/[,;]/);
    const ctxEl = $(el).closest("li,p,div,section,footer,td") [0] ?? el;
    for (const a of addrs) addEmail(a, textOf($, ctxEl), true);
  });

  // JSON-LD (before removing scripts)
  const people: ExtractedPerson[] = [];
  const phones = new Set<string>();
  let orgName: string | undefined;
  $('script[type="application/ld+json"]').each((_, el) => {
    let data: unknown;
    try {
      data = JSON.parse($(el).contents().text());
    } catch {
      return;
    }
    walkJsonLd(data, (n) => {
      const type = asArray(n["@type"] as string | string[]).map(String);
      if (typeof n.email === "string") addEmail(n.email, `structured data (${type.join(",")})`, true);
      if (typeof n.telephone === "string" && n.telephone.replace(/\D/g, "").length >= 7) phones.add(n.telephone.trim());
      if (type.some((t) => /Organization|Corporation|LocalBusiness/i.test(t)) && typeof n.name === "string" && !orgName) orgName = n.name;
      for (const f of asArray(n.founder as unknown)) {
        if (f && typeof f === "object" && typeof (f as JsonLd).name === "string") {
          const name = String((f as JsonLd).name);
          if (looksLikeName(name)) people.push({ name, title: "Founder", evidence: `Listed as founder in the site's structured data`, method: "jsonld" });
        } else if (typeof f === "string" && looksLikeName(f)) {
          people.push({ name: f, title: "Founder", evidence: `Listed as founder in the site's structured data`, method: "jsonld" });
        }
      }
      if (type.includes("Person") && typeof n.name === "string" && typeof n.jobTitle === "string" && ROLE_RE.test(n.jobTitle)) {
        if (looksLikeName(n.name)) people.push({ name: n.name, title: normalizeTitle(n.jobTitle), evidence: `Structured data: ${n.name}, ${n.jobTitle}`, method: "jsonld" });
      }
    });
  });

  $('a[href^="tel:" i]').each((_, el) => {
    const t = ($(el).attr("href") || "").replace(/^tel:/i, "").trim();
    let decoded = t;
    try {
      decoded = decodeURIComponent(t);
    } catch {}
    if (decoded.replace(/\D/g, "").length >= 7 && decoded.replace(/\D/g, "").length <= 15) phones.add(decoded);
  });

  const socials = new Map<string, ExtractedSocial>();
  const links: string[] = [];
  $("a[href]").each((_, el) => {
    const href = ($(el).attr("href") || "").trim();
    if (!href) return;
    let abs: string;
    try {
      abs = new URL(href, pageUrl).href;
    } catch {
      return;
    }
    const s = classifySocial(abs);
    if (s) socials.set(s.url.toLowerCase(), s);
    links.push(href);
  });
  // Also canonical alternate links for crawl discovery
  $('link[rel="alternate"][hreflang]').each(() => {});

  const hasContactForm =
    $("form").filter((_, f) => {
      const $f = $(f);
      const hasEmail = $f.find('input[type="email"], input[name*="email" i]').length > 0;
      const hasMsg = $f.find("textarea").length > 0;
      const isSearch = ($f.attr("role") || "").includes("search") || $f.find('input[type="search"]').length > 0;
      return hasEmail && hasMsg && !isSearch;
    }).length > 0 ||
    $('iframe[src*="hsforms"], iframe[src*="typeform"], iframe[src*="tally.so"], iframe[src*="jotform"], iframe[src*="forms.gle"], iframe[src*="docs.google.com/forms"], div.hs-form, [data-tf-widget]').length > 0;

  const title = ($("title").first().text() || "").replace(/\s+/g, " ").trim().slice(0, 300);
  const description = ($('meta[name="description" i]').attr("content") || $('meta[property="og:description"]').attr("content") || "").trim().slice(0, 1000);
  const siteName = ($('meta[property="og:site_name"]').attr("content") || "").trim().slice(0, 200);

  // Visible text
  $("script,style,noscript,svg,template,iframe,canvas,link,meta").remove();
  const people2 = findPeopleInDom($);
  const headings = $("h1,h2,h3")
    .map((_, el) => textOf($, el))
    .get()
    .filter((t) => t.length > 1 && t.length < 200)
    .slice(0, 40);
  // Insert line breaks between block elements so patterns don't run across them.
  $("br").replaceWith("\n");
  $("p,div,li,h1,h2,h3,h4,h5,h6,section,article,header,footer,tr,td,th,dd,dt,blockquote,figcaption").each((_, el) => {
    $(el).append("\n");
  });
  const rawText = ($("body").length ? $("body").text() : $.root().text())
    .replace(/[ \t ]+/g, " ")
    .replace(/\s*\n\s*/g, "\n")
    .replace(/\n{2,}/g, "\n")
    .trim();
  const text = rawText.slice(0, 60_000);

  // Emails in visible text (including obfuscated)
  const deob = deobfuscate(text);
  for (const m of deob.matchAll(EMAIL_RE)) {
    const idx = m.index ?? 0;
    addEmail(m[0], deob.slice(Math.max(0, idx - 120), idx + m[0].length + 60).replace(/\n/g, " "), false);
  }

  const peopleText = findPeopleInText(text.replace(/\n/g, " \n "));
  const wordCount = text.split(/\s+/).filter(Boolean).length;
  const looksJsRendered = wordCount < 60 && /<div id="(root|__next|app|__nuxt)"|data-reactroot|ng-version|window\.__NUXT__/i.test(html);

  return {
    title,
    description,
    siteName,
    headings,
    text,
    wordCount,
    links,
    emails: [...emails.values()],
    phones: [...phones].slice(0, 10),
    socials: [...socials.values()].slice(0, 30),
    hasContactForm,
    people: dedupePeople([...people, ...people2, ...peopleText]),
    orgName,
    looksJsRendered,
  };
}

export function dedupePeople(list: ExtractedPerson[]): ExtractedPerson[] {
  const rank = { jsonld: 0, dom: 1, pattern: 2 } as const;
  const map = new Map<string, ExtractedPerson>();
  for (const p of list) {
    const key = p.name.toLowerCase().replace(/[^a-zÀ-ɏ]/g, "");
    const prev = map.get(key);
    if (!prev || rank[p.method] < rank[prev.method] || (/founder/i.test(p.title) && !/founder/i.test(prev.title))) map.set(key, p);
  }
  return [...map.values()];
}
