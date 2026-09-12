"use client";

// ============================================================
// GlassDesk — Start Menu 2.0 (Windows 11 launcher × Apple liquid
// glass). Permanently mounted by the shell, but only renders —
// and only runs its hooks — while uiStore.overlay === "start".
//
//   • TWO TABS
//     – "Pinned": the app grid (every app in the Dock ORDER as a
//       gradient tile) + the 5 newest files on the synced HD,
//       opened straight into TextEdit
//     – "All apps": letter-grouped, scrollable drawer of every
//       app in ORDER — icon tile, name, description line
//   • live search filters BOTH tabs: apps by name/description,
//     recents by file name (Pinned tab)
//   • footer = identity (initials + name + seat) + POWER popover:
//     Lock (local lock screen) · Restart (boot replay — the SAME
//     session auto-rejoins, nothing is lost) · Shut down (leave()
//     → back to the Landing page, rose danger styling)
// Closes on Escape, backdrop pointerdown, or any launch action.
// ============================================================

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { AnimatePresence, motion } from "framer-motion";
import {
  History,
  LayoutGrid,
  List,
  Lock,
  Power,
  RotateCw,
  Search,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { AppIcon } from "@/components/vpc/icons/AppIcon";
import { APP_META, ORDER, openApp } from "@/components/vpc/desktop/Dock";
import { useGlassDesk } from "@/lib/vpc/store";
import { useShellUi } from "@/lib/vpc/uiStore";
import { TRASH_ID } from "@/lib/vpc/trash";
import type { AppKind, FSNode } from "@/lib/vpc/types";

const SPRING = { type: "spring", stiffness: 420, damping: 30 } as const;

/** sessionStorage keys backing the Restart boot replay (consumed in App.tsx). */
const FORCE_BOOT_KEY = "gd:force-boot";
const REJOIN_CODE_KEY = "gd:rejoin-code";

/** One-line app descriptions — the All-apps drawer rows + app search. */
const APP_DESC: Record<AppKind, string> = {
  files: "Browse the shared GlassDesk HD volume",
  textedit: "Plain-text notes, edited together live",
  terminal: "Shell into the software-defined machine",
  whiteboard: "Shared freehand canvas — pen and eraser",
  browser: "Nova — the co-browsing web view",
  media: "Synth radio, in sync and audible on both seats",
  calculator: "Quick math with a tape-style keypad",
  settings: "Wallpaper, accent, sound and machine specs",
  taskmgr: "Live processes, RAM pressure and uptime",
  photos: "Shared gallery — albums, lightbox, memories",
  notes: "Sticky notes on the shared fridge door",
  calendar: "Month view with shared events and reminders",
  clock: "World clock, stopwatch, timer and alarms",
  weather: "Live weather for any city on Earth",
  paint: "Finger-paint together on one canvas",
  mines: "Classic minesweeper — flags, chording, cascade",
  snake: "The snake. It grows. It bites itself.",
  g2048: "Slide the tiles, chase the 2048 tile",
  youtube: "Search and watch YouTube, together",
  ai: "Your on-machine assistant — ask it anything",
  code: "Write and run JavaScript in a real editor",
  mail: "A shared inbox — mail the other seat",
  camera: "Webcam with live filters, captures to Photos",
  voice: "Record memos, transcribed to text by AI",
  maps: "Search the world, drop pins, co-pan the map",
  contacts: "The shared address book — People",
  security: "Tails-style hardening: firewall, spoofing, MAC",
  store: "Install apps — real desktop shortcuts",
};

type Tab = "pinned" | "all";

function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  const first = parts[0].charAt(0);
  const last = parts.length > 1 ? parts[parts.length - 1].charAt(0) : "";
  return (first + last).toUpperCase() || "?";
}

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

function SectionHeader({ icon, label }: { icon: ReactNode; label: string }) {
  return (
    <div className="flex items-center gap-1.5 px-1">
      <span className="grid size-3.5 shrink-0 place-items-center text-stone-400">{icon}</span>
      <h2 className="text-[10px] font-semibold uppercase tracking-wider text-stone-400">{label}</h2>
    </div>
  );
}

