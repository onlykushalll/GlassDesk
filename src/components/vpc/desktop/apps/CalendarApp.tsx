"use client";

// GlassDesk — CalendarApp placeholder. Owned by a wave-8 app subagent;
// replaced with the full implementation at integration time.
import type { WindowState } from "@/lib/vpc/types";

export default function CalendarApp({ win }: { win: WindowState }) {
  return (
    <div className="h-full grid place-items-center bg-white/30">
      <p className="text-xs text-stone-400">{win.title} loading…</p>
    </div>
  );
}
