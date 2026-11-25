import { z } from "zod";
import { requireUser } from "@/lib/supabase/server";
import { assertSameOrigin, audit, HttpError, jsonError, requestMeta, uuidSchema } from "@/lib/server/common";

const patchSchema = z.object({
  status: z.enum(["researched", "contacted", "replied", "not_interested", "do_not_contact"]).optional(),
  note: z.string().trim().min(1).max(4000).optional(),
});

async function ctxFor(req: Request, params: Promise<{ id: string }>) {
  assertSameOrigin(req);
  const { id } = await params;
  if (!uuidSchema.safeParse(id).success) throw new HttpError(400, "Invalid company id.");
  const { supabase, user } = await requireUser();
  if (!user) throw new HttpError(401, "Please sign in.");
  return { id, ctx: { supabase, user, ...requestMeta(req) } };
}

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id, ctx } = await ctxFor(req, params);
    const parsed = patchSchema.safeParse(await req.json().catch(() => ({})));
    if (!parsed.success) throw new HttpError(400, parsed.error.issues[0]?.message ?? "Invalid request.");
    const { data: company } = await ctx.supabase.from("companies").select("id,status").eq("id", id).maybeSingle();
    if (!company) throw new HttpError(404, "Company not found.");
    if (parsed.data.status && parsed.data.status !== company.status) {
      const { error } = await ctx.supabase.from("companies").update({ status: parsed.data.status }).eq("id", id);
      if (error) throw new Error(error.message);
      await ctx.supabase.from("communications").insert({ owner_id: ctx.user.id, company_id: id, event: "status_changed", note: `Status: ${company.status} → ${parsed.data.status}` });
      await audit(ctx, "company.status", "company", id, { from: company.status, to: parsed.data.status });
    }
    if (parsed.data.note) {
      await ctx.supabase.from("communications").insert({ owner_id: ctx.user.id, company_id: id, event: "note", note: parsed.data.note });
      await audit(ctx, "company.note", "company", id);
    }
    return Response.json({ ok: true });
  } catch (e) {
    return jsonError(e);
  }
}

export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id, ctx } = await ctxFor(req, params);
    const { data: company } = await ctx.supabase.from("companies").select("id,domain").eq("id", id).maybeSingle();
    if (!company) throw new HttpError(404, "Company not found.");
    const { error } = await ctx.supabase.from("companies").delete().eq("id", id);
    if (error) throw new Error(error.message);
    await audit(ctx, "company.delete", "company", id, { domain: company.domain });
    return Response.json({ ok: true });
  } catch (e) {
    return jsonError(e);
  }
}