function TabButton({
  active,
  onClick,
  icon,
  label,
}: {
  active: boolean;
  onClick: () => void;
  icon: ReactNode;
  label: string;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={`flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--gd-accent)] ${
        active
          ? "bg-white/90 text-stone-700 shadow-sm"
          : "text-stone-400 hover:bg-white/60 hover:text-stone-600"
      }`}
    >
      <span className="grid size-3.5 shrink-0 place-items-center">{icon}</span>
      {label}
    </button>
  );
}

function PowerItem({
  icon,
  label,
  hint,
  danger = false,
  onSelect,
}: {
  icon: ReactNode;
  label: string;
  hint: string;
  danger?: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      aria-label={`${label} — ${hint}`}
      onClick={onSelect}
      className={`flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 ${
        danger
          ? "text-rose-600 hover:bg-rose-50 focus-visible:ring-rose-200"
          : "text-stone-600 hover:bg-white/90 focus-visible:ring-[var(--gd-accent)]"
      }`}
    >
      <span
        className={`grid size-7 shrink-0 place-items-center rounded-lg ${
          danger ? "bg-rose-50 text-rose-500" : "bg-white/70 text-stone-500"
        }`}
      >
        {icon}
      </span>
      <span className="min-w-0 flex-1 leading-tight">
        <span className="block truncate text-xs font-medium">{label}</span>
        <span className="block truncate text-[10px] text-stone-400">{hint}</span>
      </span>
    </button>
  );
}

export default function StartMenu() {
  const open = useShellUi((s) => s.overlay === "start");
  const setOverlay = useShellUi((s) => s.setOverlay);
  return (
    <AnimatePresence>
      {open && <StartPanel key="start-panel" close={() => setOverlay(null)} />}
    </AnimatePresence>
  );
}

