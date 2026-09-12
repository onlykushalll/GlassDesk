"use client";

// ============================================================
// GlassDesk — Widgets panel (Windows 11 board × Apple glass).
// A slim edge tab hugs the LEFT edge of the desktop (hover dwell
// or click opens). The board itself is a 340px full-height glass
// sheet spring-sliding from the left with a scrim behind.
//
// WIDGETS (all READ the shared machine — nothing dispatches sync
// ops except explicit launch actions):
//   1. clock — analog SVG, spring-swept second hand, live date
//   2. weather — /api/vpc/weather?city=Bengaluru (wttr.in behind
//      it), module-cached 10 min, skeleton + retry chip
//   3. system — RAM ring (ramUsage), uptime, hostname
//   4. now playing — the shared synth radio's track/play state
//      + 4-bar equalizer (transform-only, only while playing)
//   5. notes — up to 4 .txt files from root + ~/Desktop
//   6. calendar — current month mini-grid, today in accent
//   7. shortcuts — Files / Terminal / Glass AI / Store chips
//
// z map: scrim z-[65] · sheet z-[70] — both BELOW the taskbar
// (z-100, Win11 keeps the bar above the board) and below the
// menubar (z-110). ESC / scrim / X close. Mounted once by
// Desktop.tsx; gated on state.booted so it never pokes through
// the boot overlay (z-60).
// ============================================================

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { AnimatePresence, motion } from "framer-motion";
import {
  CalendarDays,
  Cloud,
  CloudFog,
  CloudLightning,
  CloudMoon,
  CloudRain,
  CloudRainWind,
  CloudSnow,
  CloudSun,
  FileText,
  LayoutGrid,
  Music,
  Pause,
  Play,
  Plus,
  RefreshCw,
  Sun,
  X,
} from "lucide-react";
import { openApp } from "@/components/vpc/desktop/Dock";
import { AppIcon } from "@/components/vpc/icons/AppIcon";
import { Skeleton } from "@/components/ui/skeleton";
import { useGlassDesk } from "@/lib/vpc/store";
import { SPRING, riseIn, stagger } from "@/lib/vpc/motion";
import { TRACK_TITLES } from "@/lib/vpc/media";
import { useShellUi } from "@/lib/vpc/uiStore";
import {
  DESKTOP_NODE_ID,
  fmtUptime,
  ramUsage,
  type AppKind,
  type FSNode,
} from "@/lib/vpc/types";

const DWELL_MS = 180; // edge-tab hover dwell before it opens
const CITY = "Bengaluru";

// ---------------- weather contract (see api/vpc/weather/route.ts) ----------------

interface WxData {
  city: string;
  region: string;
  country: string;
  source: string;
  current: {
    temperature: number;
    desc: string;
    weatherCode: number;
    isDay: boolean;
    humidity: number;
    windSpeed: number;
  };
}

/** module cache — reopening the panel never refetches within the TTL */
let wxCache: { at: number; data: WxData } | null = null;
const WX_TTL_MS = 10 * 60 * 1000;

/** WWO code → lucide icon (concrete JSX, no dynamic maps). */
function WxGlyph({ code, isDay }: { code: number; isDay: boolean }) {
  const cls = "size-9 text-stone-500";
  if (code === 113) return isDay ? <Sun className={cls} /> : <CloudMoon className={cls} />;
  if (code === 116 || code === 119)
    return isDay ? <CloudSun className={cls} /> : <CloudMoon className={cls} />;
  if (code === 122) return <Cloud className={cls} />;
  if (code === 143 || code === 248 || code === 260) return <CloudFog className={cls} />;
  if (code === 200 || code === 386 || code === 389 || code === 392 || code === 395)
    return <CloudLightning className={cls} />;
  if (code >= 176 && code <= 284) return <CloudRain className={cls} />;
  if (code >= 293 && code <= 359) return <CloudRainWind className={cls} />;
  if (code >= 323 && code <= 371) return <CloudSnow className={cls} />;
  return <Cloud className={cls} />;
}

