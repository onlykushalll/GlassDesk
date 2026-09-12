"use client";

// ============================================================
// GlassDesk — "About GlassDesk" dialog. Opened from the menu-bar
// app menu (and the desktop context menu's About item). Purely
// LOCAL shell chrome: state lives in uiStore (aboutOpen), never
// synced, no new ops. "Software Update…" opens the Glass Store
// through the existing openApp() mechanism — nothing invented.
//
// Content: LogoMark + wordmark + version, seats line, credits,
// live RAM/uptime telemetry from the shared machine, and the
// teal-gradient update CTA. Spring glass entrance (SPRING.sheet),
// Escape + backdrop click close. z-[150] — above menubar (110)
// and start menu (120), below the lock screen (200).
// ============================================================

import { useEffect } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Cpu, HardDrive, MemoryStick, Sparkles } from "lucide-react";
import { LogoMark, Wordmark } from "@/components/vpc/brand/Logo";
import { useGlassDesk } from "@/lib/vpc/store";
import { useShellUi } from "@/lib/vpc/uiStore";
import { SPRING } from "@/lib/vpc/motion";
import { DISK_GB, NODE, fmtUptime, ramUsage } from "@/lib/vpc/types";
import { openApp } from "./Dock";

export default function AboutDialog() {
  const open = useShellUi((s) => s.aboutOpen);
  const setAboutOpen = useShellUi((s) => s.setAboutOpen);
  const state = useGlassDesk((s) => s.state);

  // Escape closes (capture phase so one press doesn't leak onward)
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      setAboutOpen(false);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open, setAboutOpen]);

  const ram = state ? ramUsage(state) : null;
  const uptime = state ? fmtUptime(Date.now() - state.machine.createdAt) : null;

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          key="about-backdrop"
          role="presentation"
          onPointerDown={() => setAboutOpen(false)}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.16 }}
          className="fixed inset-0 z-[150] grid place-items-center bg-stone-900/20 p-4 backdrop-blur-sm"
        >
          <motion.div
            key="about"
            role="dialog"
            aria-modal="true"
            aria-label="About GlassDesk"
            initial={{ opacity: 0, scale: 0.92, y: 18 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.95, y: 10 }}
            transition={SPRING.sheet}
            onPointerDown={(e) => e.stopPropagation()}
            className="glass-strong glass-sheen w-full max-w-sm rounded-3xl p-7 text-center shadow-2xl"
          >
            {/* identity */}
            <div className="flex flex-col items-center gap-3">
              <LogoMark size={72} />
              <Wordmark className="text-2xl" />
              <p className="gd-mono text-[11px] tabular-nums text-stone-400">
                Version 10.0 (Sequoia-of-glass)
              </p>
            </div>

            <p className="mt-4 text-sm font-medium text-stone-600">
              2 seats · 1 shared PC
            </p>
            <p className="mt-1.5 text-[11px] leading-relaxed text-stone-400">
              Every window, file and stroke lives on one software-defined
              machine — both seats drive it together, live.
            </p>

            {/* telemetry row */}
            <div className="mt-5 grid grid-cols-3 gap-1.5">
              {ram && (
                <div className="rounded-xl bg-white/60 px-2 py-2.5" title="Live memory pressure">
                  <MemoryStick size={13} className="mx-auto text-teal-600" />
                  <p className="gd-mono mt-1 text-[10px] tabular-nums text-stone-500">
                    {ram.used}/{ram.total} MB
                  </p>
                </div>
              )}
              {uptime && (
                <div className="rounded-xl bg-white/60 px-2 py-2.5" title="Uptime since first boot">
                  <Cpu size={13} className="mx-auto text-teal-600" />
                  <p className="gd-mono mt-1 text-[10px] tabular-nums text-stone-500">{uptime}</p>
                </div>
              )}
              <div className="rounded-xl bg-white/60 px-2 py-2.5" title="GlassDesk HD volume">
                <HardDrive size={13} className="mx-auto text-teal-600" />
                <p className="gd-mono mt-1 text-[10px] tabular-nums text-stone-500">{DISK_GB} GB HD</p>
              </div>
            </div>

            {/* update CTA — opens the Store via the existing mechanism */}
            <motion.button
              type="button"
              whileHover={{ scale: 1.02 }}
              whileTap={{ scale: 0.97 }}
              transition={SPRING.snappy}
              onClick={() => {
                setAboutOpen(false);
                openApp("store");
              }}
              className="gd-accent-gradient mt-5 flex h-10 w-full items-center justify-center gap-2 rounded-full text-sm font-semibold text-white shadow-lg shadow-teal-600/25"
            >
              <Sparkles size={15} strokeWidth={2.2} />
              Software Update…
            </motion.button>

            <p className="mt-4 text-[10px] text-stone-400">
              node {NODE} · crafted in the browser · springs &amp; squircles
            </p>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