function StartPanel({ close }: { close: () => void }) {
  const state = useGlassDesk((s) => s.state);
  const name = useGlassDesk((s) => s.name);
  const seat = useGlassDesk((s) => s.seat);
  const leave = useGlassDesk((s) => s.leave);
  const lock = useShellUi((s) => s.lock);

  const [query, setQuery] = useState("");
  const [tab, setTab] = useState<Tab>("pinned");
  const [powerOpen, setPowerOpen] = useState(false);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const bodyRef = useRef<HTMLDivElement | null>(null);

  // The search field owns the keyboard the moment the menu opens.
  useEffect(() => {
    searchRef.current?.focus();
  }, []);

  // Escape closes the power popover first, then the whole menu
  // (outside clicks land on the transparent backdrop). Capture
  // phase on purpose: SessionView's global bubble-phase Escape
  // handler would otherwise close the menu on the SAME keypress —
  // one Escape must only dismiss the popover.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      if (powerOpen) setPowerOpen(false);
      else close();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [close, powerOpen]);

  const q = query.trim().toLowerCase();

  // App search spans the kind id, the label AND the description —
  // the same filtered list feeds both tabs.
  const apps = useMemo(() => {
    if (!q) return ORDER;
    return ORDER.filter(
      (a) =>
        a.includes(q) ||
        APP_META[a].label.toLowerCase().includes(q) ||
        APP_DESC[a].toLowerCase().includes(q),
    );
  }, [q]);

  const recents = useMemo<FSNode[]>(() => {
    const files = state
      ? Object.values(state.fs)
          .filter((n) => n.kind === "file" && n.parent !== TRASH_ID)
          .sort((a, b) => b.updatedAt - a.updatedAt)
          .slice(0, 5)
      : [];
    return q ? files.filter((n) => n.name.toLowerCase().includes(q)) : files;
  }, [state, q]);

  // All-apps drawer: the ORDER registry, alphabetical, bucketed by the
  // first letter of each label.
  const groups = useMemo(() => {
    const sorted = [...apps].sort((a, b) =>
      APP_META[a].label.localeCompare(APP_META[b].label),
    );
    const out: { letter: string; apps: AppKind[] }[] = [];
    for (const a of sorted) {
      const letter = APP_META[a].label.charAt(0).toUpperCase();
      const last = out[out.length - 1];
      if (last && last.letter === letter) last.apps.push(a);
      else out.push({ letter, apps: [a] });
    }
    return out;
  }, [apps]);

  const noMatches = tab === "pinned" ? apps.length === 0 && recents.length === 0 : apps.length === 0;

  function switchTab(t: Tab): void {
    setTab(t);
    bodyRef.current?.scrollTo({ top: 0 });
  }

  function togglePower(): void {
    setPowerOpen((v) => !v);
  }

  // Restart = a boot-theater REJOIN, never a new session: leave() is
  // NOT called. Stash the code so App.tsx auto-rejoins after the
  // reload, plus the force-boot flag that replays the Desktop boot
  // overlay once the rejoined state lands.
  function restart(): void {
    try {
      sessionStorage.setItem(FORCE_BOOT_KEY, "1");
      const code = useGlassDesk.getState().code;
      if (code) sessionStorage.setItem(REJOIN_CODE_KEY, code);
    } catch {
      /* private mode — plain reload still auto-rejoins via ?join= */
    }
    close();
    window.location.reload();
  }

  function shutDown(): void {
    close();
    leave();
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
        aria-label="Start menu"
        style={{ transformOrigin: "bottom left" }}
        className="glass-strong fixed bottom-[76px] left-3 z-[120] w-[min(94vw,440px)] overflow-hidden rounded-2xl"
        initial={{ opacity: 0, scale: 0.95, y: 14 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.96, y: 10 }}
        transition={SPRING}
      >
        {/* search */}
        <div className="relative p-3 pb-2">
          <Search
            size={14}
            className="pointer-events-none absolute left-6 top-1/2 -translate-y-1/2 text-stone-400"
          />
          <Input
            ref={searchRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search apps and files…"
            aria-label="Search apps and files"
            className="h-9 rounded-xl border-white/60 bg-white/60 pl-9 text-sm text-stone-700 placeholder:text-stone-400"
          />
        </div>

        {/* tabs */}
        <div className="flex items-center gap-1 px-3 pb-2" role="tablist" aria-label="Start menu sections">
          <TabButton
            active={tab === "pinned"}
            onClick={() => switchTab("pinned")}
            icon={<LayoutGrid size={12} />}
            label="Pinned"
          />
          <TabButton
            active={tab === "all"}
            onClick={() => switchTab("all")}
            icon={<List size={12} />}
            label="All apps"
          />
        </div>

        {/* body */}
        <div
          ref={bodyRef}
          className="gd-scroll max-h-[min(70vh,calc(100vh_-_232px))] overflow-y-auto p-3 pt-0"
        >
          {noMatches ? (
            <p className="py-8 text-center text-xs text-stone-400">
              {q ? `No matches for “${query.trim()}”` : "No matches"}
            </p>
          ) : tab === "pinned" ? (
            <div className="space-y-4">
              <section className="space-y-2">
                <SectionHeader icon={<LayoutGrid size={12} />} label="Pinned" />
                <div className="grid grid-cols-5 gap-1.5">
                  {apps.map((app) => {
                    const meta = APP_META[app];
                    return (
                      <motion.button
                        key={app}
                        type="button"
                        aria-label={`Open ${meta.label}`}
                        whileHover={{ scale: 1.06 }}
                        whileTap={{ scale: 0.94 }}
                        transition={{ type: "spring", stiffness: 420, damping: 24 }}
                        onClick={() => {
                          openApp(app);
                          close();
                        }}
                        className="flex flex-col items-center gap-1.5 rounded-xl p-1.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--gd-accent)]"
                      >
                        <AppIcon id={app} size={44} />
                        <span className="w-full truncate text-center text-[10px] text-stone-500">
                          {meta.label}
                        </span>
                      </motion.button>
                    );
                  })}
                </div>
              </section>

              <section className="space-y-1.5">
                <SectionHeader icon={<History size={12} />} label="Recent" />
                {recents.length > 0 ? (
                  <div className="space-y-0.5">
                    {recents.map((n) => (
                      <button
                        key={n.id}
                        type="button"
                        onClick={() => {
                          openApp("textedit", { fileId: n.id, value: n.content });
                          close();
                        }}
                        className="flex w-full items-center gap-2.5 rounded-xl px-2.5 py-2 text-left transition-colors hover:bg-white/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--gd-accent)]"
                      >
                        <AppIcon id="text" size={28} />
                        <span className="min-w-0 flex-1 truncate text-xs font-medium text-stone-700">
                          {n.name}
                        </span>
                        <span className="shrink-0 text-[10px] text-stone-400">
                          {relTime(n.updatedAt, Date.now())}
                        </span>
                      </button>
                    ))}
                  </div>
                ) : (
                  <p className="px-2.5 py-1.5 text-xs text-stone-400">
                    {q ? "no matching files" : "nothing recent yet"}
                  </p>
                )}
              </section>
            </div>
          ) : (
            <div className="space-y-3">
              {groups.map((g) => (
                <section
                  key={g.letter}
                  className="space-y-0.5"
                  aria-label={`Apps starting with ${g.letter}`}
                >
                  <h3 className="gd-mono sticky top-0 z-[2] bg-white/70 px-2 py-1 text-[10px] font-semibold uppercase tracking-widest text-stone-400 backdrop-blur-sm">
                    {g.letter}
                  </h3>
                  {g.apps.map((app) => {
                    const meta = APP_META[app];
                    return (
                      <button
                        key={app}
                        type="button"
                        aria-label={`Open ${meta.label}`}
                        onClick={() => {
                          openApp(app);
                          close();
                        }}
                        className="flex w-full items-center gap-3 rounded-xl px-2 py-1.5 text-left transition-colors hover:bg-white/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--gd-accent)]"
                      >
                        <AppIcon id={app} size={28} />
                        <span className="min-w-0 flex-1 leading-tight">
                          <span className="block truncate text-xs font-medium text-stone-700">
                            {meta.label}
                          </span>
                          <span className="block truncate text-[10px] text-stone-400">
                            {APP_DESC[app]}
                          </span>
                        </span>
                      </button>
                    );
                  })}
                </section>
              ))}
            </div>
          )}
        </div>

        {/* footer — identity + power popover */}
        <div className="relative mt-2 flex items-center gap-2.5 border-t border-white/50 p-3">
          <AnimatePresence>
            {powerOpen && (
              <motion.div
                role="menu"
                aria-label="Power options"
                style={{ transformOrigin: "bottom right" }}
                initial={{ opacity: 0, scale: 0.92, y: 8 }}
                animate={{ opacity: 1, scale: 1, y: 0 }}
                exit={{ opacity: 0, scale: 0.94, y: 6 }}
                transition={SPRING}
                className="glass-strong gd-menu absolute bottom-full right-0 z-10 mb-2 w-52 rounded-xl p-1.5"
              >
                <PowerItem
                  icon={<Lock size={14} />}
                  label="Lock"
                  hint="Lock this screen"
                  onSelect={() => {
                    setPowerOpen(false);
                    lock();
                  }}
                />
                <PowerItem
                  icon={<RotateCw size={14} />}
                  label="Restart"
                  hint="Reboots — session preserved"
                  onSelect={restart}
                />
                <PowerItem
                  icon={<Power size={14} />}
                  label="Shut down"
                  hint="End session, back to landing"
                  danger
                  onSelect={shutDown}
                />
              </motion.div>
            )}
          </AnimatePresence>

          <span className="gd-accent-gradient flex size-8 shrink-0 items-center justify-center rounded-full text-[10px] font-semibold text-white shadow-sm">
            {initialsOf(name)}
          </span>
          <div className="min-w-0 leading-tight">
            <p className="truncate text-xs font-medium text-stone-700">{name || "Unnamed"}</p>
            <p className="text-[10px] text-stone-400">
              {seat === "host" ? "host seat" : seat === "guest" ? "guest seat" : "connecting…"}
            </p>
          </div>
          <div className="flex-1" />
          <Button
            variant="ghost"
            size="icon"
            title="Power"
            aria-label="Power options"
            aria-haspopup="menu"
            aria-expanded={powerOpen}
            onClick={togglePower}
            className="size-9 shrink-0 rounded-xl text-stone-500 hover:bg-white/90 hover:text-stone-700 focus-visible:ring-[var(--gd-accent)]"
          >
            <Power size={16} />
          </Button>
        </div>
      </motion.div>
    </>
  );
}
