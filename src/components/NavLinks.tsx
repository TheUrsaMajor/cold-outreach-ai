"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";

const LINKS = [
  { href: "/", label: "Prospects" },
  { href: "/usage", label: "AI usage" },
  { href: "/guide", label: "Deliverability" },
  { href: "/settings", label: "Settings" },
];

export function NavLinks() {
  const path = usePathname();
  return (
    <nav className="flex gap-1 overflow-x-auto">
      {LINKS.map((l) => {
        const active = l.href === "/" ? path === "/" || path.startsWith("/companies") : path.startsWith(l.href);
        return (
          <Link key={l.href} href={l.href} className={`whitespace-nowrap rounded-md px-2.5 py-1.5 text-sm ${active ? "bg-indigo-50 font-medium text-indigo-700" : "text-slate-600 hover:bg-slate-100"}`}>
            {l.label}
          </Link>
        );
      })}
    </nav>
  );
}
