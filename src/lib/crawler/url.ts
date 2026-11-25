import { isIP } from "node:net";
import { lookup } from "node:dns/promises";

export class UrlValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UrlValidationError";
  }
}

const BLOCKED_HOST_SUFFIXES = [".local", ".localhost", ".internal", ".lan", ".home", ".corp", ".intranet", ".arpa"];

/**
 * Normalise what a user typed into a canonical https URL for a public website.
 * Throws UrlValidationError with a human readable message when invalid.
 */
export function normalizeInputUrl(input: string): URL {
  if (typeof input !== "string") throw new UrlValidationError("Enter a website address.");
  let raw = input.trim();
  if (!raw) throw new UrlValidationError("Enter a website address.");
  if (raw.length > 2048) throw new UrlValidationError("That address is too long.");
  if (/\s/.test(raw)) throw new UrlValidationError("A website address can't contain spaces.");
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) {
    if (/^[a-z][a-z0-9+.-]*:/i.test(raw) && !/^[^:]+:\d+/.test(raw)) {
      throw new UrlValidationError("Only http and https websites are supported.");
    }
    raw = `https://${raw}`;
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new UrlValidationError("That doesn't look like a valid website address.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new UrlValidationError("Only http and https websites are supported.");
  }
  if (url.username || url.password) throw new UrlValidationError("Addresses with login details aren't allowed.");
  if (url.port && url.port !== "80" && url.port !== "443") {
    throw new UrlValidationError("Only websites on standard ports (80/443) can be researched.");
  }
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  assertHostnameShape(host);
  url.hostname = host;
  url.hash = "";
  return url;
}

export function assertHostnameShape(host: string) {
  if (!host) throw new UrlValidationError("Missing domain name.");
  const bare = host.replace(/^\[|\]$/g, "");
  if (isIP(bare)) {
    if (isPrivateIp(bare)) throw new UrlValidationError("Private or internal network addresses can't be researched.");
    return;
  }
  if (host === "localhost" || BLOCKED_HOST_SUFFIXES.some((s) => host.endsWith(s))) {
    throw new UrlValidationError("Private or internal network addresses can't be researched.");
  }
  if (!host.includes(".")) throw new UrlValidationError("Enter a full domain, like example.com.");
  if (!/^[a-z0-9.-]+$/.test(host) && !/^xn--/.test(host)) {
    // Allow IDNs (URL already punycodes them), reject anything else odd.
    if (!/^[a-z0-9.\-]+$/i.test(host)) throw new UrlValidationError("That domain contains invalid characters.");
  }
  const tld = host.split(".").pop() ?? "";
  if (!/^(xn--[a-z0-9-]+|[a-z]{2,63})$/.test(tld)) throw new UrlValidationError("That domain doesn't have a valid ending (like .com).");
}

