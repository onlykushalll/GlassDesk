"use client";

// ============================================================
// GlassDesk — Notification Center: right-edge slide-over with
// the full toast history (newest first). Self-gates on the
// uiStore overlay "notifs" — mounted once by the shell, no props.
//   • opening it calls markSeen() → the taskbar bell badge clears
//     (deferred through a timeout so no store push runs in an
//     effect body)
//   • timestamps refresh from a 30 s interval ticker
//   • Escape / backdrop pointerdown close (StartMenu pattern)
// ============================================================

import { useEffect, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { AlertTriangle, Bell, BellOff, CheckCircle2, Info, OctagonX, type LucideIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useToasts, type GdToast, type ToastKind } from "@/lib/vpc/toast";
import { useShellUi } from "@/lib/vpc/uiStore";

const SPRING = { type: "spring", stiffness: 420, damping: 30 } as const;
const TICK_MS = 30_000;

const KIND_META: Record<ToastKind, { icon: LucideIcon; tile: string; text: string }> = {
  info: { icon: Info, tile: "bg-stone-100", text: "text-stone-500" },
  success: { icon: CheckCircle2, tile: "bg-emerald-50", text: "text-emerald-600" },
  warn: { icon: AlertTriangle, tile: "bg-amber-50", text: "text-amber-600" },
  danger: { icon: OctagonX, tile: "bg-rose-50", text: "text-rose-600" },
};

/** Coarse relative time — "just now" / "4m ago" / "3h ago" / "2d ago". */
function relTime(at: number, now: number): string {
  const s = Math.max(0, Math.floor((now - at) / 1000));
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

export default function NotifCenter() {
  const open = useShellUi((s) => s.overlay === "notifs");
  const setOverlay = useShellUi((s) => s.setOverlay);
  return (
    <AnimatePresence>
      {open && <NotifPanel key="notif-panel" close={() => setOverlay(null)} />}
    </AnimatePresence>
  );
}

function NotifPanel({ close }: { close: () => void }) {
  const history = useToasts((s) => s.history);
  const markSeen = useToasts((s) => s.markSeen);
  const clearAll = useToasts((s) => s.clearAll);

  const [now, setNow] = useState(() => Date.now());

  // Opening the center marks everything seen (clears the bell badge).
  // Deferred one tick — never a synchronous store push in the effect body.
  useEffect(() => {
    const t = window.setTimeout(() => markSeen(), 0);
    return () => clearTimeout(t);
  }, [markSeen]);

  // Timestamp ticker — also re-marks seen so toasts arriving while the
  // center is open never re-light the badge behind it.
  useEffect(() => {
    const t = setInterval(() => {
      setNow(Date.now());
      markSeen();
    }, TICK_MS);
    return () => clearInterval(t);
  }, [markSeen]);

  // Escape closes (outside clicks land on the transparent backdrop).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [close]);

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

      <motion.aside
        role="dialog"
        aria-label="Notification center"
        className="glass-strong fixed bottom-0 right-0 top-0 z-[120] flex w-[340px] max-w-[92vw] flex-col overflow-hidden rounded-l-2xl"
        initial={{ x: "100%", opacity: 0.6 }}
        animate={{ x: 0, opacity: 1 }}
        exit={{ x: "100%", opacity: 0.4 }}
        transition={SPRING}
      >
        {/* header */}
        <div className="flex items-center gap-2 border-b border-white/50 p-3.5">
          <span className="grid size-7 shrink-0 place-items-center rounded-lg bg-stone-100 text-stone-500">
            <Bell size={14} />
          </span>
          <h2 className="text-sm font-semibold text-stone-700">Notifications</h2>
          <span className="gd-mono rounded-full bg-white/60 px-1.5 py-0.5 text-[10px] tabular-nums text-stone-400">
            {history.length}
          </span>
          <div className="flex-1" />
          <Button
            variant="ghost"
            size="sm"
            onClick={() => clearAll()}
            disabled={history.length === 0}
            className="h-7 rounded-lg px-2.5 text-[11px] text-stone-500 hover:bg-white/70 focus-visible:ring-[var(--gd-accent)]"
          >
            Clear all
          </Button>
        </div>

        {/* history — newest first */}
        {history.length > 0 ? (
          <div
            role="log"
            aria-label="Notification history"
            className="gd-scroll min-h-0 flex-1 space-y-0.5 overflow-y-auto p-2"
          >
            {history.map((n) => (
              <NotifRow key={n.id} toast={n} now={now} />
            ))}
          </div>
        ) : (
          <div className="flex flex-1 flex-col items-center justify-center gap-2.5 px-6 text-center">
            <span className="grid size-12 place-items-center rounded-2xl bg-stone-100 text-stone-400">
              <BellOff size={22} />
            </span>
            <p className="text-xs font-medium text-stone-500">You&apos;re all caught up</p>
            <p className="text-[10px] leading-relaxed text-stone-400">
              Peers joining, host changes, media and system events land here.
            </p>
          </div>
        )}
      </motion.aside>
    </>
  );
}

function NotifRow({ toast, now }: { toast: GdToast; now: number }) {
  const meta = KIND_META[toast.kind];
  const Icon = meta.icon;
  return (
    <div className="flex items-start gap-2.5 rounded-xl px-2.5 py-2 transition-colors hover:bg-white/60">
      <span className={`mt-0.5 grid size-7 shrink-0 place-items-center rounded-lg ${meta.tile} ${meta.text}`}>
        <Icon size={14} strokeWidth={2.2} />
      </span>
      <span className="min-w-0 flex-1 leading-tight">
        <span className="block truncate text-xs font-semibold text-stone-700">{toast.title}</span>
        {toast.body ? (
          <span className="mt-0.5 block truncate text-[11px] text-stone-500">{toast.body}</span>
        ) : null}
      </span>
      <span className="gd-mono shrink-0 pt-0.5 text-[10px] tabular-nums text-stone-400">
        {relTime(toast.at, now)}
      </span>
    </div>
  );
}
