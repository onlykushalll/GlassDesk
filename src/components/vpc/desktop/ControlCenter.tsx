"use client";

// ============================================================
// GlassDesk — Control Center (Apple flyout × GlassDesk).
// Permanently mounted by the shell; renders (and runs hooks)
// only while uiStore.overlay === "control".
//   • Appearance — wallpaper swatches + accent dots (both are
//     synced sys patches, so both seats see the change)
//   • Sound — master volume from uiStore (localStorage-backed)
//   • Display — desktop brightness, remapped from the store's
//     0.6..1 veil range onto a 0..100 slider (live while
//     dragging, committed on release)
//   • Machine — hostname / node / RAM / vCores / disk / uptime
//     readouts (1 s ticker keeps uptime live)
//   • Workspaces — 1..4 switcher with live window-count badges
// Closes on Escape or backdrop pointerdown.
// ============================================================

import { useEffect, useState, type ReactNode } from "react";
import { AnimatePresence, motion } from "framer-motion";
import {
  AudioLines,
  Cpu,
  Layers,
  Minus,
  Palette,
  Sun,
  Volume1,
  Volume2,
  VolumeX,
} from "lucide-react";
import { Slider } from "@/components/ui/slider";
import { useGlassDesk } from "@/lib/vpc/store";
import { useShellUi } from "@/lib/vpc/uiStore";
import {
  ACCENTS,
  WALLPAPERS,
  WORKSPACES,
  fmtBytes,
  fmtUptime,
  fsBytes,
  ramUsage,
} from "@/lib/vpc/types";

const SPRING = { type: "spring", stiffness: 420, damping: 30 } as const;

/** Tints the shadcn Slider fill with the live accent gradient. */
const SLIDER_ACCENT =
  "flex-1 [&_[data-slot=slider-range]]:bg-[linear-gradient(90deg,var(--gd-accent),var(--gd-accent-2))] [&_[data-slot=slider-thumb]]:border-stone-200";

function SectionHeader({ icon, label }: { icon: ReactNode; label: string }) {
  return (
    <div className="flex items-center gap-1.5 px-1">
      <span className="grid size-3.5 shrink-0 place-items-center text-stone-400">{icon}</span>
      <h2 className="text-[10px] font-semibold uppercase tracking-wider text-stone-400">{label}</h2>
    </div>
  );
}

function Readout({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <dt className="gd-mono text-[9px] uppercase tracking-wider text-stone-400">{label}</dt>
      <dd className="gd-mono truncate text-[10px] text-stone-500">{value}</dd>
    </div>
  );
}

export default function ControlCenter() {
  const open = useShellUi((s) => s.overlay === "control");
  const setOverlay = useShellUi((s) => s.setOverlay);
  return (
    <AnimatePresence>
      {open && <ControlPanel key="control-panel" close={() => setOverlay(null)} />}
    </AnimatePresence>
  );
}

