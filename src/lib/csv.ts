/**
 * CSV helpers shared by export (server) and import (browser). No dependencies.
 */

export type Cell = string | number | boolean | null | undefined;

/** Escape one cell. Cells that start like a formula are prefixed with ' so Excel/Sheets don't execute them. */
export function csvCell(v: Cell): string {
  if (v === null || v === undefined) return "";
  let s = String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Build a CSV document (CRLF line endings, as RFC 4180 and Excel expect). */
export function toCsv(header: string[], rows: Cell[][]): string {
  return [header, ...rows].map((r) => r.map(csvCell).join(",")).join("\r\n") + "\r\n";
}

/** Parse CSV text into rows of cells. Handles quoted cells, escaped quotes and newlines inside quotes. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  const src = text.replace(/^﻿/, "");
  const nl = src.search(/[\r\n]/);
  const firstLine = nl < 0 ? src : src.slice(0, nl);
  const delim = [",", ";", "\t"].map((d) => ({ d, n: firstLine.split(d).length })).sort((a, b) => b.n - a.n)[0];
  const sep = delim.n > 1 ? delim.d : ",";
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          cell += '"';
          i++;
        } else quoted = false;
      } else cell += ch;
      continue;
    }
    if (ch === '"' && cell === "") quoted = true;
    else if (ch === sep) {
      row.push(cell);
      cell = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && src[i + 1] === "\n") i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else cell += ch;
  }
  if (cell !== "" || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows.map((r) => r.map((c) => c.trim())).filter((r) => r.some(Boolean));
}

const SITE_HEADER = /^(website|web site|url|site|domain|company website|company url|homepage|home page|company domain)$/i;
const LOOKS_LIKE_SITE = /^(https?:\/\/)?(www\.)?[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*\.[a-z]{2,}(:\d+)?(\/\S*)?$/i;

export type SiteListResult = { sites: string[]; skipped: string[]; truncated: number };

/** Normalise a cell to a bare host (plus path if any) for display and dedupe. */
export function siteKeyOf(value: string): string {
  return value
    .trim()
    .replace(/^https?:\/\//i, "")
    .replace(/^www\./i, "")
    .replace(/[/?#].*$/, "")
    .toLowerCase();
}

/**
 * Pull prospect websites out of a CSV (or a plain list, one per line).
 * Uses a "website"/"url"/"domain" column when there is a header; otherwise the first cell
 * in each row that looks like a site. Email addresses are turned into their domain.
 */
export function extractSites(text: string, max = 50): SiteListResult {
  const rows = parseCsv(text);
  if (!rows.length) return { sites: [], skipped: [], truncated: 0 };
  const headerIdx = rows[0].findIndex((c) => SITE_HEADER.test(c));
  const body = headerIdx >= 0 ? rows.slice(1) : rows;
  const seen = new Set<string>();
  const sites: string[] = [];
  const skipped: string[] = [];
  let truncated = 0;
  for (const r of body) {
    let candidate: string | undefined;
    if (headerIdx >= 0) candidate = r[headerIdx];
    else candidate = r.find((c) => LOOKS_LIKE_SITE.test(c) || /^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test(c));
    if (candidate && /^[^@\s]+@([^@\s]+\.[a-z]{2,})$/i.test(candidate)) candidate = candidate.split("@")[1];
    if (!candidate || !LOOKS_LIKE_SITE.test(candidate)) {
      const first = r.find(Boolean);
      // Skip a header row we didn't recognise (e.g. "Company,Notes") silently.
      if (first && !(r === rows[0] && headerIdx < 0 && !LOOKS_LIKE_SITE.test(first))) skipped.push(first.slice(0, 80));
      continue;
    }
    const key = siteKeyOf(candidate);
    if (seen.has(key)) continue;
    seen.add(key);
    if (sites.length >= max) {
      truncated++;
      continue;
    }
    sites.push(candidate.trim());
  }
  return { sites, skipped, truncated };
}