/** three-word flavor line for the weather card. */
function flavorOf(code: number): string {
  if (code === 113) return "golden hour energy";
  if (code === 116 || code === 119) return "soft gray blanket";
  if (code === 122) return "flat cotton sky";
  if (code === 143 || code === 248 || code === 260) return "misty morning maze";
  if (code === 200 || code === 386 || code === 389 || code === 392 || code === 395)
    return "dramatic sky theater";
  if (code >= 176 && code <= 284) return "gentle drizzle hours";
  if (code >= 293 && code <= 359) return "petrichor and puddles";
  if (code >= 323 && code <= 371) return "quiet snow hush";
  return "sky doing things";
}

// ============================================================
// root — edge tab + gated sheet
// ============================================================

export default function WidgetsPanel() {
  const open = useShellUi((s) => s.widgetsOpen);
  const setWidgetsOpen = useShellUi((s) => s.setWidgetsOpen);
  const booted = useGlassDesk((s) => (s.state ? s.state.booted : false));

  const dwellT = useRef<number | null>(null);

  // never leak the dwell timer
  useEffect(() => {
    return () => {
      if (dwellT.current !== null) window.clearTimeout(dwellT.current);
    };
  }, []);

  function openPanel(): void {
    if (dwellT.current !== null) {
      window.clearTimeout(dwellT.current);
      dwellT.current = null;
    }
    setWidgetsOpen(true);
  }

  return (
    <>
      {/* edge tab — 28×64 glass sliver on the left edge, gently
          pulsing. Hover (dwell) or click opens the board. Hides
          while the board is open, and during boot (below z-60).
          Plain wrapper owns the vertical centering translate so
          framer's x/opacity transform can never clobber it. */}
      {!open && booted && (
        <div className="absolute left-0 top-1/2 z-[70] -translate-y-1/2">
          <motion.button
            type="button"
            aria-label="Open widgets"
            onClick={openPanel}
            onPointerEnter={() => {
              dwellT.current = window.setTimeout(openPanel, DWELL_MS);
            }}
            onPointerLeave={() => {
              if (dwellT.current !== null) {
                window.clearTimeout(dwellT.current);
                dwellT.current = null;
              }
            }}
            className="glass flex h-16 w-7 items-center justify-center rounded-r-xl shadow-lg"
            initial={{ opacity: 0, x: -10 }}
            animate={{ opacity: [0.72, 1, 0.72], x: 0 }}
            transition={{
              opacity: { duration: 2.8, repeat: Infinity, ease: "easeInOut" },
              x: { ...SPRING.window, delay: 0.25 },
            }}
          >
            <LayoutGrid size={13} className="text-stone-600" />
          </motion.button>
        </div>
      )}

      <AnimatePresence>
        {open && <Board key="widgets-board" close={() => setWidgetsOpen(false)} />}
      </AnimatePresence>
    </>
  );
}

// ============================================================
// the board sheet
// ============================================================

function Board({ close }: { close: () => void }) {
  // Escape closes from anywhere
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [close]);

  return (
    <>
      {/* scrim — click closes (sits below the sheet, above windows) */}
      <motion.div
        aria-hidden
        onPointerDown={close}
        className="absolute inset-0 z-[65] bg-stone-900/15"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        transition={{ duration: 0.18 }}
      />

      {/* the sheet */}
      <motion.aside
        role="dialog"
        aria-label="Widgets panel"
        className="glass-strong absolute inset-y-0 left-0 z-[70] flex w-[340px] flex-col overflow-hidden rounded-r-2xl"
        initial={{ x: "-100%" }}
        animate={{ x: 0 }}
        exit={{ x: "-100%" }}
        transition={SPRING.sheet}
      >
        <div className="flex items-center gap-2 border-b border-white/50 p-3.5">
          <span className="grid size-7 shrink-0 place-items-center rounded-lg bg-white/80 text-stone-500">
            <LayoutGrid size={14} />
          </span>
          <h2 className="text-sm font-semibold text-stone-700">Widgets</h2>
          <span className="rounded-full bg-emerald-50 px-2 py-0.5 text-[10px] font-medium text-emerald-600">
            live on this machine
          </span>
          <div className="flex-1" />
          <button
            type="button"
            aria-label="Close widgets"
            onClick={close}
            className="grid size-7 place-items-center rounded-lg text-stone-400 transition-colors hover:bg-white/80 hover:text-stone-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--gd-accent)]"
          >
            <X size={15} />
          </button>
        </div>

        {/* widget grid — 2 columns, staggered rise-in */}
        <motion.div
          variants={stagger(0.05, 0.04)}
          initial="hidden"
          animate="show"
          className="gd-scroll grid min-h-0 flex-1 grid-cols-2 content-start gap-3 overflow-y-auto p-3.5"
        >
          <Card className="col-span-2">
            <ClockWidget />
          </Card>
          <Card>
            <WeatherWidget />
          </Card>
          <Card>
            <SystemWidget />
          </Card>
          <Card>
            <NowPlayingWidget />
          </Card>
          <Card>
            <NotesWidget />
          </Card>
          <Card>
            <CalendarWidget />
          </Card>
          <Card className="col-span-2">
            <ShortcutsWidget />
          </Card>
        </motion.div>
      </motion.aside>
    </>
  );
}

