import { z } from "zod";
import { requireUser } from "@/lib/supabase/server";
import { assertSameOrigin, audit, HttpError, jsonError, requestMeta, uuidSchema } from "@/lib/server/common";

const schema = z.object({
  event: z.enum(["opened_in_mail", "marked_sent", "reply_received", "bounced"]),
  channel: z.enum(["gmail", "outlook", "mailto", "email", "other"]).optional(),
  note: z.string().trim().max(2000).optional(),
});

const STATUS_FOR: Record<string, { outreach: string; company?: string }> = {
  opened_in_mail: { outreach: "opened_in_mail" },
  marked_sent: { outreach: "sent", company: "contacted" },
  reply_received: { outreach: "replied", company: "replied" },
  bounced: { outreach: "bounced" },
};

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    assertSameOrigin(req);
    const { id } = await params;
    if (!uuidSchema.safeParse(id).success) throw new HttpError(400, "Invalid id.");
    const { supabase, user } = await requireUser();
    if (!user) throw new HttpError(401, "Please sign in.");
    const parsed = schema.safeParse(await req.json().catch(() => ({})));
    if (!parsed.success) throw new HttpError(400, parsed.error.issues[0]?.message ?? "Invalid request.");
    const { data: row } = await supabase.from("outreach_emails").select("id,company_id,status,to_email").eq("id", id).maybeSingle();
    if (!row) throw new HttpError(404, "Draft not found.");
    const { event, channel, note } = parsed.data;
    const next = STATUS_FOR[event];
    // Don't move a sent/replied email back to "opened".
    const order = ["draft", "opened_in_mail", "sent", "bounced", "replied"];
    if (order.indexOf(next.outreach) > order.indexOf(row.status) || event !== "opened_in_mail") {
      await supabase.from("outreach_emails").update({ status: next.outreach }).eq("id", id);
    }
    if (next.company) {
      const { data: c } = await supabase.from("companies").select("status").eq("id", row.company_id).single();
      if (c && c.status !== "do_not_contact" && !(c.status === "replied" && next.company === "contacted")) {
        await supabase.from("companies").update({ status: next.company }).eq("id", row.company_id);
      }
    }
    await supabase.from("communications").insert({ owner_id: user.id, company_id: row.company_id, outreach_id: id, event, channel: channel ?? "email", note: note || (row.to_email ? `To ${row.to_email}` : null) });
    await audit({ supabase, user, ...requestMeta(req) }, `outreach.${event}`, "outreach", id, { channel });
    return Response.json({ ok: true });
  } catch (e) {
    return jsonError(e);
  }
}
