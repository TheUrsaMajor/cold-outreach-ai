import { z } from "zod";
import { requireUser } from "@/lib/supabase/server";
import { regenerate } from "@/lib/server/pipeline";
import { assertSameOrigin, jsonError, requestMeta, senderFor, uuidSchema, HttpError } from "@/lib/server/common";

export const runtime = "nodejs";
export const maxDuration = 90;

const schema = z.object({
  tone: z.enum(["friendly", "direct", "formal", "playful"]).optional(),
  extraInstructions: z.string().trim().max(500).optional(),
  contactId: z.string().uuid().optional(),
});

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    assertSameOrigin(req);
    const { id } = await params;
    if (!uuidSchema.safeParse(id).success) throw new HttpError(400, "Invalid company id.");
    const { supabase, user } = await requireUser();
    if (!user) throw new HttpError(401, "Please sign in.");
    const parsed = schema.safeParse(await req.json().catch(() => ({})));
    if (!parsed.success) throw new HttpError(400, parsed.error.issues[0]?.message ?? "Invalid request.");
    const res = await regenerate({ supabase, user, ...requestMeta(req) }, id, parsed.data, senderFor(user));
    return Response.json(res);
  } catch (e) {
    return jsonError(e);
  }
}
