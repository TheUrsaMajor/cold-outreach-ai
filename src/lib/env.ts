function required(name: string, value: string | undefined): string {
  if (!value) throw new Error(`Missing required environment variable ${name}`);
  return value;
}

export const env = {
  supabaseUrl: () => required("NEXT_PUBLIC_SUPABASE_URL", process.env.NEXT_PUBLIC_SUPABASE_URL),
  supabaseAnonKey: () => required("NEXT_PUBLIC_SUPABASE_ANON_KEY", process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY),
  /** Max research runs per user per hour / day (abuse + cost protection). */
  hourlyRunLimit: () => Number(process.env.HOURLY_RUN_LIMIT || 60),
  dailyRunLimit: () => Number(process.env.DAILY_RUN_LIMIT || 300),
  /** Re-researching the same domain within this many hours returns the saved result unless forced. */
  dedupeHours: () => Number(process.env.DEDUPE_HOURS || 24),
  maxPages: () => Math.min(60, Number(process.env.CRAWL_MAX_PAGES || 30)),
  /** Optional comma-separated allowlist of emails/domains that may sign up (e.g. "me@x.com,@myco.com"). */
  allowedSignups: () =>
    (process.env.ALLOWED_SIGNUPS || "")
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
};

export function isSignupAllowed(email: string): boolean {
  const list = env.allowedSignups();
  if (!list.length) return true;
  const e = email.toLowerCase();
  return list.some((rule) => (rule.startsWith("@") ? e.endsWith(rule) : e === rule));
}
