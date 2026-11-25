import { z } from "zod";
import { requireUser } from "@/lib/supabase/server";
import { checkDeliverability } from "@/lib/ai/deliverability";
import { assertSameOrigin, audit, HttpError, jsonError, requestMeta, uuidSchema } from "@/lib/server/common";

const emailRe = /^[^\s@<>(),;:"]{1,64}@[a-z0-9.-]+\.[a-z]{2,24}$/i;
const schema = z.object({
  subject: z.string().trim().min(1, "Subject can't be empty.").max(300).optional(),
  body: z.string().trim().min(1, "Body can't be empty.").max(10000).optional(),
  toEmail: z
    .string()
    .trim()
    .max(320)
    .refine((v) => v === "" || emailRe.test(v), "That recipient email address isn't valid.")
    .optional(),
});

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    assertSameOrigin(req);
    const { id } = await params;
    if (!uuidSchema.safeParse(id).success) throw new HttpError(400, "Invalid id.");
    const { supabase, user } = await requireUser();
    if (!user) throw new HttpError(401, "Please sign in.");
    const parsed = schema.safeParse(await req.json().catch(() => ({})));
    if (!parsed.success) throw new HttpError(400, parsed.error.issues[0]?.message ?? "Invalid request.");
    const { data: row } = await supabase.from("outreach_emails").select("id,company_id,subject,body").eq("id", id).maybeSingle();
    if (!row) throw new HttpError(404, "Draft not found.");
    const subject = parsed.data.subject ?? row.subject;
    const body = parsed.data.body ?? row.body;
    const spam = checkDeliverability(subject, body);
    const update: Record<string, unknown> = { subject, body, spam_score: spam.score, spam_warnings: spam.warnings };
    if (parsed.data.toEmail !== undefined) update.to_email = parsed.data.toEmail || null;
    const { error } = await supabase.from("outreach_emails").update(update).eq("id", id);
    if (error) throw new Error(error.message);
    await supabase.from("communications").insert({ owner_id: user.id, company_id: row.company_id, outreach_id: id, event: "edited", channel: "email", note: "Draft edited" });
    await audit({ supabase, user, ...requestMeta(req) }, "outreach.edit", "outreach", id);
    return Response.json({ ok: true, spam });
  } catch (e) {
    return jsonError(e);
  }
}