function Card({ children, className = "" }: { children: ReactNode; className?: string }) {
  return (
    <motion.section
      variants={riseIn}
      className={`glass rounded-2xl p-4 ${className}`}
    >
      {children}
    </motion.section>
  );
}

// ============================================================
// 1. clock
// ============================================================

function ClockWidget() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = window.setInterval(() => setNow(new Date()), 1000);
    return () => window.clearInterval(t);
  }, []);

  const secAngle = now.getSeconds() * 6;
  const minAngle = (now.getMinutes() + now.getSeconds() / 60) * 6;
  const hourAngle = ((now.getHours() % 12) + now.getMinutes() / 60) * 30;

  return (
    <div className="flex items-center gap-4">
      <svg viewBox="0 0 100 100" className="size-24 shrink-0" role="img" aria-label="Analog clock">
        <circle cx="50" cy="50" r="47" fill="rgba(255,255,255,0.55)" stroke="rgba(255,255,255,0.8)" strokeWidth="1" />
        {/* ticks — 12 hour marks, quarters heavier */}
        {Array.from({ length: 12 }, (_, i) => {
          const a = (i * 30 * Math.PI) / 180;
          const r1 = i % 3 === 0 ? 36 : 39;
          const x1 = 50 + r1 * Math.sin(a);
          const y1 = 50 - r1 * Math.cos(a);
          const x2 = 50 + 43 * Math.sin(a);
          const y2 = 50 - 43 * Math.cos(a);
          return (
            <line
              key={i}
              x1={x1}
              y1={y1}
              x2={x2}
              y2={y2}
              stroke="rgba(68,64,60,0.55)"
              strokeWidth={i % 3 === 0 ? 2.4 : 1.2}
              strokeLinecap="round"
            />
          );
        })}
        {/* hour hand */}
        <motion.line
          x1="50" y1="50" x2="50" y2="27"
          stroke="#44403c" strokeWidth="4" strokeLinecap="round"
          style={{ transformOrigin: "50px 50px" }}
          animate={{ rotate: hourAngle }}
          transition={{ type: "spring", stiffness: 260, damping: 26 }}
        />
        {/* minute hand */}
        <motion.line
          x1="50" y1="50" x2="50" y2="17"
          stroke="#57534e" strokeWidth="2.6" strokeLinecap="round"
          style={{ transformOrigin: "50px 50px" }}
          animate={{ rotate: minAngle }}
          transition={{ type: "spring", stiffness: 300, damping: 28 }}
        />
        {/* second hand — spring-sweeps each tick */}
        <motion.line
          x1="50" y1="56" x2="50" y2="13"
          stroke="var(--gd-accent)" strokeWidth="1.6" strokeLinecap="round"
          style={{ transformOrigin: "50px 50px" }}
          animate={{ rotate: secAngle }}
          transition={SPRING.snappy}
        />
        <circle cx="50" cy="50" r="3" fill="var(--gd-accent)" />
      </svg>
      <div className="min-w-0">
        <p className="gd-mono text-2xl font-light tabular-nums tracking-tight text-stone-700">
          {now.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" })}
          <span className="text-sm text-stone-400">
            :{now.getSeconds().toString().padStart(2, "0")}
          </span>
        </p>
        <p className="mt-1 text-[11px] font-medium text-stone-500">
          {now.toLocaleDateString("en-US", { weekday: "long" })}
        </p>
        <p className="text-[11px] text-stone-400">
          {now.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" })}
        </p>
      </div>
    </div>
  );
}

// ============================================================
// 2. weather
// ============================================================

function WeatherWidget() {
  const [data, setData] = useState<WxData | null>(wxCache?.data ?? null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const busyRef = useRef(false);

  const fetchWx = useCallback(async () => {
    if (busyRef.current) return;
    busyRef.current = true;
    setLoading(true);
    setError(false);
    try {
      const res = await fetch(`/api/vpc/weather?city=${encodeURIComponent(CITY)}`);
      if (!res.ok) throw new Error("bad status");
      const j = (await res.json()) as WxData;
      wxCache = { at: Date.now(), data: j };
      setData(j);
    } catch {
      setError(true);
    } finally {
      busyRef.current = false;
      setLoading(false);
    }
  }, []);

  // auto-fetch on open — only when the module cache is stale
  useEffect(() => {
    if (wxCache && Date.now() - wxCache.at < WX_TTL_MS) return;
    void fetchWx();
  }, [fetchWx]);

  if (!data && loading) {
    return (
      <div className="space-y-2.5">
        <div className="flex items-center justify-between">
          <Skeleton className="h-3 w-20" />
          <Skeleton className="size-6 rounded-md" />
        </div>
        <Skeleton className="h-8 w-24" />
        <Skeleton className="h-3 w-28" />
        <Skeleton className="h-3 w-16" />
      </div>
    );
  }

  if (!data) {
    // fetch failed with nothing cached
    return (
      <div className="flex flex-col items-start gap-2">
        <div className="flex items-center gap-1.5">
          <CloudSun size={13} className="text-stone-400" />
          <h3 className="text-[10px] font-semibold uppercase tracking-wider text-stone-400">
            Weather
          </h3>
        </div>
        <p className="text-xs text-stone-500">Couldn&apos;t reach the weather service.</p>
        <button
          type="button"
          onClick={() => void fetchWx()}
          className="rounded-full bg-white/70 px-2.5 py-1 text-[11px] font-medium transition-colors hover:bg-white"
          style={{ border: "1px solid color-mix(in srgb, var(--gd-accent) 40%, transparent)", color: "var(--gd-accent)" }}
        >
          Retry
        </button>
      </div>
    );
  }

  const cur = data.current;

  return (
    <div>
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1.5">
          <h3 className="text-[10px] font-semibold uppercase tracking-wider text-stone-400">
            Weather
          </h3>
        </div>
        <button
          type="button"
          aria-label="Refresh weather"
          onClick={() => void fetchWx()}
          className="grid size-6 place-items-center rounded-md text-stone-400 transition-colors hover:bg-white/80 hover:text-stone-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--gd-accent)]"
        >
          <RefreshCw size={12} className={loading ? "animate-spin" : ""} />
        </button>
      </div>
      <div className="mt-1 flex items-center gap-2">
        <WxGlyph code={cur.weatherCode} isDay={cur.isDay} />
        <div className="min-w-0">
          <p className="gd-mono text-3xl font-light tabular-nums tracking-tight text-stone-700">
            {Math.round(cur.temperature)}°
          </p>
          <p className="truncate text-[11px] text-stone-500">{cur.desc}</p>
        </div>
      </div>
      <p className="mt-1.5 text-[11px] italic text-stone-400">{flavorOf(cur.weatherCode)}</p>
      <p className="mt-1 flex items-center gap-1 text-[10px] text-stone-400">
        {data.city}
        {data.country ? `, ${data.country}` : ""}
        {error && <span className="ml-1 text-rose-500">· refresh failed</span>}
      </p>
    </div>
  );
}

// ============================================================
// 3. system
// ============================================================

const RING_CIRC = 2 * Math.PI * 26; // r=26 in the 64×64 viewBox

function SystemWidget() {
  const state = useGlassDesk((s) => s.state);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 10_000);
    return () => window.clearInterval(t);
  }, []);

  if (!state) return null;
  const ram = ramUsage(state);

  return (
    <div className="flex items-center gap-3">
      {/* RAM ring */}
      <div className="relative grid size-16 shrink-0 place-items-center">
        <svg viewBox="0 0 64 64" className="size-16" aria-hidden>
          <circle cx="32" cy="32" r="26" fill="none" stroke="rgba(68,64,60,0.10)" strokeWidth="6" />
          <motion.circle
            cx="32"
            cy="32"
            r="26"
            fill="none"
            stroke="var(--gd-accent)"
            strokeWidth="6"
            strokeLinecap="round"
            strokeDasharray={RING_CIRC}
            transform="rotate(-90 32 32)"
            initial={{ strokeDashoffset: RING_CIRC }}
            animate={{ strokeDashoffset: RING_CIRC * (1 - ram.pct / 100) }}
            transition={SPRING.window}
          />
        </svg>
        <span className="absolute gd-mono text-xs font-semibold tabular-nums text-stone-600">
          {ram.pct}%
        </span>
      </div>
      <div className="min-w-0 flex-1">
        <h3 className="text-[10px] font-semibold uppercase tracking-wider text-stone-400">
          System
        </h3>
        <p className="mt-0.5 text-[11px] text-stone-600">
          {ram.used} / {ram.total} MB in use
        </p>
        <p className="text-[11px] text-stone-400">up {fmtUptime(now - state.machine.createdAt)}</p>
        <p className="gd-mono truncate text-[11px] text-stone-500">{state.machine.hostname}</p>
      </div>
    </div>
  );
}

