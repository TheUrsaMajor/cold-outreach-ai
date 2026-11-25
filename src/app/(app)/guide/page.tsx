import type { Metadata } from "next";

export const metadata: Metadata = { title: "Deliverability guide" };

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="card p-5">
      <h2 className="font-semibold text-slate-900">{title}</h2>
      <div className="mt-2 space-y-2 text-sm leading-relaxed text-slate-700">{children}</div>
    </section>
  );
}

function Code({ children }: { children: string }) {
  return <pre className="overflow-x-auto rounded-lg bg-slate-900 p-3 text-xs text-slate-100"><code>{children}</code></pre>;
}

export default function GuidePage() {
  return (
    <div className="max-w-3xl space-y-5">
      <div>
        <h1 className="text-2xl font-semibold text-slate-900">Getting cold email into the inbox</h1>
        <p className="mt-1 text-sm text-slate-500">The drafts are already written to avoid spam triggers. Inbox placement also depends on how and from where you send. Set these up before your first send.</p>
      </div>

      <Section title="1. Use a separate sending domain">
        <p>Send cold email from a look-alike domain (e.g. <code>getsteward.com</code> or <code>trysteward.com</code>) instead of your main domain, so a bad week never hurts your company&apos;s day-to-day email. Point the domain&apos;s website at your main site.</p>
      </Section>

      <Section title="2. Authenticate the domain: SPF, DKIM, DMARC (required by Gmail and Yahoo)">
        <p><strong>SPF</strong> lists the servers allowed to send for your domain. Add one TXT record at the root (example for Google Workspace):</p>
        <Code>{`Type: TXT   Host: @   Value: v=spf1 include:_spf.google.com ~all`}</Code>
        <p>Keep a single SPF record and stay under 10 DNS lookups. Use <code>include:spf.protection.outlook.com</code> for Microsoft 365.</p>
        <p><strong>DKIM</strong> cryptographically signs each email. Generate a 2048-bit key in your mail provider (Google Admin → Apps → Gmail → Authenticate email) and publish it:</p>
        <Code>{`Type: TXT   Host: google._domainkey   Value: v=DKIM1; k=rsa; p=MIIBIjANBgkq...`}</Code>
        <p><strong>DMARC</strong> tells receivers what to do when SPF/DKIM fail and sends you reports. Start in monitoring mode, then tighten after 2 to 4 clean weeks:</p>
        <Code>{`Type: TXT   Host: _dmarc   Value: v=DMARC1; p=none; rua=mailto:dmarc@yourdomain.com; adkim=r; aspf=r
# later: p=quarantine; pct=100   then   p=reject`}</Code>
        <p>Optional: <strong>BIMI</strong> (logo in the inbox, needs DMARC at quarantine/reject), <strong>MTA-STS</strong> and <strong>TLS-RPT</strong> for transport security. Verify everything with Google Postmaster Tools, MXToolbox or mail-tester.com.</p>
      </Section>

      <Section title="3. Warm up and keep volume human">
        <ul className="list-disc space-y-1 pl-5">
          <li>New mailbox: start at 5 to 10 emails a day and add about 5 a day over 3 to 4 weeks. Stay under 30 to 50 cold emails per mailbox per day.</li>
          <li>To scale, add mailboxes (e.g. 3 to 5 per sending domain), not more volume per mailbox.</li>
          <li>Space sends a few minutes apart during the recipient&apos;s business hours. Never blast.</li>
          <li>Keep spam complaints under 0.1% (Gmail&apos;s hard limit is 0.3%) and bounces under 2%.</li>
        </ul>
      </Section>

      <Section title="4. List hygiene">
        <ul className="list-disc space-y-1 pl-5">
          <li>Only send to addresses the company publishes. This app shows the source page for every contact and never guesses addresses.</li>
          <li>Addresses whose domain has no mail server (MX check failed) are crossed out. Don&apos;t send to them.</li>
          <li>Prefer a named founder or a general inbox like hello@ over role addresses like privacy@, legal@ or careers@.</li>
          <li>Mark bounces and &quot;not interested&quot; replies here so you never email them again.</li>
        </ul>
      </Section>

      <Section title="5. Content rules the AI already follows">
        <ul className="list-disc space-y-1 pl-5">
          <li>Plain text, no images, attachments, tracking pixels or links in the first email.</li>
          <li>Short (about 45 to 90 words), one specific observation, one soft question as the call to action.</li>
          <li>No hype or spam-trigger words, no ALL CAPS, no exclamation marks in subjects, no fake &quot;Re:&quot; or &quot;Fwd:&quot;.</li>
          <li>Every personal detail is taken from the prospect&apos;s own website and linked to its source.</li>
        </ul>
        <p>The live deliverability check under each draft flags anything you add while editing.</p>
      </Section>

      <Section title="6. Stay compliant">
        <ul className="list-disc space-y-1 pl-5">
          <li><strong>CAN-SPAM (US):</strong> a truthful From and subject, your physical postal address, and a clear way to opt out, honoured within 10 days.</li>
          <li><strong>GDPR / UK GDPR / ePrivacy (EU/UK):</strong> B2B outreach to work addresses can rely on legitimate interest. Keep it relevant to their role, say where you found their address if asked, and honour objections immediately.</li>
          <li><strong>CASL (Canada):</strong> stricter rules apply. Only email published addresses about their business role, with no disclaimer saying you don&apos;t want unsolicited email.</li>
          <li>Add a one-line opt-out to follow-ups (e.g. &quot;Not relevant? Just say so and I won&apos;t follow up.&quot;). Use <em>Do not contact</em> here to suppress the company.</li>
        </ul>
      </Section>
    </div>
  );
}
