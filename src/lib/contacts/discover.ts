import { resolveMx, resolve4, resolve6 } from "node:dns/promises";
import type { CrawledPage } from "../crawler/crawl";
import type { ExtractedPerson, SocialKind } from "../crawler/extract";
import { siteKey } from "../crawler/url";

export type ContactTier = "founder_email" | "company_email" | "other_contact";
export type ContactKind = "email" | "phone" | "contact_form" | SocialKind | "other";

export type DiscoveredContact = {
  kind: ContactKind;
  value: string;
  label: string;
  tier: ContactTier;
  rank: number;
  confidence: "high" | "medium" | "low";
  sourceUrl: string;
  founderName?: string;
  mxValid?: boolean | null;
  isValid: boolean;
  invalidReason?: string;
};

export type DiscoveredFounder = {
  name: string;
  title: string;
  sourceUrl: string;
  evidence: string;
  method: ExtractedPerson["method"] | "ai";
};

export type DiscoveryResult = {
  founders: DiscoveredFounder[];
  contacts: DiscoveredContact[];
  best: DiscoveredContact | null;
  /** Which step of the fallback order produced the best contact. */
  outcome: "founder_email" | "company_email" | "other_contact" | "none";
};

const GENERIC_LOCALS: Record<string, number> = {
  founders: 5, founder: 5, ceo: 6,
  hello: 20, hi: 21, hey: 22, team: 23, contact: 24, contactus: 24, info: 26, sales: 27, partnerships: 28, partners: 28, business: 29, bd: 29,
  enquiries: 30, inquiries: 30, office: 31, general: 31, mail: 32, admin: 34, support: 40, help: 41, care: 42, customerservice: 42, success: 43,
  press: 50, media: 50, pr: 50, marketing: 45, careers: 60, jobs: 60, hr: 60, talent: 60,
  concierge: 30, newsletter: 65, newsletters: 65, drafts: 75, notifications: 75, updates: 60, events: 55, community: 45, feedback: 45, ops: 35, operations: 35,
  orders: 60, shop: 60, store: 60, booking: 40, bookings: 40, studio: 25, dev: 50, developers: 50, api: 70, status: 80, webmaster: 80, accessibility: 80,
  billing: 70, accounts: 70, invoices: 72, finance: 70, privacy: 80, legal: 80, dpo: 82, gdpr: 82, security: 84, abuse: 90, dmca: 90, compliance: 82,
};
const FOUNDER_ROLE_LOCALS = new Set(["founders", "founder", "ceo"]);

function nameTokens(name: string) {
  const parts = name
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z\s-]/g, "")
    .split(/\s+/)
    .filter((p) => p.length > 1);
  return { first: parts[0] ?? "", last: parts[parts.length - 1] ?? "" };
}

/** Does this mailbox local part plausibly belong to this person? */
export function localMatchesName(local: string, name: string): boolean {
  const { first, last } = nameTokens(name);
  if (!first) return false;
  const l = local.toLowerCase().replace(/[^a-z.\-_]/g, "");
  const flat = l.replace(/[.\-_]/g, "");
  const candidates = new Set([
    first,
    `${first}${last}`,
    `${first}.${last}`,
    `${first}_${last}`,
    `${first}-${last}`,
    `${first[0]}${last}`,
    `${first[0]}.${last}`,
    `${first}${last[0] ?? ""}`,
    `${first}.${last[0] ?? ""}`,
    `${last}.${first}`,
    `${last}${first}`,
    last.length > 3 ? last : "__none__",
  ]);
  return candidates.has(l) || candidates.has(flat);
}

function isPersonalLooking(local: string): boolean {
  const flat = local.toLowerCase().replace(/[^a-z]/g, "");
  if (GENERIC_LOCALS[flat] !== undefined) return false;
  return /^[a-z]{2,}([._-][a-z]{1,})?$/.test(local.toLowerCase()) && flat.length <= 24;
}

const mxCache = new Map<string, Promise<{ ok: boolean | null; reason?: string }>>();

