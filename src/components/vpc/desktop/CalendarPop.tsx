"use client";

// ============================================================
// GlassDesk — Calendar flyout (Windows 11 clock × liquid glass).
// Permanently mounted by the shell; renders (and runs hooks)
// only while uiStore.overlay === "calendar".
//   • live 1 s clock (gd-mono, tabular-nums) + full date line
//   • view-only month grid — Monday-start, prev/next navigation
//     via a month offset; today = accent-gradient pill, days
//     from neighbouring months are ghosted. NO day selection:
//     it's a wall calendar, not a date picker.
//   • session footer — mono session code + copy button (toast-
//     free: the icon flips to a check for ~1.4 s), seat, and
//     peers online, straight from the sync store.
// Closes on Escape or backdrop pointerdown.
// ============================================================

import { useEffect, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Check, ChevronLeft, ChevronRight, Copy } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useGlassDesk } from "@/lib/vpc/store";
import { useShellUi } from "@/lib/vpc/uiStore";

const SPRING = { type: "spring", stiffness: 420, damping: 30 } as const;
const DAY_LABELS = ["M", "T", "W", "T", "F", "S", "S"];

function pad2(n: number): string {
  return n.toString().padStart(2, "0");
}

function Readout({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <dt className="gd-mono text-[9px] uppercase tracking-wider text-stone-400">{label}</dt>
      <dd className="gd-mono truncate text-[10px] text-stone-500">{value}</dd>
    </div>
  );
}

export default function CalendarPop() {
  const open = useShellUi((s) => s.overlay === "calendar");
  const setOverlay = useShellUi((s) => s.setOverlay);
  return (
    <AnimatePresence>
      {open && <CalendarPanel key="calendar-panel" close={() => setOverlay(null)} />}
    </AnimatePresence>
  );
}

function CalendarPanel({ close }: { close: () => void }) {
  const code = useGlassDesk((s) => s.code);
  const seat = useGlassDesk((s) => s.seat);
  const peers = useGlassDesk((s) => s.peers);
  const [now, setNow] = useState(() => new Date());
  const [offset, setOffset] = useState(0); // months away from the live month
  const [copied, setCopied] = useState(false);

  // Live clock (interval-driven setState — sanctioned pattern).
  useEffect(() => {
    const iv = window.setInterval(() => setNow(new Date()), 1000);
    return () => window.clearInterval(iv);
  }, []);

  // Escape closes (outside clicks land on the transparent backdrop).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [close]);

  // Month-grid math — Monday-start weeks, with leading/trailing
  // days borrowed from the neighbouring months (ghosted below).
  const year = now.getFullYear();
  const month = now.getMonth() + offset; // Date() normalizes overflow
  const first = new Date(year, month, 1);
  const lead = (first.getDay() + 6) % 7;
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const cellCount = Math.ceil((lead + daysInMonth) / 7) * 7;
  const monthLabel = first.toLocaleDateString(undefined, { month: "long", year: "numeric" });

  async function copyCode(): Promise<void> {
    const value = code.trim();
    if (!value) return;
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1400);
    } catch {
      /* clipboard blocked — the code stays readable right here */
    }
  }

  return (
    <>
      {/* transparent click-catcher — sits 10 z-steps below the panel */}
      <motion.div
        aria-hidden
        onPointerDown={close}
        className="fixed inset-0 z-[110]"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        transition={{ duration: 0.15 }}
      />
      <motion.div
        role="dialog"
        aria-label="Clock and calendar"
        style={{ transformOrigin: "bottom right" }}
        className="glass-strong fixed bottom-[76px] right-3 z-[120] w-[min(92vw,320px)] rounded-2xl p-4"
        initial={{ opacity: 0, scale: 0.95, y: 14 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.96, y: 10 }}
        transition={SPRING}
      >
        {/* clock */}
        <p className="gd-mono text-3xl font-semibold tracking-tight text-stone-700 tabular-nums">
          {pad2(now.getHours())}:{pad2(now.getMinutes())}:{pad2(now.getSeconds())}
        </p>
        <p className="mt-0.5 text-xs text-stone-500">
          {now.toLocaleDateString(undefined, {
            weekday: "long",
            month: "long",
            day: "numeric",
            year: "numeric",
          })}
        </p>

        {/* month header */}
        <div className="mt-3 flex items-center justify-between">
          <p className="text-sm font-semibold text-stone-700">{monthLabel}</p>
          <div className="flex gap-1">
            <Button
              variant="ghost"
              size="icon"
              aria-label="Previous month"
              onClick={() => setOffset((o) => o - 1)}
              className="size-7 rounded-lg text-stone-500 hover:bg-white/70"
            >
              <ChevronLeft size={14} />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              aria-label="Next month"
              onClick={() => setOffset((o) => o + 1)}
              className="size-7 rounded-lg text-stone-500 hover:bg-white/70"
            >
              <ChevronRight size={14} />
            </Button>
          </div>
        </div>

        {/* day grid */}
        <div className="mt-2 grid grid-cols-7 gap-1">
          {DAY_LABELS.map((d, i) => (
            <span
              key={i}
              aria-hidden
              className="grid place-items-center text-[9px] font-medium text-stone-400"
            >
              {d}
            </span>
          ))}
          {Array.from({ length: cellCount }, (_, i) => {
            const day = new Date(year, month, 1 - lead + i);
            const isToday =
              offset === 0 &&
              day.getFullYear() === now.getFullYear() &&
              day.getMonth() === now.getMonth() &&
              day.getDate() === now.getDate();
            const outside = day.getMonth() !== first.getMonth();
            return (
              <span
                key={i}
                aria-hidden
                className={`grid size-8 place-items-center rounded-lg text-xs transition-colors ${
                  isToday
                    ? "gd-accent-gradient font-semibold text-white shadow-sm"
                    : outside
                      ? "text-stone-300 hover:bg-white/40"
                      : "text-stone-600 hover:bg-white/70"
                }`}
              >
                {day.getDate()}
              </span>
            );
          })}
        </div>

        {/* session footer */}
        <div className="mt-3 space-y-2 border-t border-white/50 pt-3">
          <div className="flex items-center justify-between gap-2">
            <span className="gd-mono text-xs tracking-[0.14em] text-stone-600 tabular-nums">
              {code || "······"}
            </span>
            <Button
              variant="ghost"
              size="icon"
              title="Copy code"
              aria-label="Copy session code"
              onClick={() => void copyCode()}
              className="size-7 shrink-0 rounded-lg text-stone-500 hover:bg-white/70"
            >
              {copied ? <Check size={13} className="text-emerald-500" /> : <Copy size={13} />}
            </Button>
          </div>
          <dl className="grid grid-cols-2 gap-x-3 gap-y-2">
            <Readout label="seat" value={seat ?? "—"} />
            <Readout label="peers online" value={`${Object.keys(peers).length}`} />
          </dl>
        </div>
      </motion.div>
    </>
  );
}
