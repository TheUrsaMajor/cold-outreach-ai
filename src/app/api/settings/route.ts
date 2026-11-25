import { requireUser } from "@/lib/supabase/server";
import { assertSameOrigin, audit, HttpError, jsonError, requestMeta, senderInputSchema } from "@/lib/server/common";

export async function PUT(req: Request) {
  try {
    assertSameOrigin(req);
    const { supabase, user } = await requireUser();
    if (!user) throw new HttpError(401, "Please sign in.");
    const parsed = senderInputSchema.safeParse(await req.json().catch(() => ({})));
    if (!parsed.success) throw new HttpError(400, `${parsed.error.issues[0]?.path.join(".")}: ${parsed.error.issues[0]?.message}`);
    const { error } = await supabase.auth.updateUser({ data: { sender: parsed.data } });
    if (error) throw new HttpError(400, error.message);
    await audit({ supabase, user, ...requestMeta(req) }, "settings.update", "user", user.id);
    return Response.json({ ok: true });
  } catch (e) {
    return jsonError(e);
  }
}
