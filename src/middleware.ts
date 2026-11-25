import { NextResponse, type NextRequest } from "next/server";
import { createServerClient } from "@supabase/ssr";

const PUBLIC_PATHS = ["/login", "/auth", "/api/health", "/api/selftest"];

export async function middleware(request: NextRequest) {
  let response = NextResponse.next({ request });
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) return response;

  const supabase = createServerClient(url, key, {
    cookies: {
      getAll: () => request.cookies.getAll(),
      setAll: (list) => {
        list.forEach(({ name, value }) => request.cookies.set(name, value));
        response = NextResponse.next({ request });
        list.forEach(({ name, value, options }) => response.cookies.set(name, value, options));
      },
    },
  });
  const { data } = await supabase.auth.getUser();
  const path = request.nextUrl.pathname;
  const isPublic = PUBLIC_PATHS.some((p) => path === p || path.startsWith(`${p}/`));

  if (!data.user && !isPublic) {
    if (path.startsWith("/api/")) return NextResponse.json({ error: "Please sign in." }, { status: 401 });
    const to = request.nextUrl.clone();
    to.pathname = "/login";
    to.search = path !== "/" ? `?next=${encodeURIComponent(path)}` : "";
    return NextResponse.redirect(to);
  }
  const allow = (process.env.ALLOWED_SIGNUPS || "").split(",").map((x) => x.trim().toLowerCase()).filter(Boolean);
  if (data.user && allow.length) {
    const email = (data.user.email || "").toLowerCase();
    const ok = allow.some((rule) => (rule.startsWith("@") ? email.endsWith(rule) : email === rule));
    if (!ok && !isPublic) {
      await supabase.auth.signOut();
      if (path.startsWith("/api/")) return NextResponse.json({ error: "This account is not allowed to use this workspace." }, { status: 403 });
      const to = request.nextUrl.clone();
      to.pathname = "/login";
      to.search = "?error=not_allowed";
      const r = NextResponse.redirect(to);
      response.cookies.getAll().forEach((c) => r.cookies.set(c));
      return r;
    }
  }
  if (data.user && path === "/login") {
    const to = request.nextUrl.clone();
    to.pathname = "/";
    to.search = "";
    return NextResponse.redirect(to);
  }
  return response;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|robots.txt|.*\\.(?:png|svg|jpg|ico|webp)$).*)"],
};
