import { z } from "zod";
import { requireUser } from "@/lib/supabase/server";
import { runResearch, type Stage } from "@/lib/server/pipeline";
import { assertSameOrigin, HttpError, requestMeta, senderFor, type Ctx } from "@/lib/server/common";

export const runtime = "nodejs";
export const maxDuration = 120;
export const dynamic = "force-dynamic";

const bodySchema = z.object({
  url: z.string().trim().min(3, "Enter a website address.").max(2048),
  force: z.boolean().optional(),
  tone: z.enum(["friendly", "direct", "formal", "playful"]).optional(),
  extraInstructions: z.string().trim().max(500).optional(),
});

/**
 * Streams newline-delimited JSON progress events, ending with either
 * {type:"result", ...} or {type:"error", ...}.
 */
export async function POST(req: Request) {
  try {
    assertSameOrigin(req);
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 403 });
  }
  const { supabase, user } = await requireUser();
  if (!user) return Response.json({ error: "Please sign in." }, { status: 401 });
  let body: z.infer<typeof bodySchema>;
  try {
    const json = await req.json();
    const parsed = bodySchema.safeParse(json);
    if (!parsed.success) return Response.json({ error: parsed.error.issues[0]?.message ?? "Invalid request." }, { status: 400 });
    body = parsed.data;
  } catch {
    return Response.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  const ctx: Ctx = { supabase, user, ...requestMeta(req) };
  const sender = senderFor(user);
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      let closed = false;
      const send = (obj: Record<string, unknown>) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`${JSON.stringify(obj)}\n`));
        } catch {
          closed = true;
        }
      };
      const keepAlive = setInterval(() => send({ type: "ping" }), 8000);
      try {
        const result = await runResearch(ctx, body, sender, (ev: { stage: Stage; message: string; detail?: Record<string, unknown> }) => send({ type: "progress", ...ev }));
        send({ type: "result", ...result });
      } catch (e) {
        if (e instanceof HttpError) send({ type: "error", status: e.status, error: e.message, ...e.extra });
        else {
          console.error("research failed", e);
          send({ type: "error", status: 500, error: "Something went wrong on our side. The run was saved as failed; please try again." });
        }
      } finally {
        clearInterval(keepAlive);
        closed = true;
        try {
          controller.close();
        } catch {}
      }
    },
  });
  return new Response(stream, { headers: { "content-type": "application/x-ndjson; charset=utf-8", "cache-control": "no-store", "x-accel-buffering": "no" } });
}