// ============================================================
// 4. now playing
// ============================================================

function NowPlayingWidget() {
  const mediaWin = useGlassDesk((s) =>
    s.state ? s.state.windows.find((w) => w.app === "media") : undefined,
  );
  const playing = mediaWin?.payload?.playing === true;
  const trackIdx = typeof mediaWin?.payload?.track === "number" ? mediaWin.payload.track : 0;
  const title = TRACK_TITLES[trackIdx] ?? "—";

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between">
        <h3 className="text-[10px] font-semibold uppercase tracking-wider text-stone-400">
          Now playing
        </h3>
        {playing ? <EqBars /> : <Pause size={12} className="text-stone-400" />}
      </div>

      <div className="mt-2 flex items-center gap-2">
        <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-gradient-to-br from-rose-400 to-pink-400 text-white shadow-sm">
          <Music size={14} />
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-xs font-medium text-stone-700">
            {mediaWin ? title : "Nothing playing"}
          </p>
          <p className="truncate text-[10px] text-stone-400">
            {mediaWin ? (playing ? "synth radio · live" : "paused") : "the radio is off"}
          </p>
        </div>
      </div>

      <button
        type="button"
        onClick={() => openApp("media")}
        className="mt-2.5 flex items-center justify-center gap-1.5 rounded-lg bg-white/70 px-2 py-1.5 text-[11px] font-medium text-stone-600 transition-colors hover:bg-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--gd-accent)]"
      >
        <Play size={11} className="fill-current" />
        Open Media
      </button>
    </div>
  );
}

