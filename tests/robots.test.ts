import { describe, expect, it } from "vitest";
import { isAllowed, parseRobots } from "../src/lib/crawler/robots";

describe("robots.txt", () => {
  const txt = `
User-agent: *
Disallow: /private
Disallow: /*.json$
Allow: /private/public-page
Sitemap: https://acme.com/sitemap.xml

User-agent: GPTBot
Disallow: /
`;
  const r = parseRobots(txt);
  it("reads sitemaps", () => expect(r.sitemaps).toEqual(["https://acme.com/sitemap.xml"]));
  it("applies longest match", () => {
    expect(isAllowed(r, "/about")).toBe(true);
    expect(isAllowed(r, "/private/x")).toBe(false);
    expect(isAllowed(r, "/private/public-page")).toBe(true);
    expect(isAllowed(r, "/data.json")).toBe(false);
    expect(isAllowed(r, "/data.json?x=1")).toBe(true);
  });
  it("uses a specific group for our bot when present", () => {
    const r2 = parseRobots("User-agent: FounderResearchBot\nDisallow: /\n\nUser-agent: *\nAllow: /");
    expect(isAllowed(r2, "/")).toBe(false);
  });
  it("empty disallow allows everything", () => {
    expect(isAllowed(parseRobots("User-agent: *\nDisallow:"), "/anything")).toBe(true);
  });
  it("disallow all", () => {
    expect(isAllowed(parseRobots("User-agent: *\nDisallow: /"), "/about")).toBe(false);
  });
});
