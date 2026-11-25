import { readFileSync } from "node:fs";
import { extractPage } from "../src/lib/crawler/extract";
import { buildSources, DEFAULT_SENDER } from "../src/lib/ai/prompt";
import { generateOutreach } from "../src/lib/ai/generate";
import { parseChain } from "../src/lib/ai/providers";

const html = readFileSync("tests/fixtures/about.html", "utf8");
const pages = [{ url: "https://ledgerly.io/about", status: 200, extract: extractPage(html, "https://ledgerly.io/about"), priority: 1000, via: "home" as const }];
const sources = buildSources(pages, 60000);
const chain = parseChain(process.argv[2] || "gemini:gemini-3.5-flash");
generateOutreach({ sources, domain: "ledgerly.io", companyName: "Ledgerly", description: "", founders: [], recipientName: "Priya Raman", sender: DEFAULT_SENDER, chain, budgetMs: 60000 }).then((r) => {
  console.log(JSON.stringify(r.attempts, null, 0));
  console.log("SUBJECT:", r.subject, "| ALT:", r.altSubjects.join(" / "));
  console.log(r.body);
  console.log("SPAM", r.spam);
  console.log("FACTS", r.facts);
  console.log("FOUNDERS", r.founders.map((f) => f.name));
  console.log("FIT", r.output.fit, "\nNOTES", r.output.strategy_notes);
});
