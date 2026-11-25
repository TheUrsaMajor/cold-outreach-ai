import { configuredChain } from "@/lib/ai/providers";

export const dynamic = "force-dynamic";

/** Public liveness check. Reveals only which providers are configured, never keys. */
export async function GET() {
  const chain = configuredChain();
  return Response.json({
    ok: true,
    supabase: !!process.env.NEXT_PUBLIC_SUPABASE_URL,
    models: chain.map((c) => `${c.provider}:${c.model}`),
    time: new Date().toISOString(),
  });
}
