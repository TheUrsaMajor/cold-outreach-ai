import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { cleanEmail, decodeCfEmail, deobfuscate, extractPage, findPeopleInText, looksLikeName, classifySocial } from "../src/lib/crawler/extract";

const html = readFileSync(path.join(__dirname, "fixtures/about.html"), "utf8");
const page = extractPage(html, "https://ledgerly.io/about");

describe("extractPage", () => {
  it("gets title, description and site name", () => {
    expect(page.title).toBe("About us | Ledgerly");
    expect(page.description).toMatch(/subscription analytics/);
    expect(page.siteName).toBe("Ledgerly");
    expect(page.orgName).toBe("Ledgerly");
  });
  it("finds emails from mailto, text, obfuscation, JSON-LD and Cloudflare", () => {
    const emails = page.emails.map((e) => e.email).sort();
    expect(emails).toContain("support@ledgerly.io");
    expect(emails).toContain("priya@ledgerly.io");
    expect(emails).toContain("hello@ledgerly.io");
    expect(emails).toContain("julia@ledgerly.io");
    expect(emails).toContain("press@ledgerly.io");
  });
  it("ignores junk emails (scripts, retina images, placeholders, site builders)", () => {
    const emails = page.emails.map((e) => e.email);
    expect(emails).not.toContain("ignore@script.com");
    expect(emails.some((e) => e.includes("@2x") || e.includes("@3x"))).toBe(false);
    expect(emails).not.toContain("you@example.com");
    expect(emails).not.toContain("hello@wixpress.com");
  });
  it("finds founders with titles and not other staff", () => {
    const names = page.people.map((p) => p.name);
    expect(names).toContain("Priya Raman");
    expect(names).toContain("Tom Becker");
    expect(names).not.toContain("Maya Lin");
  });
  it("finds socials, phone and contact form", () => {
    const kinds = page.socials.map((s) => s.kind);
    expect(kinds).toEqual(expect.arrayContaining(["linkedin", "twitter", "github"]));
    expect(page.socials.find((s) => s.url.includes("/in/"))?.personal).toBe(true);
    expect(page.socials.some((s) => s.url.includes("intent"))).toBe(false);
    expect(page.phones.length).toBeGreaterThan(0);
    expect(page.hasContactForm).toBe(true);
  });
  it("collects links for crawling", () => {
    expect(page.links).toEqual(expect.arrayContaining(["/pricing", "/team", "/contact"]));
  });
});

describe("helpers", () => {
  it("decodes Cloudflare emails", () => expect(decodeCfEmail("2e445b42474f6e424b4a494b5c4257004741")).toBe("julia@ledgerly.io"));
  it("rejects bad hex", () => expect(decodeCfEmail("zz")).toBeNull());
  it("deobfuscates", () => {
    expect(deobfuscate("jane [at] acme [dot] com")).toBe("jane@acme.com");
    expect(deobfuscate("jane(at)acme.com")).toBe("jane@acme.com");
    expect(deobfuscate("jane at acme dot io")).toBe("jane@acme.io");
  });
  it("cleans emails", () => {
    expect(cleanEmail("MAILTO:Jane@Ledgerly.io?subject=hi")).toBe("jane@ledgerly.io");
    expect(cleanEmail("noreply@ledgerly.io")).toBeNull();
    expect(cleanEmail("a1b2c3d4e5f6a7b8c9d0@o123.ingest.sentry.io")).toBeNull();
    expect(cleanEmail("not-an-email")).toBeNull();
  });
  it("name heuristics", () => {
    expect(looksLikeName("Priya Raman")).toBe(true);
    expect(looksLikeName("Meet The Team")).toBe(false);
    expect(looksLikeName("Our Story")).toBe(false);
    expect(looksLikeName("Ludwig van Beethoven")).toBe(true);
  });
  it("text patterns", () => {
    const p = findPeopleInText("Hi, I'm the maker. Jane Doe, Founder & CEO of Acme. Our CTO is Bob. CEO: Sam Altmanson");
    const names = p.map((x) => x.name);
    expect(names).toContain("Jane Doe");
    expect(names).toContain("Sam Altmanson");
  });
  it("social classification", () => {
    expect(classifySocial("https://twitter.com/share?url=x")).toBeNull();
    expect(classifySocial("https://www.facebook.com/sharer/sharer.php?u=x")).toBeNull();
    expect(classifySocial("https://calendly.com/jane/30min")?.kind).toBe("calendly");
  });
});

describe("booking links", () => {
  it("accepts personal booking links and rejects vendor marketing pages", () => {
    expect(classifySocial("https://calendly.com/jane-doe/intro")?.kind).toBe("calendly");
    expect(classifySocial("https://cal.com/derrick")?.kind).toBe("calendly");
    expect(classifySocial("https://calendly.com/pricing")).toBeNull();
    expect(classifySocial("https://calendly.com/help/payments-faq")).toBeNull();
  });
});
