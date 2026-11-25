import { describe, expect, it } from "vitest";
import { csvCell, extractSites, parseCsv, toCsv } from "../src/lib/csv";

describe("csv writing", () => {
  it("quotes commas, quotes and newlines", () => {
    expect(csvCell('Hi, "there"\nok')).toBe('"Hi, ""there""\nok"');
    expect(csvCell(null)).toBe("");
    expect(csvCell(42)).toBe("42");
  });
  it("neutralises spreadsheet formulas", () => {
    expect(csvCell("=HYPERLINK(\"http://evil\")")).toBe("\"'=HYPERLINK(\"\"http://evil\"\")\"");
    expect(csvCell("+1 555")).toBe("'+1 555");
    expect(csvCell("@cmd")).toBe("'@cmd");
  });
  it("round-trips through the parser", () => {
    const doc = toCsv(["a", "b"], [["x, y", 'say "hi"'], ["line\nbreak", null]]);
    expect(parseCsv(doc)).toEqual([["a", "b"], ["x, y", 'say "hi"'], ["line\nbreak", ""]]);
  });
});

describe("extractSites", () => {
  it("uses a website column when there is a header", () => {
    const r = extractSites("Company,Website,Notes\nPlausible,plausible.io,hi\nFathom,https://usefathom.com/,\n");
    expect(r.sites).toEqual(["plausible.io", "https://usefathom.com/"]);
  });
  it("takes a plain list, one per line, and dedupes www/protocol/case", () => {
    const r = extractSites("plausible.io\nhttps://www.Plausible.io\nbuttondown.com\n\n");
    expect(r.sites).toEqual(["plausible.io", "buttondown.com"]);
  });
  it("finds the site cell without a header and turns emails into domains", () => {
    const r = extractSites("Acme Inc,founder@ledgerly.io\nBeta,beta.dev");
    expect(r.sites).toEqual(["ledgerly.io", "beta.dev"]);
  });
  it("reports rows it can't use and caps the list", () => {
    const r = extractSites("website\nnot a site\nexample.com\nfoo.com\nbar.com", 2);
    expect(r.skipped).toEqual(["not a site"]);
    expect(r.sites).toEqual(["example.com", "foo.com"]);
    expect(r.truncated).toBe(1);
  });
  it("keeps semicolons inside a comma CSV", () => {
    expect(parseCsv("a,b\nx; y,z")).toEqual([["a", "b"], ["x; y", "z"]]);
  });
  it("handles semicolon CSVs from Excel and a BOM", () => {
    const r = extractSites("﻿Name;URL\nA;a-site.com\n");
    expect(r.sites).toEqual(["a-site.com"]);
  });
});