/** Check that an email domain can receive mail (has MX, or A/AAAA as implicit MX). null = unknown. */
export function checkMailDomain(domain: string, timeoutMs = 3000): Promise<{ ok: boolean | null; reason?: string }> {
  const d = domain.toLowerCase();
  if (!mxCache.has(d)) {
    const run = (async () => {
      const t = <T,>(p: Promise<T>) => Promise.race([p, new Promise<never>((_, rej) => setTimeout(() => rej(new Error("timeout")), timeoutMs))]);
      try {
        const mx = await t(resolveMx(d));
        if (mx.length === 1 && (mx[0].exchange === "" || mx[0].exchange === ".")) return { ok: false, reason: "The domain declares it does not accept email (null MX)." };
        if (mx.length) return { ok: true };
      } catch (e) {
        const code = (e as NodeJS.ErrnoException).code;
        if (code !== "ENODATA" && code !== "ENOTFOUND") return { ok: null }; // timeout / resolver trouble: unknown
        if (code === "ENOTFOUND") return { ok: false, reason: "The email domain does not exist." };
      }
      try {
        const a = await t(resolve4(d)).catch(() => [] as string[]);
        const aaaa = a.length ? [] : await t(resolve6(d)).catch(() => [] as string[]);
        if (a.length || aaaa.length) return { ok: true };
        return { ok: false, reason: "The email domain has no mail server (no MX record)." };
      } catch {
        return { ok: null };
      }
    })();
    mxCache.set(d, run);
  }
  return mxCache.get(d)!;
}

/**
 * "Jane Doe, Founder at OtherCo" on a prospect's site is almost always a testimonial
 * or investor, not the prospect's founder. Drop people whose role names another company.
 */
export function worksElsewhere(text: string, name: string, rootWord: string, siteNames: Set<string> = new Set()): boolean {
  const ROLE_WORDS = /^(co-?founder|founder|ceo|cto|coo|cfo|cmo|cpo|president|owner|chief|head|vp|director|managing|partner|lead|and)\b/i;
  const commaRe = /(?:founder|ceo)\s*(?:,|—|–|\||·)\s*([A-Z0-9][\w.&'’-]*(?:\s+[A-Z0-9][\w.&'’-]*){0,3})/g;
  const re = /(?:founder|ceo|chief executive officer|managing director|owner|president)[^.\n"“]{0,25}?\s(?:at|of|@)\s+([A-Z0-9][\w.&'’-]*(?:\s+[A-Z0-9][\w.&'’-]*){0,2})/gi;
  const matches = [...text.matchAll(re), ...[...text.matchAll(commaRe)].filter((m) => !ROLE_WORDS.test(m[1]))];
  for (const m of matches) {
    const org = m[1].toLowerCase().replace(/[^a-z0-9 ]/g, "");
    if (!org || org.startsWith("the company") || org === "our company") continue;
    const compact = org.replace(/\s+/g, "");
    if (compact.includes(rootWord) || rootWord.includes(compact)) continue;
    if ([...siteNames].some((n) => n.replace(/[^a-z0-9]/g, "").includes(compact) || compact.includes(n.replace(/[^a-z0-9]/g, "")))) continue;
    if (name.toLowerCase().includes(org)) continue;
    return true;
  }
  return false;
}

type EmailSighting = { email: string; pageUrl: string; context: string; viaMailto: boolean };

/**
 * Builds the ranked contact list in the required fallback order:
 *  1. Founder's email   2. Any email published on the site   3. Any other contact method.
 * Nothing is guessed: every contact was literally found on the site, with its source page.
 */