function ControlPanel({ close }: { close: () => void }) {
  const state = useGlassDesk((s) => s.state);
  const dispatch = useGlassDesk((s) => s.dispatch);
  const volume = useShellUi((s) => s.volume);
  const setVolume = useShellUi((s) => s.setVolume);
  const brightness = useShellUi((s) => s.brightness);
  const setBrightness = useShellUi((s) => s.setBrightness);
  const [now, setNow] = useState(() => Date.now());

  // Uptime ticker (interval-driven setState is the sanctioned
  // live-readout pattern in this codebase — Dock, TaskMgr, Settings).
  useEffect(() => {
    const iv = window.setInterval(() => setNow(Date.now()), 1000);
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

  if (!state) return null; // overlays only ever open inside a live session

  const ram = ramUsage(state);
  const diskUsed = fsBytes(state.fs);
  const VolIcon = volume === 0 ? VolumeX : volume < 0.5 ? Volume1 : Volume2;
  const briPct = Math.round(((brightness - 0.6) / 0.4) * 100);

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
        aria-label="Control center"
        style={{ transformOrigin: "bottom right" }}
        className="glass-strong fixed bottom-[76px] right-3 z-[120] w-[min(92vw,340px)] space-y-4 rounded-2xl p-4"
        initial={{ opacity: 0, scale: 0.95, y: 14 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.96, y: 10 }}
        transition={SPRING}
      >
        {/* Appearance */}
        <section className="space-y-1.5">
          <SectionHeader icon={<Palette size={12} />} label="Appearance" />
          <div className="glass space-y-2.5 rounded-xl p-2.5">
            <div className="space-y-1.5">
              <p className="px-0.5 text-[10px] text-stone-400">Wallpaper</p>
              <div className="grid grid-cols-4 gap-1.5">
                {WALLPAPERS.map((w) => {
                  const selected = state.wallpaper === w.id;
                  return (
                    <button
                      key={w.id}
                      type="button"
                      title={w.label}
                      aria-label={`${w.label} wallpaper`}
                      aria-pressed={selected}
                      onClick={() => dispatch({ t: "sys", patch: { wallpaper: w.id } })}
                      className="h-9 rounded-lg border border-white/60 transition-transform hover:scale-[1.03] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--gd-accent)]"
                      style={{
                        background: w.swatch,
                        boxShadow: selected
                          ? "0 0 0 2px rgba(255,255,255,0.9), 0 0 0 4px var(--gd-accent)"
                          : undefined,
                      }}
                    />
                  );
                })}
              </div>
            </div>
            <div className="space-y-1.5">
              <p className="px-0.5 text-[10px] text-stone-400">Accent</p>
              <div className="flex items-center gap-2.5 px-0.5">
                {ACCENTS.map((a) => {
                  const selected = state.accent === a.id;
                  return (
                    <motion.button
                      key={a.id}
                      type="button"
                      whileTap={{ scale: 0.88 }}
                      transition={{ type: "spring", stiffness: 420, damping: 24 }}
                      title={a.label}
                      aria-label={`${a.label} accent`}
                      aria-pressed={selected}
                      onClick={() => dispatch({ t: "sys", patch: { accent: a.id } })}
                      className="size-6 rounded-full border border-black/10 shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--gd-accent)]"
                      style={{
                        backgroundColor: a.hex,
                        boxShadow: selected
                          ? `0 0 0 2px rgba(255,255,255,0.9), 0 0 0 4px ${a.hex}`
                          : undefined,
                      }}
                    />
                  );
                })}
              </div>
            </div>
          </div>
        </section>

        {/* Sound */}
        <section className="space-y-1.5">
          <SectionHeader icon={<AudioLines size={12} />} label="Sound" />
          <div className="glass flex items-center gap-2.5 rounded-xl p-2.5">
            <VolIcon size={15} className="shrink-0 text-stone-500" aria-hidden />
            <Slider
              className={SLIDER_ACCENT}
              value={[Math.round(volume * 100)]}
              onValueChange={(v) => setVolume((v[0] ?? 0) / 100)}
              aria-label="Volume"
            />
            <span className="gd-mono w-9 shrink-0 text-right text-[10px] text-stone-500">
              {Math.round(volume * 100)}%
            </span>
          </div>
        </section>

        {/* Display */}
        <section className="space-y-1.5">
          <SectionHeader icon={<Sun size={12} />} label="Display" />
          <div className="glass flex items-center gap-2 rounded-xl p-2.5">
            <Minus size={13} className="shrink-0 text-stone-400" aria-hidden />
            <Slider
              className={SLIDER_ACCENT}
              value={[briPct]}
              onValueChange={(v) => setBrightness(0.6 + ((v[0] ?? 0) / 100) * 0.4)}
              onValueCommit={(v) => setBrightness(0.6 + ((v[0] ?? 0) / 100) * 0.4)}
              aria-label="Brightness"
            />
            <Sun size={15} className="shrink-0 text-amber-500" aria-hidden />
            <span className="gd-mono w-9 shrink-0 text-right text-[10px] text-stone-500">
              {briPct}%
            </span>
          </div>
        </section>

        {/* Machine */}
        <section className="space-y-1.5">
          <SectionHeader icon={<Cpu size={12} />} label="Machine" />
          <dl className="glass grid grid-cols-2 gap-x-3 gap-y-2 rounded-xl p-3">
            <Readout label="hostname" value={state.machine.hostname} />
            <Readout label="node" value={state.machine.node} />
            <Readout label="memory" value={`${ram.used} / ${ram.total} MB`} />
            <Readout label="vcores" value={String(state.machine.cores)} />
            <Readout label="disk" value={`${fmtBytes(diskUsed)} of ${state.machine.diskGB} GB`} />
            <Readout label="uptime" value={fmtUptime(now - state.machine.createdAt)} />
          </dl>
        </section>

        {/* Workspaces */}
        <section className="space-y-1.5">
          <SectionHeader icon={<Layers size={12} />} label="Workspaces" />
          <div className="grid grid-cols-4 gap-1.5">
            {Array.from({ length: WORKSPACES }, (_, i) => {
              const activeWs = state.workspace === i;
              const count = state.windows.filter(
                (w) => (w.workspace ?? 0) === i && !w.minimized,
              ).length;
              return (
                <motion.button
                  key={i}
                  type="button"
                  whileTap={{ scale: 0.94 }}
                  transition={{ type: "spring", stiffness: 420, damping: 24 }}
                  aria-label={`Switch to workspace ${i + 1}${count > 0 ? ` (${count} windows)` : ""}`}
                  aria-pressed={activeWs}
                  onClick={() => dispatch({ t: "sys", patch: { workspace: i } })}
                  className={`relative flex h-9 items-center justify-center rounded-lg text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--gd-accent)] ${
                    activeWs
                      ? "gd-accent-gradient text-white shadow-sm"
                      : "bg-white/60 text-stone-500 hover:bg-white/80"
                  }`}
                >
                  {i + 1}
                  {count > 0 && (
                    <span className="gd-mono absolute -right-1.5 -top-1.5 grid h-4 min-w-4 place-items-center rounded-full border border-stone-200/80 bg-white px-1 text-[9px] font-semibold text-stone-500 shadow-sm">
                      {count}
                    </span>
                  )}
                </motion.button>
              );
            })}
          </div>
        </section>
      </motion.div>
    </>
  );
}
