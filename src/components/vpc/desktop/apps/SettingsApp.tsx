"use client";

// ============================================================
// GlassDesk — Settings 2.0 (macOS Ventura style). Left sidebar
// with icon rows + accent-tinted active glass; five panes that
// slide/fade on switch (framer-motion spring):
//
//   Appearance   — 10-wallpaper gallery (synced sys patch + toast)
//                  + 5 accent dots (synced)
//   Sound & Dsp  — volume + brightness (LOCAL per-seat, uiStore)
//   Network      — session card: code, seat, peers, link uptime
//   Storage      — GlassDesk HD usage + machine specs
//   About        — logo, kernel version, live uptime, credits
//
// The active pane is LOCAL state (never synced — each seat browses
// independently); only the actual changes (wallpaper/accent) sync.
// ============================================================

import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { AnimatePresence, motion } from "framer-motion";
import {
  Activity,
  Check,
  Gem,
  HardDrive,
  Info,
  LogOut,
  Palette,
  SlidersHorizontal,
  Sun,
  Users,
  Volume2,
  VolumeX,
  Wifi,
  type LucideIcon,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Slider } from "@/components/ui/slider";
import { openApp } from "@/components/vpc/desktop/Dock";
import { useGlassDesk } from "@/lib/vpc/store";
import { useShellUi } from "@/lib/vpc/uiStore";
import { pushToast } from "@/lib/vpc/toast";
import {
  ACCENTS,
  APP_RAM,
  DISK_GB,
  RAM_TIERS,
  WALLPAPERS,
  accentOf,
  fmtBytes,
  fmtUptime,
  fsBytes,
  pidOf,
  ramUsage,
  type WindowState,
} from "@/lib/vpc/types";

type PaneId = "appearance" | "sound" | "network" | "storage" | "about";

const PANES: { id: PaneId; label: string; icon: LucideIcon }[] = [
  { id: "appearance", label: "Appearance", icon: Palette },
  { id: "sound", label: "Sound & Display", icon: SlidersHorizontal },
  { id: "network", label: "Network", icon: Wifi },
  { id: "storage", label: "Storage", icon: HardDrive },
  { id: "about", label: "About", icon: Info },
];

const RAIL_AT_W = 560;

/** Image-wallpaper swatches are url(...) layers — give each a soft
 *  gradient fallback underneath so cards look right pre-render. */
function swatchBg(swatch: string): string {
  return swatch.startsWith("url") ? `${swatch}, linear-gradient(135deg,#e4faf5,#e0f7ec)` : swatch;
}

