import { Agent, ProxyAgent, fetch as undiciFetch, type Dispatcher } from "undici";
import { lookup as dnsLookup } from "node:dns";
import { isIP } from "node:net";
import { assertHostnameShape, isPrivateIp, UrlValidationError } from "./url";

export const BOT_NAME = "FounderResearchBot";
export const USER_AGENT = `Mozilla/5.0 (compatible; ${BOT_NAME}/1.0; public-website research for B2B outreach)`;

/**
 * A DNS lookup that refuses private addresses. Used at connect time so DNS
 * rebinding (public at check, private at connect) cannot reach internal hosts.
 */
function guardedLookup(
  hostname: string,
  options: object,
  callback: (err: NodeJS.ErrnoException | null, address: string | { address: string; family: number }[], family?: number) => void,
) {
  dnsLookup(hostname, { ...(options as object), all: true }, (err, addresses) => {
    if (err) return callback(err, "", 0);
    const list = (addresses as unknown as { address: string; family: number }[]) || [];
    const bad = list.find((a) => isPrivateIp(a.address));
    if (!list.length || bad) {
      const e = new Error(`Blocked private address for ${hostname}`) as NodeJS.ErrnoException;
      e.code = "EBLOCKED";
      return callback(e, "", 0);
    }
    if ((options as { all?: boolean }).all) return callback(null, list);
    callback(null, list[0].address, list[0].family);
  });
}

/**
 * CRAWLER_USE_PROXY=1 is only for local development behind an egress proxy that
 * resolves DNS itself. Production never sets it, so every connection goes
 * through the private-address guard above.
 */
const useProxy = process.env.CRAWLER_USE_PROXY === "1" && !!process.env.HTTPS_PROXY && process.env.VERCEL !== "1";
const agent: Dispatcher = useProxy
  ? new ProxyAgent({ uri: process.env.HTTPS_PROXY!, headersTimeout: 10000, bodyTimeout: 10000 })
  : new Agent({
      connect: { lookup: guardedLookup as never, timeout: 6000 },
      headersTimeout: 10000,
      bodyTimeout: 10000,
      connections: 32,
    });

export type FetchResult = {
  url: string;
  status: number;
  contentType: string;
  text: string;
  truncated: boolean;
  redirected: boolean;
};

export class FetchError extends Error {
  constructor(message: string, public readonly kind: "timeout" | "network" | "blocked" | "http" | "too_large" | "not_html", public readonly status?: number) {
    super(message);
    this.name = "FetchError";
  }
}

export type SafeFetchOptions = {
  timeoutMs?: number;
  maxBytes?: number;
  maxRedirects?: number;
  accept?: string;
  /** Throw unless the response is HTML/XHTML (or text when allowText). */
  requireHtml?: boolean;
  allowText?: boolean;
  signal?: AbortSignal;
};

/** Fetch a public URL with SSRF protection, redirect checks, a timeout and a size cap. */
export async function safeFetch(input: string | URL, opts: SafeFetchOptions = {}): Promise<FetchResult> {
  const { timeoutMs = 8000, maxBytes = 1_500_000, maxRedirects = 5, accept = "text/html,application/xhtml+xml;q=0.9,*/*;q=0.5" } = opts;
  let current = new URL(input.toString());
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onOuterAbort = () => controller.abort();
  opts.signal?.addEventListener("abort", onOuterAbort);
  try {
    for (let hop = 0; hop <= maxRedirects; hop++) {
      if (current.protocol !== "http:" && current.protocol !== "https:") throw new FetchError("Unsupported redirect protocol", "blocked");
      if (current.username || current.password) throw new FetchError("Credentials in URL are not allowed", "blocked");
      try {
        assertHostnameShape(current.hostname);
      } catch (e) {
        throw new FetchError((e as Error).message, "blocked");
      }
      const bare = current.hostname.replace(/^\[|\]$/g, "");
      if (isIP(bare) && isPrivateIp(bare)) throw new FetchError("Blocked private address", "blocked");

      let res;
      try {
        res = await undiciFetch(current, {
          dispatcher: agent,
          redirect: "manual",
          signal: controller.signal,
          headers: {
            "user-agent": USER_AGENT,
            accept,
            "accept-language": "en-US,en;q=0.8",
          },
        });
      } catch (e) {
        const err = e as Error & { cause?: { code?: string; message?: string } };
        if (controller.signal.aborted) throw new FetchError("Timed out", "timeout");
        if (err.cause?.code === "EBLOCKED") throw new FetchError("Blocked private address", "blocked");
        const code = err.cause?.code ? ` (${err.cause.code})` : "";
        throw new FetchError(`Could not connect${code}`, "network");
      }

      if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
        await res.body?.cancel().catch(() => {});
        const next = new URL(res.headers.get("location")!, current);
        current = next;
        continue;
      }

      const contentType = (res.headers.get("content-type") || "").toLowerCase();
      if (opts.requireHtml && res.ok) {
        const isHtml = contentType.includes("html") || contentType === "";
        const isText = contentType.startsWith("text/") || contentType.includes("xml");
        if (!isHtml && !(opts.allowText && isText)) {
          await res.body?.cancel().catch(() => {});
          throw new FetchError(`Not an HTML page (${contentType || "unknown type"})`, "not_html", res.status);
        }
      }
      const declared = Number(res.headers.get("content-length") || 0);
      if (declared && declared > maxBytes * 4) {
        await res.body?.cancel().catch(() => {});
        throw new FetchError("Page too large", "too_large", res.status);
      }

      let received = 0;
      let truncated = false;
      const chunks: Uint8Array[] = [];
      if (res.body) {
        const reader = res.body.getReader();
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          received += value.byteLength;
          if (received > maxBytes) {
            chunks.push(value.subarray(0, value.byteLength - (received - maxBytes)));
            truncated = true;
            await reader.cancel().catch(() => {});
            break;
          }
          chunks.push(value);
        }
      }
      const buf = Buffer.concat(chunks.map((c) => Buffer.from(c)));
      const charset = /charset=([\w-]+)/i.exec(contentType)?.[1]?.toLowerCase();
      let text: string;
      try {
        text = new TextDecoder(charset && charset !== "utf8" ? charset : "utf-8", { fatal: false }).decode(buf);
      } catch {
        text = buf.toString("utf8");
      }
      return { url: current.href, status: res.status, contentType, text, truncated, redirected: hop > 0 };
    }
    throw new FetchError("Too many redirects", "network");
  } catch (e) {
    if (e instanceof FetchError) throw e;
    if (e instanceof UrlValidationError) throw new FetchError(e.message, "blocked");
    if (controller.signal.aborted) throw new FetchError("Timed out", "timeout");
    throw new FetchError((e as Error).message || "Fetch failed", "network");
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener("abort", onOuterAbort);
  }
}
