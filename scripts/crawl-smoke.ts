import { crawlSite } from "../src/lib/crawler/crawl";
const url = process.argv[2];
crawlSite(url, { maxPages: 25 }).then((r) => {
  console.log(JSON.stringify({ final: r.finalUrl, domain: r.domain, found: r.pagesFound, ms: r.durationMs, errors: r.errors, blocked: r.robotsBlocked.length, reader: r.usedReaderFallback }, null, 0));
  for (const p of r.pages) console.log(p.status, p.via, p.priority, p.url, p.error ?? "", p.extract ? `words=${p.extract.wordCount}` : "");
  const emails = new Set(r.pages.flatMap((p) => p.extract?.emails.map((e) => e.email) ?? []));
  const people = r.pages.flatMap((p) => p.extract?.people.map((x) => `${x.name} | ${x.title} | ${x.method}`) ?? []);
  const socials = new Set(r.pages.flatMap((p) => p.extract?.socials.map((s) => s.url) ?? []));
  const phones = new Set(r.pages.flatMap((p) => p.extract?.phones ?? []));
  console.log("EMAILS", [...emails]); console.log("PEOPLE", [...new Set(people)]); console.log("SOCIALS", [...socials].slice(0,10)); console.log("PHONES", [...phones]);
  console.log("FORMS", r.pages.filter(p=>p.extract?.hasContactForm).map(p=>p.url));
}).catch((e) => console.error("ERR", e.name, e.message));