/** Measure the app's own pane (windows resize independently of the viewport). */
function useMeasure<T extends HTMLElement>(): [React.RefObject<T | null>, number] {
  const ref = useRef<T | null>(null);
  const [w, setW] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const apply = (width: number) => setW((prev) => (Math.abs(prev - width) < 1 ? prev : width));
    apply(el.getBoundingClientRect().width);
    const ro = new ResizeObserver((entries) => {
      const e = entries[0];
      if (e) apply(e.contentRect.width);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, w];
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  return (parts[0][0] + (parts.length > 1 ? parts[parts.length - 1][0] : "")).toUpperCase();
}

function Card({ children, className }: { children: ReactNode; className?: string }) {
  return <section className={`glass rounded-2xl p-4 ${className ?? ""}`}>{children}</section>;
}

function PaneHead({ title, desc }: { title: string; desc: string }) {
  return (
    <header className="px-1">
      <h1 className="text-base font-semibold tracking-tight text-stone-800">{title}</h1>
      <p className="mt-0.5 text-[11px] leading-relaxed text-stone-500">{desc}</p>
    </header>
  );
}

function Field({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-1">
      <span className="shrink-0 text-[10px] font-medium uppercase tracking-wider text-stone-400">{label}</span>
      <span className="gd-mono min-w-0 truncate text-xs text-stone-700">{value}</span>
    </div>
  );
}

const TINTED_SLIDER =
  "[&_[data-slot=slider-range]]:bg-[linear-gradient(90deg,var(--gd-accent),var(--gd-accent-2))] [&_[data-slot=slider-thumb]]:border-stone-200";

export default function SettingsApp({ win }: { win: WindowState }) {
  const dispatch = useGlassDesk((s) => s.dispatch);
  const leave = useGlassDesk((s) => s.leave);
  const state = useGlassDesk((s) => s.state);
  const peers = useGlassDesk((s) => s.peers);
  const selfId = useGlassDesk((s) => s.selfId);
  const code = useGlassDesk((s) => s.code);
  const seat = useGlassDesk((s) => s.seat);
  const connected = useGlassDesk((s) => s.connected);
  const volume = useShellUi((s) => s.volume);
  const setVolume = useShellUi((s) => s.setVolume);
  const brightness = useShellUi((s) => s.brightness);
  const setBrightness = useShellUi((s) => s.setBrightness);

  const [pane, setPane] = useState<PaneId>("appearance");
  const [now, setNow] = useState(() => Date.now());
  const [rootRef, w] = useMeasure<HTMLDivElement>();
  const rail = w > 0 && w < RAIL_AT_W;

  useEffect(() => {
    const iv = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(iv);
  }, []);

  if (!state) return null;

  const acc = accentOf(state.accent);
  const ram = ramUsage(state);
  const diskUsed = fsBytes(state.fs);
  const diskTotal = DISK_GB * 1024 * 1024 * 1024;
  const diskPct = (diskUsed / diskTotal) * 100;
  const files = Object.values(state.fs).filter((n) => n.kind === "file").length;
  const folders = Object.values(state.fs).filter((n) => n.kind === "folder").length;
  const ramTier = RAM_TIERS.find((t) => t.mb === state.machine.ramMB)?.label ?? `${state.machine.ramMB} MB`;
  const peerList = Object.values(peers).sort((a, b) =>
    a.seat === b.seat ? a.name.localeCompare(b.name) : a.seat === "host" ? -1 : 1,
  );
  const muted = volume <= 0.001;

  const pickWallpaper = (id: (typeof WALLPAPERS)[number]["id"], _label: string) => {
    if (state.wallpaper === id) return;
    // SysWatchers pushes the "Wallpaper changed" toast for every sys
    // patch (local + remote + context-menu paths) — no toast here.
    dispatch({ t: "sys", patch: { wallpaper: id } });
  };

  const pickAccent = (id: (typeof ACCENTS)[number]["id"], label: string) => {
    if (state.accent === id) return;
    dispatch({ t: "sys", patch: { accent: id } });
    pushToast({ title: "Accent set", body: label, kind: "info" });
  };

  const paneT = { type: "spring" as const, stiffness: 430, damping: 32 };

  return (
    <div ref={rootRef} className="flex h-full min-h-0 overflow-hidden">
      {/* ---------------- sidebar ---------------- */}
      <nav
        aria-label="Settings sections"
        className={`gd-scroll shrink-0 overflow-y-auto border-r border-white/50 bg-white/25 py-3 ${
          rail ? "w-16 px-2" : "w-[196px] px-3"
        }`}
      >
        {!rail && (
          <div className="flex items-center gap-2.5 px-1.5 pb-3">
            <span
              className="glass-sheen block h-8 w-8 shrink-0 rotate-45 rounded-lg shadow-md"
              style={{ background: `linear-gradient(135deg, ${acc.hex}, ${acc.hex2})` }}
              aria-hidden
            />
            <span className="min-w-0">
              <span className="block text-xs font-semibold text-stone-700">GlassDesk</span>
              <span className="gd-mono block truncate text-[10px] text-stone-400">{state.machine.hostname}</span>
            </span>
          </div>
        )}
        <ul className={rail ? "flex flex-col items-center gap-1.5" : "space-y-1"} role="list">
          {PANES.map((item) => {
            const active = pane === item.id;
            const Icon = item.icon;
            return (
              <li key={item.id} className={rail ? "" : "w-full"}>
                <motion.button
                  type="button"
                  whileTap={{ scale: 0.96 }}
                  transition={{ type: "spring", stiffness: 450, damping: 26 }}
                  onClick={() => setPane(item.id)}
                  aria-current={active ? "page" : undefined}
                  title={item.label}
                  aria-label={item.label}
                  className={`flex w-full items-center rounded-xl text-left transition-colors ${
                    rail ? "h-10 w-10 justify-center" : "gap-2.5 px-2.5 py-2"
                  } ${active ? "shadow-sm" : "hover:bg-white/55"}`}
                  style={active ? { background: `linear-gradient(90deg,${acc.hex}2e,${acc.hex2}1f)` } : undefined}
                >
                  <Icon className={`h-4 w-4 shrink-0 ${active ? "" : "text-stone-400"}`} style={active ? { color: acc.hex } : undefined} />
                  {!rail && (
                    <span className={`truncate text-xs font-medium ${active ? "text-stone-700" : "text-stone-500"}`}>
                      {item.label}
                    </span>
                  )}
                </motion.button>
              </li>
            );
          })}
        </ul>
      </nav>

      {/* ---------------- pane ---------------- */}
      <div className="gd-scroll min-w-0 flex-1 overflow-y-auto">
        <AnimatePresence mode="wait" initial={false}>
          <motion.div
            key={pane}
            initial={{ opacity: 0, x: 16 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: -12 }}
            transition={paneT}
            className="mx-auto flex w-full max-w-md flex-col gap-4 p-4"
            role="tabpanel"
            aria-label={PANES.find((pn) => pn.id === pane)?.label}
          >
            {pane === "appearance" && (
              <>
                <PaneHead
                  title="Appearance"
                  desc="Wallpaper and accent are part of the shared PC — changes sync to both seats instantly."
                />
                <Card>
                  <h2 className="px-0.5 pb-3 text-[10px] font-semibold uppercase tracking-wider text-stone-400">
                    Wallpaper
                  </h2>
                  <div className="grid grid-cols-[repeat(auto-fill,minmax(108px,1fr))] gap-2.5">
                    {WALLPAPERS.map((wp) => {
                      const selected = state.wallpaper === wp.id;
                      return (
                        <motion.button
                          key={wp.id}
                          type="button"
                          whileTap={{ scale: 0.95 }}
                          transition={{ type: "spring", stiffness: 450, damping: 26 }}
                          onClick={() => pickWallpaper(wp.id, wp.label)}
                          aria-pressed={selected}
                          aria-label={`Set wallpaper ${wp.label}`}
                          className="group flex flex-col gap-1.5 text-left"
                        >
                          <span
                            className="relative block aspect-[16/10] w-full overflow-hidden rounded-xl border border-white/70 shadow-sm transition-shadow group-hover:shadow-md"
                            style={{
                              background: swatchBg(wp.swatch),
                              boxShadow: selected ? `0 0 0 2px #ffffff, 0 0 0 4px ${acc.hex}` : undefined,
                            }}
                          >
                            {selected && (
                              <motion.span
                                initial={{ scale: 0, rotate: -30 }}
                                animate={{ scale: 1, rotate: 0 }}
                                transition={{ type: "spring", stiffness: 480, damping: 22 }}
                                className="absolute right-1.5 top-1.5 grid h-5 w-5 place-items-center rounded-full bg-white shadow-md"
                              >
                                <Check className="h-3 w-3" style={{ color: acc.hex }} strokeWidth={3} />
                              </motion.span>
                            )}
                          </span>
                          <span
                            className={`truncate text-center text-[10px] ${
                              selected ? "font-semibold" : "font-normal text-stone-500"
                            }`}
                            style={selected ? { color: acc.hex } : undefined}
                          >
                            {wp.label}
                          </span>
                        </motion.button>
                      );
                    })}
                  </div>
                </Card>
                <Card>
                  <div className="flex items-center justify-between gap-3">
                    <h2 className="text-[10px] font-semibold uppercase tracking-wider text-stone-400">Accent</h2>
                    <span className="gd-mono text-[10px] text-stone-500">{acc.hex}</span>
                  </div>
                  <div className="flex items-center gap-3 pt-3">
                    {ACCENTS.map((a) => {
                      const selected = state.accent === a.id;
                      return (
                        <motion.button
                          key={a.id}
                          type="button"
                          whileHover={{ scale: 1.12 }}
                          whileTap={{ scale: 0.88 }}
                          transition={{ type: "spring", stiffness: 480, damping: 24 }}
                          onClick={() => pickAccent(a.id, a.label)}
                          aria-label={`${a.label} accent`}
                          aria-pressed={selected}
                          title={a.label}
                          className="h-7 w-7 rounded-full border border-black/10 shadow-sm"
                          style={{
                            background: `linear-gradient(135deg, ${a.hex}, ${a.hex2})`,
                            boxShadow: selected ? `0 0 0 2px #ffffff, 0 0 0 4px ${a.hex}` : undefined,
                          }}
                        />
                      );
                    })}
                  </div>
                  <p className="pt-2.5 text-[10px] text-stone-400">
                    Tints windows, controls and highlights across the whole desktop.
                  </p>
                </Card>
              </>
            )}

            {pane === "sound" && (
              <>
                <PaneHead
                  title="Sound & Display"
                  desc="Volume and brightness are per-seat preferences — your co-pilot sets their own."
                />
                <Card>
                  <div className="flex items-center gap-2.5">
                    <button
                      type="button"
                      onClick={() => setVolume(muted ? 0.75 : 0)}
                      aria-label={muted ? "Unmute" : "Mute"}
                      className="grid h-8 w-8 shrink-0 place-items-center rounded-xl bg-white/60 text-stone-500 transition-colors hover:text-stone-700"
                    >
                      {muted ? <VolumeX className="h-4 w-4" /> : <Volume2 className="h-4 w-4" />}
                    </button>
                    <span className="text-xs font-medium text-stone-600">Output volume</span>
                    <span className="gd-mono ml-auto text-[10px] tabular-nums text-stone-500">
                      {Math.round(volume * 100)}%
                    </span>
                  </div>
                  <div className="pt-3">
                    <Slider
                      value={[Math.round(volume * 100)]}
                      min={0}
                      max={100}
                      step={1}
                      aria-label="Output volume"
                      className={TINTED_SLIDER}
                      onValueChange={(v) => setVolume((v[0] ?? 0) / 100)}
                    />
                  </div>
                  <p className="pt-2.5 text-[10px] text-stone-400">
                    Drives the shared synth radio on your speakers only — never synced.
                  </p>
                </Card>
                <Card>
                  <div className="flex items-center gap-2.5">
                    <span className="grid h-8 w-8 shrink-0 place-items-center rounded-xl bg-white/60 text-stone-500">
                      <Sun className="h-4 w-4" />
                    </span>
                    <span className="text-xs font-medium text-stone-600">Brightness</span>
                    <span className="gd-mono ml-auto text-[10px] tabular-nums text-stone-500">
                      {Math.round(brightness * 100)}%
                    </span>
                  </div>
                  <div className="pt-3">
                    <Slider
                      value={[Math.round(brightness * 100)]}
                      min={60}
                      max={100}
                      step={1}
                      aria-label="Display brightness"
                      className={TINTED_SLIDER}
                      onValueChange={(v) => setBrightness((v[0] ?? 0) / 100)}
                    />
                  </div>
                  <p className="pt-2.5 text-[10px] text-stone-400">
                    Softens the desktop veil on this display — your co-pilot sees their own light.
                  </p>
                </Card>
              </>
            )}

            {pane === "network" && (
              <>
                <PaneHead
                  title="Network"
                  desc="The session link that keeps one software PC in sync between both seats."
                />
                <Card>
                  <div className="flex items-center gap-2.5">
                    <span
                      className="grid h-9 w-9 shrink-0 place-items-center rounded-xl text-white shadow-md"
                      style={{ background: `linear-gradient(135deg, ${acc.hex}, ${acc.hex2})` }}
                    >
                      <Wifi className="h-4.5 w-4.5" />
                    </span>
                    <div className="min-w-0">
                      <p className="text-sm font-semibold text-stone-700">glass-net</p>
                      <p className="text-[10px] text-stone-400">live-sync transport · local-1</p>
                    </div>
                    <Badge
                      variant="secondary"
                      className={`ml-auto shrink-0 gap-1.5 text-[10px] ${connected ? "text-emerald-700" : "text-amber-700"}`}
                    >
                      <motion.span
                        className="h-1.5 w-1.5 rounded-full"
                        style={{ background: connected ? "#10b981" : "#f59e0b" }}
                        animate={{ opacity: [1, 0.35, 1] }}
                        transition={{ duration: 2, repeat: Infinity, ease: "easeInOut" }}
                      />
                      {connected ? "connected" : "reconnecting"}
                    </Badge>
                  </div>

                  <div className="mt-3 rounded-xl bg-white/50 px-3 py-2.5 text-center">
                    <p className="text-[9px] font-medium uppercase tracking-wider text-stone-400">Session code</p>
                    <p className="gd-mono select-all pt-0.5 text-xl font-semibold tracking-[0.34em] text-stone-700">
                      {code || "—"}
                    </p>
                  </div>

                  <div className="mt-1 divide-y divide-white/60">
                    <Field label="Your seat" value={seat === "host" ? "host (authority)" : "guest"} />
                    <Field label="Seats linked" value={`${peerList.length} of 2`} />
                    <Field label="Link" value={`up ${fmtUptime(now - state.machine.createdAt)}`} />
                    <Field label="Node" value={state.machine.node} />
                  </div>

                  <div className="flex flex-wrap items-center gap-1.5 pt-3">
                    {peerList.map((peer) => (
                      <span
                        key={peer.id}
                        className="flex items-center gap-1.5 rounded-full bg-white/60 py-1 pl-1 pr-2.5 shadow-sm"
                        title={`${peer.name} · ${peer.host ? "host" : "guest"}`}
                      >
                        <span
                          className={`grid h-6 w-6 place-items-center rounded-full text-[9px] font-semibold text-white ${
                            peer.host ? "bg-gradient-to-br from-teal-400 to-emerald-500" : "bg-gradient-to-br from-amber-400 to-orange-400"
                          }`}
                        >
                          {initials(peer.name)}
                        </span>
                        <span className="max-w-24 truncate text-[11px] text-stone-600">
                          {peer.name}
                          {peer.id === selfId ? " · you" : ""}
                        </span>
                      </span>
                    ))}
                    {peerList.length < 2 && (
                      <span className="flex items-center gap-1.5 text-[11px] text-stone-400">
                        <Users className="h-3.5 w-3.5" />
                        waiting for the second seat…
                      </span>
                    )}
                  </div>
                </Card>
                <Button
                  variant="outline"
                  className="h-10 w-full border-rose-200 text-rose-600 hover:bg-rose-50 hover:text-rose-700"
                  onClick={() => leave()}
                >
                  <LogOut className="h-4 w-4" /> Leave session
                </Button>
              </>
            )}

            {pane === "storage" && (
              <>
                <PaneHead title="Storage" desc="GlassDesk HD — the shared volume snapshotted by snapd every ~1.5 s." />
                <Card>
                  <div className="flex items-center gap-2.5">
                    <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-white/60 text-stone-500">
                      <HardDrive className="h-4.5 w-4.5" />
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-semibold text-stone-700">GlassDesk HD</p>
                      <p className="text-[10px] text-stone-400">
                        {files} files · {folders} folders
                      </p>
                    </div>
                    <span className="gd-mono shrink-0 text-right text-[10px] tabular-nums text-stone-500">
                      {fmtBytes(diskUsed)}
                      <span className="block text-stone-400">of {DISK_GB} GB</span>
                    </span>
                  </div>
                  <div className="mt-3 h-2.5 overflow-hidden rounded-full bg-stone-200/60">
                    <motion.div
                      className="h-full rounded-full"
                      style={{ background: `linear-gradient(90deg, ${acc.hex}, ${acc.hex2})` }}
                      initial={false}
                      animate={{ width: `${Math.max(diskPct, 0.6)}%` }}
                      transition={{ type: "spring", stiffness: 140, damping: 24 }}
                    />
                  </div>
                  <p className="gd-mono pt-2 text-[10px] text-stone-400">
                    {diskPct < 0.01 ? "< 0.01" : diskPct.toFixed(2)}% used · SQLite volume · every file, window and
                    stroke lives here
                  </p>
                </Card>
                <Card>
                  <h2 className="px-0.5 pb-2 text-[10px] font-semibold uppercase tracking-wider text-stone-400">
                    Machine
                  </h2>
                  <div className="divide-y divide-white/60">
                    <Field label="Hostname" value={state.machine.hostname} />
                    <Field label="Memory" value={`${ramTier} · ${state.machine.cores} vCores`} />
                    <Field label="In use" value={`${ram.used} MB of ${ram.total} MB · ${ram.pct}%`} />
                    <Field label="Disk" value={`${DISK_GB} GB virtual`} />
                    <Field label="Node" value={state.machine.node} />
                  </div>
                  <div className="mt-3 h-2 overflow-hidden rounded-full bg-stone-200/60">
                    <motion.div
                      className="gd-accent-gradient h-full rounded-full"
                      initial={false}
                      animate={{ width: `${Math.min(100, Math.max(1, ram.pct))}%` }}
                      transition={{ type: "spring", stiffness: 140, damping: 24 }}
                    />
                  </div>
                </Card>
              </>
            )}

            {pane === "about" && (
              <>
                <PaneHead title="About" desc="One software PC, two pilots, zero installs." />
                <Card className="flex flex-col items-center text-center">
                  <div className="relative grid h-24 w-24 place-items-center" aria-hidden>
                    <div
                      className="glass-sheen absolute h-16 w-16 rotate-45 rounded-[1.25rem] shadow-xl"
                      style={{ background: `linear-gradient(135deg, ${acc.hex}, ${acc.hex2})` }}
                    />
                    <Gem className="relative h-7 w-7 text-white drop-shadow-sm" strokeWidth={1.5} />
                  </div>
                  <h2 className="pt-4 text-xl font-semibold tracking-tight text-stone-800">GlassDesk 3.0</h2>
                  <p className="gd-mono pt-0.5 text-[11px] text-stone-500">kernel gd-3.0.1</p>

                  <div className="mt-4 w-full divide-y divide-white/60">
                    <Field label="Hostname" value={state.machine.hostname} />
                    <Field label="Node" value={state.machine.node} />
                    <Field label="Uptime" value={fmtUptime(now - state.machine.createdAt)} />
                    <Field label="Memory" value={`${ram.used} MB of ${ram.total} MB`} />
                    <Field label="Disk" value={`${fmtBytes(diskUsed)} of ${DISK_GB} GB`} />
                    <Field
                      label="This window"
                      value={`pid ${pidOf(win.id)} · ${APP_RAM.settings} MB`}
                    />
                  </div>

                  <p className="pt-3 text-[10px] text-stone-400">
                    built with Next.js · React · framer-motion
                  </p>
                  <Button
                    variant="outline"
                    size="sm"
                    className="mt-4 gap-1.5"
                    onClick={() => openApp("taskmgr")}
                  >
                    <Activity className="h-3.5 w-3.5" /> Open Task Manager
                  </Button>
                </Card>
              </>
            )}
          </motion.div>
        </AnimatePresence>
      </div>
    </div>
  );
}