/** True for loopback, private, link-local, CGNAT, multicast, reserved and metadata ranges. */
export function isPrivateIp(ip: string): boolean {
  const v = isIP(ip);
  if (v === 4) return isPrivateV4(ip);
  if (v === 6) {
    const lower = ip.toLowerCase();
    const mapped = lower.match(/^(?:0*:)*:?ffff:(\d+\.\d+\.\d+\.\d+)$/) || lower.match(/^::(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isPrivateV4(mapped[1]);
    const hexMapped = lower.match(/^(?:0*:)*:?ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
    if (hexMapped) {
      const hi = parseInt(hexMapped[1], 16);
      const lo = parseInt(hexMapped[2], 16);
      return isPrivateV4(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
    }
    if (lower === "::" || lower === "::1") return true;
    const first = parseInt(lower.split(":")[0] || "0", 16);
    if ((first & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
    if ((first & 0xffc0) === 0xfe80) return true; // fe80::/10 link local
    if ((first & 0xff00) === 0xff00) return true; // multicast
    if (lower.startsWith("64:ff9b:")) return true; // NAT64 (could reach v4 private)
    if (lower.startsWith("2001:db8") || lower.startsWith("2001:0db8")) return true; // documentation
    return false;
  }
  return true; // not an IP at all: treat as unsafe
}

function isPrivateV4(ip: string): boolean {
  const p = ip.split(".").map(Number);
  if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  const [a, b] = p;
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  if (a === 169 && b === 254) return true; // link local / cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 192 && b === 0 && (p[2] === 0 || p[2] === 2)) return true;
  if (a === 198 && (b === 18 || b === 19)) return true;
  if (a === 198 && b === 51 && p[2] === 100) return true;
  if (a === 203 && b === 0 && p[2] === 113) return true;
  if (a >= 224) return true; // multicast + reserved + broadcast
  return false;
}

/** Resolve a hostname and make sure every address is public. Returns the addresses. */
export async function assertPublicHost(hostname: string): Promise<string[]> {
  assertHostnameShape(hostname);
  const bare = hostname.replace(/^\[|\]$/g, "");
  if (isIP(bare)) return [bare];
  // Local development behind a DNS-resolving egress proxy (never set in production).
  if (process.env.CRAWLER_USE_PROXY === "1" && process.env.VERCEL !== "1") return [];
  let records: { address: string; family: number }[];
  try {
    records = await lookup(bare, { all: true, verbatim: true });
  } catch {
    throw new UrlValidationError(`The domain ${hostname} could not be found. Check the spelling.`);
  }
  if (!records.length) throw new UrlValidationError(`The domain ${hostname} could not be found.`);
  for (const r of records) {
    if (isPrivateIp(r.address)) {
      throw new UrlValidationError("That domain points to a private network address and can't be researched.");
    }
  }
  return records.map((r) => r.address);
}

/** example.com for www.example.com; used for dedupe and same-site checks. */
export function siteKey(hostname: string): string {
  return hostname.toLowerCase().replace(/^www\d?\./, "").replace(/\.$/, "");
}

export function isSameSite(a: string, b: string): boolean {
  return siteKey(a) === siteKey(b);
}

const SKIP_EXT = /\.(?:pdf|jpe?g|png|gif|webp|avif|svg|ico|bmp|tiff?|mp4|mov|avi|webm|mp3|wav|ogg|zip|gz|tgz|rar|7z|dmg|exe|msi|pkg|apk|iso|css|js|mjs|json|xml|rss|atom|txt|csv|xlsx?|docx?|pptx?|woff2?|ttf|eot|otf|map)$/i;

/** Canonicalise a link found on a page. Returns null if it shouldn't be crawled. */
export function canonicalizeLink(href: string, base: URL, siteHost: string): URL | null {
  if (!href) return null;
  const h = href.trim();
  if (!h || h.startsWith("#") || /^(mailto|tel|javascript|data|sms|ftp|file|blob):/i.test(h)) return null;
  let u: URL;
  try {
    u = new URL(h, base);
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  if (u.username || u.password) return null;
  if (!isSameSite(u.hostname, siteHost)) return null;
  if (u.port && u.port !== "80" && u.port !== "443") return null;
  if (SKIP_EXT.test(u.pathname)) return null;
  if (/\/(wp-admin|wp-json|wp-login|cdn-cgi|cart|checkout|login|signin|sign-in|signup|sign-up|register|logout|account|admin|feed|xmlrpc)(\/|$)/i.test(u.pathname)) return null;
  u.hash = "";
  // Drop tracking/query noise; keep at most simple pagination-free URLs.
  const keep = new URLSearchParams();
  for (const [k, v] of u.searchParams) {
    if (/^(utm_|ref$|fbclid|gclid|mc_|_hs|hsa_|source$)/i.test(k)) continue;
    keep.set(k, v);
  }
  if ([...keep.keys()].length > 1) return null; // likely faceted / infinite URLs
  u.search = keep.toString() ? `?${keep.toString()}` : "";
  u.hostname = u.hostname.toLowerCase();
  if (u.pathname.length > 1) u.pathname = u.pathname.replace(/\/+$/, "") || "/";
  if (u.href.length > 500) return null;
  return u;
}

export function urlKey(u: URL): string {
  return `${siteKey(u.hostname)}${u.pathname.replace(/\/+$/, "") || "/"}${u.search}`.toLowerCase();
}
