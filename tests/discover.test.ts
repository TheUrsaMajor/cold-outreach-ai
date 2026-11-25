import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { extractPage } from "../src/lib/crawler/extract";
import { discoverContacts, localMatchesName } from "../src/lib/contacts/discover";
import type { CrawledPage } from "../src/lib/crawler/crawl";

const page = (url: string, html: string, priority = 100): CrawledPage => ({ url, status: 200, extract: extractPage(html, url), priority, via: "link" });
const about = page("https://ledgerly.io/about", readFileSync(path.join(__dirname, "fixtures/about.html"), "utf8"));

describe("localMatchesName", () => {
  it.each(["priya", "priya.raman", "praman", "priyar", "p.raman", "raman"])("%s matches Priya Raman", (l) => expect(localMatchesName(l, "Priya Raman")).toBe(true));
  it.each(["hello", "support", "tom", "pr"])("%s does not match", (l) => expect(localMatchesName(l, "Priya Raman")).toBe(false));
});

describe("discoverContacts fallback order", () => {
  it("1) founder email first when a founder's address is published", async () => {
    const r = await discoverContacts([about], "ledgerly.io", [], { checkMx: false });
    expect(r.outcome).toBe("founder_email");
    expect(r.best?.value).toBe("priya@ledgerly.io");
    expect(r.best?.founderName).toBe("Priya Raman");
    expect(r.founders.map((f) => f.name)).toEqual(expect.arrayContaining(["Priya Raman", "Tom Becker"]));
    const ranks = r.contacts.map((c) => c.tier);
    // tiers are ordered: founder emails, then company emails, then other contacts
    const order = { founder_email: 0, company_email: 1, other_contact: 2 } as const;
    for (let i = 1; i < ranks.length; i++) expect(order[ranks[i]]).toBeGreaterThanOrEqual(order[ranks[i - 1]]);
  });

  it("2) any company email when no founder email exists", async () => {
    const p = page("https://acmeapp.io/contact", `<html><body><h1>Contact</h1><p>Founded by Jane Doe.</p><a href="mailto:hello@acmeapp.io">hello@acmeapp.io</a> <a href="mailto:privacy@acmeapp.io">privacy</a></body></html>`);
    const r = await discoverContacts([p], "acmeapp.io", [], { checkMx: false });
    expect(r.outcome).toBe("company_email");
    expect(r.best?.value).toBe("hello@acmeapp.io"); // general inbox ranks above privacy@
  });

  it("3) other contact methods when no email exists", async () => {
    const p = page("https://quiet.dev/contact", `<html><body><h1>Talk to us</h1><form><input type="email"><textarea></textarea></form><a href="https://www.linkedin.com/company/quiet">LinkedIn</a><a href="tel:+442071234567">Call</a></body></html>`);
    const r = await discoverContacts([p], "quiet.dev", [], { checkMx: false });
    expect(r.outcome).toBe("other_contact");
    expect(r.best?.kind).toBe("contact_form");
    expect(r.contacts.map((c) => c.kind)).toEqual(expect.arrayContaining(["linkedin", "phone"]));
  });

  it("nothing found -> outcome none, nothing invented", async () => {
    const p = page("https://empty.dev/", `<html><body><h1>Coming soon</h1></body></html>`);
    const r = await discoverContacts([p], "empty.dev", [], { checkMx: false });
    expect(r.outcome).toBe("none");
    expect(r.contacts).toEqual([]);
    expect(r.founders).toEqual([]);
  });

  it("emails on unrelated domains seen only as plain text are ignored", async () => {
    const p = page("https://x.dev/", `<html><body><p>Theme by studio: design@someagency.com</p><p>Email us at team@x.dev</p></body></html>`);
    const r = await discoverContacts([p], "x.dev", [], { checkMx: false });
    expect(r.contacts.map((c) => c.value)).toEqual(["team@x.dev"]);
  });

  it("AI-verified founders unlock founder email matches", async () => {
    const p = page("https://solo.dev/", `<html><body><p>Questions? Write to marco@solo.dev</p></body></html>`);
    const r = await discoverContacts([p], "solo.dev", [{ name: "Marco Rossi", title: "Founder", sourceUrl: "https://solo.dev/", evidence: "", method: "ai" }], { checkMx: false });
    expect(r.best?.tier).toBe("founder_email");
  });
});