/** 4-bar equalizer — transform-only loop, rendered only while playing. */
function EqBars() {
  return (
    <span className="flex h-3.5 items-end gap-[2px]" aria-hidden>
      {[0, 1, 2, 3].map((i) => (
        <motion.span
          key={i}
          className="w-[3px] rounded-full"
          style={{
            height: "100%",
            transformOrigin: "bottom",
            background: "linear-gradient(180deg, var(--gd-accent), var(--gd-accent-2))",
          }}
          animate={{ scaleY: [0.25, 1, 0.4, 0.85, 0.25] }}
          transition={{ duration: 1 + i * 0.14, repeat: Infinity, ease: "easeInOut" }}
        />
      ))}
    </span>
  );
}

// ============================================================
// 5. notes
// ============================================================

function NotesWidget() {
  const fs = useGlassDesk((s) => (s.state ? s.state.fs : null));

  const notes: FSNode[] = fs
    ? Object.values(fs)
        .filter(
          (n) =>
            n.kind === "file" &&
            n.name.toLowerCase().endsWith(".txt") &&
            (n.parent === null || n.parent === DESKTOP_NODE_ID),
        )
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .slice(0, 4)
    : [];

  return (
    <div>
      <div className="flex items-center justify-between">
        <h3 className="text-[10px] font-semibold uppercase tracking-wider text-stone-400">
          Notes
        </h3>
        <button
          type="button"
          onClick={() => openApp("textedit")}
          className="flex items-center gap-0.5 rounded-md px-1.5 py-0.5 text-[10px] font-medium text-[var(--gd-accent)] transition-colors hover:bg-white/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--gd-accent)]"
        >
          <Plus size={10} />
          New
        </button>
      </div>

      <div className="mt-2 space-y-1">
        {notes.length === 0 ? (
          <p className="text-[11px] text-stone-400">No text files yet</p>
        ) : (
          notes.map((n) => (
            <button
              key={n.id}
              type="button"
              onClick={() => openApp("textedit", { fileId: n.id, value: n.content })}
              className="flex w-full items-center gap-1.5 rounded-lg px-1.5 py-1 text-left transition-colors hover:bg-white/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--gd-accent)]"
            >
              <FileText size={12} className="shrink-0 text-stone-400" />
              <span className="truncate text-[11px] text-stone-600">{n.name}</span>
            </button>
          ))
        )}
      </div>
    </div>
  );
}

