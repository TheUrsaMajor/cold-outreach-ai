import type { Metadata } from "next";
import { requireUser } from "@/lib/supabase/server";
import { senderFor } from "@/lib/server/common";
import { SettingsForm } from "@/components/SettingsForm";

export const metadata: Metadata = { title: "Settings" };

export default async function SettingsPage() {
  const { user } = await requireUser();
  const sender = senderFor(user!);
  return (
    <div className="max-w-2xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-slate-900">Settings</h1>
        <p className="mt-1 text-sm text-slate-500">Who the emails come from and what you&apos;re pitching. The AI uses this in every draft.</p>
      </div>
      <SettingsForm initial={sender} />
    </div>
  );
}
