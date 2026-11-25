import { describe, expect, it } from "vitest";
import { canonicalizeLink, isPrivateIp, normalizeInputUrl, siteKey, UrlValidationError } from "../src/lib/crawler/url";

describe("normalizeInputUrl", () => {
  it("adds https and lowercases the host", () => {
    expect(normalizeInputUrl("  Acme.COM/about ").href).toBe("https://acme.com/about");
  });
  it("keeps http when given", () => {
    expect(normalizeInputUrl("http://acme.io").protocol).toBe("http:");
  });
  it.each([
    ["", "Enter a website"],
    ["not a url", "spaces"],
    ["ftp://acme.com", "Only http"],
    ["javascript:alert(1)", "Only http"],
    ["localhost:3000", "standard ports"],
    ["http://localhost", "Private"],
    ["http://127.0.0.1", "Private"],
    ["http://10.0.0.5/admin", "Private"],
    ["http://169.254.169.254/latest/meta-data", "Private"],
    ["http://[::1]/", "Private"],
    ["http://192.168.1.1", "Private"],
    ["https://user:pass@acme.com", "login details"],
    ["https://acme.com:8443", "standard ports"],
    ["https://intranet", "full domain"],
    ["https://printer.local", "Private"],
    ["https://acme.c0m", "valid ending"],
  ])("rejects %s", (input, msg) => {
    expect(() => normalizeInputUrl(input)).toThrow(UrlValidationError);
    expect(() => normalizeInputUrl(input)).toThrow(new RegExp(msg, "i"));
  });
});

describe("isPrivateIp", () => {
  it.each(["127.0.0.1", "10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.0.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "224.0.0.1", "::1", "fc00::1", "fe80::1", "::ffff:127.0.0.1", "::ffff:7f00:1", "64:ff9b::a00:1"])(
    "%s is private",
    (ip) => expect(isPrivateIp(ip)).toBe(true),
  );
  it.each(["8.8.8.8", "1.1.1.1", "172.32.0.1", "2606:4700:4700::1111", "93.184.216.34"])("%s is public", (ip) => expect(isPrivateIp(ip)).toBe(false));
});

describe("canonicalizeLink", () => {
  const base = new URL("https://www.acme.com/about");
  it("keeps same-site pages and strips tracking", () => {
    expect(canonicalizeLink("/team/?utm_source=x#top", base, "www.acme.com")?.href).toBe("https://www.acme.com/team");
    expect(canonicalizeLink("https://acme.com/contact", base, "www.acme.com")?.href).toBe("https://acme.com/contact");
  });
  it("drops off-site, assets, mailto and auth pages", () => {
    expect(canonicalizeLink("https://twitter.com/acme", base, "www.acme.com")).toBeNull();
    expect(canonicalizeLink("/logo.png", base, "www.acme.com")).toBeNull();
    expect(canonicalizeLink("/whitepaper.pdf", base, "www.acme.com")).toBeNull();
    expect(canonicalizeLink("mailto:a@acme.com", base, "www.acme.com")).toBeNull();
    expect(canonicalizeLink("/login", base, "www.acme.com")).toBeNull();
    expect(canonicalizeLink("javascript:void(0)", base, "www.acme.com")).toBeNull();
  });
  it("siteKey strips www", () => expect(siteKey("WWW.Acme.com")).toBe("acme.com"));
});
