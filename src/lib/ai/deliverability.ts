/**
 * Heuristic content checks that keep cold emails out of spam folders. These
 * mirror what content filters (SpamAssassin, Gmail, Outlook) penalise. Score is
 * 0 (clean) to 100 (very spammy); under 20 is good.
 */

export type SpamCheck = { score: number; level: "good" | "ok" | "risky"; warnings: string[] };

export const SPAM_PHRASES = [
  "act now", "100% free", "100% guaranteed", "risk-free", "risk free", "no risk", "guaranteed", "guarantee", "free trial", "free money", "free gift",
  "click here", "click below", "buy now", "order now", "limited time", "urgent", "expires", "don't miss", "dont miss", "last chance", "once in a lifetime",
  "earn $", "make money", "extra income", "cash bonus", "double your", "increase sales", "increase revenue by", "10x", "100x", "skyrocket", "explode your",
  "best price", "lowest price", "cheap", "discount", "save big", "special promotion", "promo", "% off", "winner", "you have been selected", "congratulations",
  "dear friend", "dear sir", "to whom it may concern", "this isn't spam", "this is not spam", "not spam", "unsubscribe", "opt in", "no obligation",
  "no credit card", "no catch", "no strings attached", "amazing", "incredible", "revolutionary", "game-changer", "game changer", "miracle", "fantastic deal",
  "hidden charges", "apply now", "call now", "sign up free", "instant access", "while supplies last", "act immediately", "what are you waiting for",
  "100%", "$$$", "cash", "crypto", "bitcoin", "investment opportunity", "billion", "million dollars", "work from home", "be your own boss",
  "i hope this email finds you well", "i hope this finds you well", "just following up", "quick question", "touching base", "circle back",
  "synergy", "leverage", "cutting-edge", "cutting edge", "world-class", "best-in-class", "disrupt",
];

const DECEPTIVE_SUBJECT = /^(re|fwd?|fw)\s*:/i;

export function checkDeliverability(subject: string, body: string): SpamCheck {
  const warnings: string[] = [];
  let score = 0;
  const text = `${subject}\n${body}`;
  const lower = text.toLowerCase();

  const hits = SPAM_PHRASES.filter((p) => lower.includes(p));
  if (hits.length) {
    score += Math.min(40, hits.length * 8);
    warnings.push(`Spam-trigger phrases: ${hits.slice(0, 6).map((h) => `"${h}"`).join(", ")}.`);
  }
  if (DECEPTIVE_SUBJECT.test(subject.trim())) {
    score += 30;
    warnings.push('Subject starts with "Re:" or "Fwd:" for a first email. That is deceptive and penalised.');
  }
  const words = body.split(/\s+/).filter(Boolean);
  if (words.length > 150) {
    score += 10;
    warnings.push(`Body is ${words.length} words. Cold openers perform best under about 100.`);
  }
  if (subject.length > 60) {
    score += 8;
    warnings.push("Subject is long. Keep it under 50 characters so it isn't truncated on mobile.");
  }
  if (!subject.trim()) {
    score += 15;
    warnings.push("Missing subject line.");
  }
  const capsWords = text.match(/\b[A-Z]{4,}\b/g)?.filter((w) => !/^(SaaS|MRR|ARR|CEO|CTO|COO|CFO|B2B|API|SEO|HTML|HTTP|HTTPS|USA|EMEA|APAC|SOC2|GDPR|HIPAA|KPI|KPIS|OKR|OKRS|CRM|ERP|LTV|CAC|NPS|ROI|AWS|GCP|SDK|JSON|YAML|SaaS|LLM|AI)$/i.test(w)) ?? [];
  if (capsWords.length >= 2) {
    score += 10;
    warnings.push("Several ALL-CAPS words. They read as shouting and trigger filters.");
  }
  const excl = (text.match(/!/g) || []).length;
  if (excl >= 2) {
    score += 6 * Math.min(excl, 4);
    warnings.push("Multiple exclamation marks.");
  } else if (excl === 1 && /!/.test(subject)) {
    score += 8;
    warnings.push("Exclamation mark in the subject line.");
  }
  const links = (body.match(/https?:\/\/|www\./gi) || []).length;
  if (links > 1) {
    score += 12;
    warnings.push("More than one link. First-touch cold emails should have zero or one plain link.");
  } else if (links === 1) {
    score += 3;
  }
  if (/bit\.ly|tinyurl|t\.co\/|goo\.gl|ow\.ly|rebrand\.ly/i.test(body)) {
    score += 20;
    warnings.push("URL shorteners are heavily penalised by spam filters.");
  }
  if (/\$\d|\d+%/.test(text)) {
    score += 5;
    warnings.push("Money amounts or percentages can look promotional. Make sure each one is factual.");
  }
  if (/<[a-z][\s\S]*>/i.test(body)) {
    score += 10;
    warnings.push("HTML tags in the body. Send cold email as plain text.");
  }
  if (/[\u{1F300}-\u{1FAFF}]/u.test(subject)) {
    score += 8;
    warnings.push("Emoji in the subject line lowers the inbox rate for B2B email.");
  }
  if (/(.)\1{4,}/.test(text)) {
    score += 5;
    warnings.push("Repeated characters.");
  }
  const qMarks = (body.match(/\?/g) || []).length;
  if (qMarks > 3) {
    score += 4;
    warnings.push("Too many questions. Ask for one thing.");
  }
  score = Math.min(100, score);
  return { score, level: score < 20 ? "good" : score < 40 ? "ok" : "risky", warnings };
}