// ============================================================
// 6. mini calendar
// ============================================================

const WEEKDAYS = ["S", "M", "T", "W", "T", "F", "S"];

function CalendarWidget() {
  const today = new Date();
  const year = today.getFullYear();
  const month = today.getMonth();
  const todayDay = today.getDate();
  const start = new Date(year, month, 1).getDay();
  const days = new Date(year, month + 1, 0).getDate();
  const cells: (number | null)[] = [];
  for (let i = 0; i < Math.ceil((start + days) / 7) * 7; i++) {
    cells.push(i < start || i >= start + days ? null : i - start + 1);
  }

  return (
    <div>
      <div className="flex items-center justify-between">
        <h3 className="flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wider text-stone-400">
          <CalendarDays size={11} />
          {today.toLocaleDateString("en-US", { month: "long" })}
        </h3>
        <span className="text-[10px] tabular-nums text-stone-400">{year}</span>
      </div>

      <div className="mt-2 grid grid-cols-7 gap-y-0.5 text-center">
        {WEEKDAYS.map((d, i) => (
          <span key={`wd-${i}`} className="text-[9px] font-medium text-stone-400">
            {d}
          </span>
        ))}
        {cells.map((day, i) => {
          const isToday = day === todayDay;
          return (
            <span
              key={`c-${i}`}
              className={`mx-auto grid size-[18px] place-items-center rounded-full text-[10px] tabular-nums ${
                isToday
                  ? "gd-accent-gradient font-semibold text-white shadow-sm"
                  : "text-stone-500"
              }`}
            >
              {day ?? ""}
            </span>
          );
        })}
      </div>
    </div>
  );
}

// ============================================================
// 7. shortcuts
// ============================================================

const SHORTCUTS: { app: AppKind; label: string }[] = [
  { app: "files", label: "Files" },
  { app: "terminal", label: "Terminal" },
  { app: "ai", label: "Glass AI" },
  { app: "store", label: "Store" },
];

function ShortcutsWidget() {
  return (
    <div>
      <h3 className="text-[10px] font-semibold uppercase tracking-wider text-stone-400">
        Shortcuts
      </h3>
      <div className="mt-2 grid grid-cols-4 gap-2">
        {SHORTCUTS.map(({ app, label }) => {
          return (
            <motion.button
              key={app}
              type="button"
              onClick={() => openApp(app)}
              whileHover={{ scale: 1.045 }}
              whileTap={{ scale: 0.95 }}
              transition={SPRING.snappy}
              className="flex flex-col items-center gap-1.5 rounded-xl bg-white/60 p-2 transition-colors hover:bg-white/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--gd-accent)]"
              aria-label={`Open ${label}`}
            >
              <AppIcon id={app} size={32} />
              <span className="text-[10px] font-medium text-stone-600">{label}</span>
            </motion.button>
          );
        })}
      </div>
    </div>
  );
}