export async function discoverContacts(
  pages: CrawledPage[],
  siteDomain: string,
  extraFounders: DiscoveredFounder[] = [],
  opts: { checkMx?: boolean } = {},
): Promise<DiscoveryResult> {
  const checkMx = opts.checkMx !== false;
  const ok = pages.filter((p) => p.extract);
  const root = siteKey(siteDomain);

  // ---- founders
  const siteNames = new Set(ok.flatMap((p) => [p.extract!.orgName, p.extract!.siteName].filter(Boolean).map((n) => n!.toLowerCase())));
  const founderMap = new Map<string, DiscoveredFounder>();
  const methodRank = { jsonld: 0, dom: 1, ai: 2, pattern: 3 } as const;
  const rootWord = root.split(".")[0].toLowerCase();
  const addFounder = (f: DiscoveredFounder) => {
    if (!/founder|ceo|chief executive|managing director|owner|president/i.test(f.title)) return;
    if (/\n/.test(f.name)) return;
    if (worksElsewhere(`${f.title} ${f.evidence}`, f.name, rootWord, siteNames)) return;
    const k = f.name.toLowerCase().replace(/[^a-zÀ-ɏ]/g, "");
    const prev = founderMap.get(k);
    if (!prev || methodRank[f.method] < methodRank[prev.method] || (/founder/i.test(f.title) && !/founder/i.test(prev.title))) founderMap.set(k, f);
  };
  const NOISY = /\/(testimonials?|customers?|case-stud|reviews?|wall-of-love|love|stories|blog|news|changelog|archive|posts?|articles?|podcast|episodes?|events?|jobs?|careers?)(\/|$)/i;
  for (const p of ok) {
    let path = "/";
    try {
      path = new URL(p.url).pathname;
    } catch {}
    for (const person of p.extract!.people) {
      // Structured data is explicit; text/DOM hits on testimonial or content pages are usually other people.
      if (person.method !== "jsonld" && NOISY.test(path)) continue;
      addFounder({ ...person, sourceUrl: p.url });
    }
  }
  for (const f of extraFounders) addFounder(f);
  // Founders first, then CEO / others
  const founders = [...founderMap.values()]
    .sort((a, b) => Number(/founder/i.test(b.title)) - Number(/founder/i.test(a.title)) || methodRank[a.method] - methodRank[b.method])
    .slice(0, 8);

  // ---- emails
  const sightings = new Map<string, EmailSighting[]>();
  for (const p of ok) {
    for (const e of p.extract!.emails) {
      const list = sightings.get(e.email) ?? [];
      list.push({ email: e.email, pageUrl: p.url, context: e.context, viaMailto: e.viaMailto });
      sightings.set(e.email, list);
    }
  }

  const contacts: DiscoveredContact[] = [];
  for (const [email, seen] of sightings) {
    const [local, domain] = email.split("@");
    const brand = (d: string) => {
      const parts = d.split(".");
      return parts.length >= 3 && /^(co|com|org|net|ac|gov)$/.test(parts[parts.length - 2]) ? parts[parts.length - 3] : parts[parts.length - 2];
    };
    // Same domain, a subdomain, or the same brand on another TLD (acme.com site, @acme.io mail).
    const onSiteDomain = siteKey(domain) === root || domain.endsWith(`.${root}`) || (brand(domain) === brand(root) && brand(root).length >= 4 && !/^mg$|^mail$|^email$/.test(domain.split(".")[0]));
    const freeMail = /^(gmail|googlemail|outlook|hotmail|live|yahoo|icloud|me|proton|protonmail|pm|hey|fastmail|zoho|aol|gmx|yandex)\./i.test(domain);
    if (!onSiteDomain && !freeMail) {
      // An address on another company's domain (agency, vendor, a customer in a blog post) is not this company's contact,
      // unless it clearly belongs to one of the founders.
      if (!founders.some((f) => localMatchesName(local, f.name))) continue;
    }
    const flatLocal = local.replace(/[^a-z]/g, "");
    let tier: ContactTier = "company_email";
    let rank = 100;
    let confidence: DiscoveredContact["confidence"] = "medium";
    let label = "Email listed on the website";
    let founderName: string | undefined;

    const matched = founders.find((f) => localMatchesName(local, f.name));
    const nearFounder = founders.find((f) => seen.some((s) => s.context.toLowerCase().includes(f.name.toLowerCase()) || s.context.toLowerCase().includes(nameTokens(f.name).last)));
    if (matched) {
      tier = "founder_email";
      rank = 1;
      confidence = onSiteDomain || freeMail ? "high" : "medium";
      founderName = matched.name;
      label = `${matched.name} (${matched.title}) — personal email`;
    } else if (FOUNDER_ROLE_LOCALS.has(flatLocal) && onSiteDomain) {
      tier = "founder_email";
      rank = 3;
      confidence = "medium";
      label = `Founder/CEO mailbox (${local}@)`;
    } else if (nearFounder && isPersonalLooking(local) && onSiteDomain) {
      tier = "founder_email";
      rank = 4;
      confidence = "medium";
      founderName = nearFounder.name;
      label = `Personal email listed next to ${nearFounder.name} (${nearFounder.title})`;
    } else if (isPersonalLooking(local) && onSiteDomain) {
      rank = 10;
      label = "Named mailbox on the website (owner not identified)";
      confidence = "medium";
    } else {
      rank = 10 + (GENERIC_LOCALS[flatLocal] ?? 35);
      label = GENERIC_LOCALS[flatLocal] !== undefined && GENERIC_LOCALS[flatLocal] >= 60 ? `Department email (${local}@) — not ideal for sales outreach` : `General inbox (${local}@)`;
      confidence = GENERIC_LOCALS[flatLocal] !== undefined && GENERIC_LOCALS[flatLocal] >= 60 ? "low" : "medium";
    }
    if (!onSiteDomain && !freeMail) {
      rank += 20;
      confidence = "low";
      label += " — on a different domain";
    }
    const src = seen.find((s) => s.viaMailto) ?? seen[0];
    contacts.push({ kind: "email", value: email, label, tier, rank, confidence, sourceUrl: src.pageUrl, founderName, isValid: true, mxValid: null });
  }

  // ---- MX verification (flags incorrect/undeliverable addresses)
  if (checkMx) {
    await Promise.all(
      contacts.map(async (c) => {
        const res = await checkMailDomain(c.value.split("@")[1]);
        c.mxValid = res.ok;
        if (res.ok === false) {
          c.isValid = false;
          c.invalidReason = res.reason;
          c.rank += 200;
          c.confidence = "low";
        }
      }),
    );
  }

  // ---- other contact methods
  const seenOther = new Set<string>();
  const addOther = (c: Omit<DiscoveredContact, "tier" | "isValid">) => {
    const key = `${c.kind}:${c.value.toLowerCase()}`;
    if (seenOther.has(key)) return;
    seenOther.add(key);
    contacts.push({ ...c, tier: "other_contact", isValid: true });
  };
  const formPages = ok
    .filter((p) => p.extract!.hasContactForm)
    .map((p) => {
      const u = new URL(p.url);
      u.search = "";
      return { url: u.href, isContact: /contact|support|demo|talk|sales/i.test(u.pathname) };
    })
    .sort((a, b) => Number(b.isContact) - Number(a.isContact));
  for (const f of formPages.slice(0, 3)) addOther({ kind: "contact_form", value: f.url, label: f.isContact ? "Contact form" : "Form on the website", rank: f.isContact ? 300 : 306, confidence: f.isContact ? "medium" : "low", sourceUrl: f.url });
  for (const p of ok) {
    // Social links on comparison / blog / deep pages often point at other companies.
    if (p.priority < 50) continue;
    for (const s of p.extract!.socials) {
      const founderLinked = s.personal && founders.find((f) => s.url.toLowerCase().includes(nameTokens(f.name).first) && s.url.toLowerCase().includes(nameTokens(f.name).last));
      const base = { calendly: 305, linkedin: 310, twitter: 320, github: 340, discord: 345, facebook: 350, instagram: 355, youtube: 360 }[s.kind] ?? 370;
      addOther({
        kind: s.kind,
        value: s.url,
        label: founderLinked ? `${founderLinked.name}'s LinkedIn` : s.kind === "linkedin" ? (s.personal ? "Personal LinkedIn profile" : "Company LinkedIn") : s.kind === "calendly" ? "Booking link" : `${s.kind[0].toUpperCase()}${s.kind.slice(1)}`,
        rank: founderLinked ? 302 : base,
        confidence: founderLinked ? "high" : "medium",
        sourceUrl: p.url,
        founderName: founderLinked ? founderLinked.name : undefined,
      });
    }
    for (const ph of p.extract!.phones) addOther({ kind: "phone", value: ph, label: "Phone", rank: 330, confidence: "medium", sourceUrl: p.url });
  }
  // A contact page with no form is still a useful last resort.
  if (!contacts.some((c) => c.kind === "contact_form")) {
    const cp = ok.find((p) => /\/(contact|contact-us|get-in-touch)(\/|$)/i.test(new URL(p.url).pathname));
    if (cp) addOther({ kind: "contact_form", value: cp.url, label: "Contact page", rank: 380, confidence: "low", sourceUrl: cp.url });
  }

  contacts.sort((a, b) => a.rank - b.rank);
  const best = contacts.find((c) => c.isValid) ?? null;
  return { founders, contacts: contacts.slice(0, 40), best, outcome: best ? best.tier : "none" };
}
