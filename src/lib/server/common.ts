import "server-only";
import type { SupabaseClient, User } from "@supabase/supabase-js";
import { z } from "zod";
import { DEFAULT_SENDER, type SenderProfile } from "../ai/prompt";
import { env } from "../env";

export type Ctx = { supabase: SupabaseClient; user: User; ip: string | null; userAgent: string | null };

export function requestMeta(req: Request) {
  const fwd = req.headers.get("x-forwarded-for");
  return {
    ip: (fwd?.split(",")[0] || req.headers.get("x-real-ip") || "").trim() || null,
    userAgent: req.headers.get("user-agent")?.slice(0, 500) ?? null,
  };
}

export async function audit(ctx: Ctx, action: string, entity?: string, entityId?: string, meta: Record<string, unknown> = {}) {
  const { error } = await ctx.supabase.from("audit_logs").insert({
    owner_id: ctx.user.id,
    action,
    entity: entity ?? null,
    entity_id: entityId ?? null,
    ip: ctx.ip,
    user_agent: ctx.userAgent,
    meta,
  });
  if (error) console.error("audit insert failed", error.message);
}

export class HttpError extends Error {
  constructor(public status: number, message: string, public extra: Record<string, unknown> = {}) {
    super(message);
  }
}

/** Per-user run limits, counted from the database so they hold across serverless instances. */
export async function enforceRunLimits(ctx: Ctx) {
  const hourAgo = new Date(Date.now() - 3600_000).toISOString();
  const dayAgo = new Date(Date.now() - 86_400_000).toISOString();
  const [h, d] = await Promise.all([
    ctx.supabase.from("research_runs").select("id", { count: "exact", head: true }).gte("started_at", hourAgo),
    ctx.supabase.from("ai_usage_logs").select("id", { count: "exact", head: true }).gte("created_at", dayAgo).eq("attempt", 1),
  ]);
  if ((h.count ?? 0) >= env.hourlyRunLimit()) throw new HttpError(429, `Hourly limit reached (${env.hourlyRunLimit()} research runs per hour). Try again a bit later.`);
  if ((d.count ?? 0) >= env.dailyRunLimit()) throw new HttpError(429, `Daily limit reached (${env.dailyRunLimit()} generations per day).`);
}

const senderSchema = z.object({
  senderName: z.string().trim().min(1).max(80),
  senderTitle: z.string().trim().max(80).default(""),
  productName: z.string().trim().min(1).max(80),
  productPitch: z.string().trim().min(20).max(1500),
  calendarLink: z.string().trim().max(300).optional(),
});
export const senderInputSchema = senderSchema;

export function senderFor(user: User): SenderProfile {
  const meta = (user.user_metadata?.sender ?? {}) as Partial<SenderProfile>;
  const parsed = senderSchema.partial().safeParse(meta);
  const m = parsed.success ? parsed.data : {};
  const fallbackName = (user.user_metadata?.full_name as string | undefined) || DEFAULT_SENDER.senderName;
  return {
    senderName: m.senderName || fallbackName,
    senderTitle: m.senderTitle || DEFAULT_SENDER.senderTitle,
    productName: m.productName || DEFAULT_SENDER.productName,
    productPitch: m.productPitch || DEFAULT_SENDER.productPitch,
    calendarLink: m.calendarLink,
  };
}

export const uuidSchema = z.string().uuid();

export function jsonError(e: unknown) {
  if (e instanceof HttpError) return Response.json({ error: e.message, ...e.extra }, { status: e.status });
  console.error(e);
  return Response.json({ error: "Something went wrong on our side. Please try again." }, { status: 500 });
}

/** Reject cross-site POSTs (CSRF defence on top of SameSite cookies). */
export function assertSameOrigin(req: Request) {
  const origin = req.headers.get("origin");
  if (!origin) return; // non-browser clients
  const host = req.headers.get("x-forwarded-host") || req.headers.get("host");
  try {
    if (new URL(origin).host !== host) throw new HttpError(403, "Cross-site request blocked.");
  } catch (e) {
    if (e instanceof HttpError) throw e;
    throw new HttpError(403, "Cross-site request blocked.");
  }
}
