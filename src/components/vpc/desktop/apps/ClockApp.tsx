"use client";

// ============================================================
// GlassDesk — Clock. World · Stopwatch · Timer · Alarm.
// Synced via payload: { tab, cities, alarms }. High-frequency
// stuff (stopwatch centiseconds, the timer countdown) stays in
// local state; only meaningful checkpoints (tab, city list,
// alarm definitions) ride app:patch so both seats agree.
// ============================================================

import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import {
  AlarmClock as AlarmClockIcon,
  Check,
  Flag,
  Globe2,
  Moon,
  Pause,
  Play,
  Plus,
  RotateCcw,
  Sun,
  Timer as TimerIcon,
  Trash2,
  Watch,
  X,
} from "lucide-react";
import { useGlassDesk } from "@/lib/vpc/store";
import { pushToast } from "@/lib/vpc/toast";
import { uid, type WindowState } from "@/lib/vpc/types";
import { Switch } from "@/components/ui/switch";

type ClockTab = "world" | "stopwatch" | "timer" | "alarm";

interface Alarm {
  id: string;
  time: string; // "HH:MM"
  label: string;
  on: boolean;
  days: "once" | "daily";
}

const SPRING = { type: "spring", stiffness: 420, damping: 30 } as const;
const SOFT_SPRING = { type: "spring", stiffness: 380, damping: 28 } as const;

const TABS: { id: ClockTab; label: string; icon: typeof Globe2 }[] = [
  { id: "world", label: "World", icon: Globe2 },
  { id: "stopwatch", label: "Stopwatch", icon: Watch },
  { id: "timer", label: "Timer", icon: TimerIcon },
  { id: "alarm", label: "Alarm", icon: AlarmClockIcon },
];

const DEFAULT_CITIES = ["Asia/Tokyo", "America/New_York", "Europe/London", "Australia/Sydney"];
const CITIES_CAP = 10;
const ALARMS_CAP = 12;

const TZ_PRESETS: { tz: string; city: string; country: string }[] = [
  { tz: "Asia/Tokyo", city: "Tokyo", country: "Japan" },
  { tz: "Asia/Dubai", city: "Dubai", country: "UAE" },
  { tz: "Asia/Kolkata", city: "Mumbai", country: "India" },
  { tz: "Asia/Singapore", city: "Singapore", country: "Singapore" },
  { tz: "Asia/Hong_Kong", city: "Hong Kong", country: "China" },
  { tz: "Europe/London", city: "London", country: "UK" },
  { tz: "Europe/Paris", city: "Paris", country: "France" },
  { tz: "Europe/Berlin", city: "Berlin", country: "Germany" },
  { tz: "Europe/Moscow", city: "Moscow", country: "Russia" },
  { tz: "America/New_York", city: "New York", country: "USA" },
  { tz: "America/Chicago", city: "Chicago", country: "USA" },
  { tz: "America/Los_Angeles", city: "Los Angeles", country: "USA" },
  { tz: "America/Sao_Paulo", city: "São Paulo", country: "Brazil" },
  { tz: "Australia/Sydney", city: "Sydney", country: "Australia" },
  { tz: "Pacific/Auckland", city: "Auckland", country: "NZ" },
  { tz: "Pacific/Honolulu", city: "Honolulu", country: "USA" },
];

// ---------------- formatting helpers (formatter cache — one
// DateTimeFormat per tz+opts, not one per second) ----------------

const FMT_CACHE = new Map<string, Intl.DateTimeFormat>();

function fmtFor(tz: string, opts: Intl.DateTimeFormatOptions): Intl.DateTimeFormat | null {
  const key = `${tz}|${JSON.stringify(opts)}`;
  let f = FMT_CACHE.get(key);
  if (!f) {
    try {
      f = new Intl.DateTimeFormat("en-US", { ...opts, timeZone: tz });
    } catch {
      return null; // invalid tz — never crash the window
    }
    FMT_CACHE.set(key, f);
  }
  return f;
}

function pad(n: number): string {
  return n.toString().padStart(2, "0");
}

function partsIn(tz: string, date: Date): { h: string; m: string; s: string; ap: string } {
  const f = fmtFor(tz, { hour: "numeric", minute: "2-digit", second: "2-digit", hour12: true });
  if (!f) return { h: "--", m: "--", s: "--", ap: "" };
  const parts = f.formatToParts(date);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return { h: get("hour"), m: get("minute"), s: get("second"), ap: get("dayPeriod") };
}

function dayLabelIn(tz: string, date: Date): string {
  const f = fmtFor(tz, { weekday: "short", day: "numeric", month: "short" });
  return f ? f.format(date) : "";
}

function hourIn(tz: string, date: Date): number {
  const f = fmtFor(tz, { hour: "numeric", hourCycle: "h23" });
  if (!f) return 12;
  const v = Number(f.format(date));
  return Number.isFinite(v) ? v % 24 : 12;
}

function cityLabel(tz: string): { city: string; country: string } {
  const p = TZ_PRESETS.find((x) => x.tz === tz);
  if (p) return { city: p.city, country: p.country };
  const last = tz.split("/").pop() ?? tz;
  return { city: last.replace(/_/g, " "), country: tz.split("/")[0]?.replace(/_/g, " ") ?? "" };
}

// ---------------- payload parsing (defensive) ----------------

function parseCities(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const c of raw) {
    if (typeof c !== "string") continue;
    if (!fmtFor(c, { hour: "numeric" })) continue; // validates the tz
    out.push(c);
  }
  return [...new Set(out)].slice(0, CITIES_CAP);
}

function parseAlarms(raw: unknown): Alarm[] {
  if (!Array.isArray(raw)) return [];
  const out: Alarm[] = [];
  for (const item of raw.slice(0, ALARMS_CAP)) {
    if (typeof item !== "object" || item === null) continue;
    const a = item as Record<string, unknown>;
    if (typeof a.time !== "string" || !/^([01]\d|2[0-3]):[0-5]\d$/.test(a.time)) continue;
    out.push({
      id: typeof a.id === "string" ? a.id : uid(),
      time: a.time,
      label: typeof a.label === "string" ? a.label.slice(0, 60) : "",
      on: a.on === true,
      days: a.days === "daily" ? "daily" : "once",
    });
  }
  return out;
}

// ---------------- audio: lazy, guarded, 880Hz 0.3s ----------------

let audioCtx: AudioContext | null = null;

function beep(): void {
  try {
    const Ctor =
      window.AudioContext ??
      (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return;
    audioCtx = audioCtx ?? new Ctor();
    if (audioCtx.state === "suspended") void audioCtx.resume();
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.type = "sine";
    osc.frequency.value = 880;
    const t0 = audioCtx.currentTime;
    gain.gain.setValueAtTime(0.0001, t0);
    gain.gain.exponentialRampToValueAtTime(0.18, t0 + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.3);
    osc.connect(gain);
    gain.connect(audioCtx.destination);
    osc.start(t0);
    osc.stop(t0 + 0.32);
  } catch {
    // autoplay policies / blocked audio — the toast still fires
  }
}

// ---------------- stopwatch formatting ----------------

function fmtStopwatch(ms: number): string {
  const cs = Math.floor(ms / 10) % 100;
  const s = Math.floor(ms / 1000) % 60;
  const m = Math.floor(ms / 60000) % 60;
  const h = Math.floor(ms / 3600000);
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}.${pad(cs)}` : `${pad(m)}:${pad(s)}.${pad(cs)}`;
}

function fmtTimer(ms: number): string {
  const s = Math.ceil(ms / 1000);
  const hh = Math.floor(s / 3600);
  const mm = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  return hh > 0 ? `${hh}:${pad(mm)}:${pad(ss)}` : `${pad(mm)}:${pad(ss)}`;
}

export default function ClockApp({ win }: { win: WindowState }) {
  const liveWin = useGlassDesk((s) => s.state?.windows.find((w) => w.id === win.id));
  const dispatch = useGlassDesk((s) => s.dispatch);
  const w = liveWin ?? win;

  const payload = w.payload as { tab?: unknown; cities?: unknown; alarms?: unknown };
  const tab: ClockTab = TABS.some((t) => t.id === payload.tab)
    ? (payload.tab as ClockTab)
    : "world";
  const cities = Array.isArray(payload.cities) ? parseCities(payload.cities) : DEFAULT_CITIES;
  const alarms = parseAlarms(payload.alarms);

  const patch = useCallback(
    (p: Record<string, unknown>) => dispatch({ t: "app:patch", id: win.id, patch: p }),
    [dispatch, win.id],
  );

  // shared 1s heartbeat — world clocks + alarm watcher
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = window.setInterval(() => setNow(new Date()), 1000);
    return () => window.clearInterval(id);
  }, []);

  // ---- stopwatch state (lifted to the root so the run survives
  // tab switches — local only, never synced) ----------------
  const [swRunning, setSwRunning] = useState(false);
  const [swElapsed, setSwElapsed] = useState(0);
  const [swLaps, setSwLaps] = useState<{ lap: number; split: number; total: number }[]>([]);
  const swStartRef = useRef(0);
  const swBaseRef = useRef(0);

  useEffect(() => {
    if (!swRunning) return;
    swStartRef.current = Date.now();
    const id = window.setInterval(() => {
      setSwElapsed(swBaseRef.current + (Date.now() - swStartRef.current));
    }, 10);
    return () => window.clearInterval(id);
  }, [swRunning]);

  const swToggle = () => {
    if (swRunning) {
      swBaseRef.current += Date.now() - swStartRef.current;
      setSwElapsed(swBaseRef.current);
      setSwRunning(false);
    } else {
      setSwRunning(true);
    }
  };

  const swReset = () => {
    setSwRunning(false);
    swBaseRef.current = 0;
    setSwElapsed(0);
    setSwLaps([]);
  };

  const swLap = () => {
    if (swElapsed <= 0) return;
    const prev = swLaps.length > 0 ? swLaps[swLaps.length - 1].total : 0;
    setSwLaps((ls) => [...ls, { lap: ls.length + 1, split: swElapsed - prev, total: swElapsed }]);
  };

  // ---- timer state (lifted — keeps counting in other tabs) --
  const [tDuration, setTDuration] = useState(5 * 60_000);
  const [tRemaining, setTRemaining] = useState(5 * 60_000);
  const [tRunning, setTRunning] = useState(false);
  const [tFinished, setTFinished] = useState(false);
  const tEndRef = useRef(0);

  useEffect(() => {
    if (!tRunning) return;
    const id = window.setInterval(() => {
      const rem = tEndRef.current - Date.now();
      if (rem <= 0) {
        setTRemaining(0);
        setTRunning(false);
        setTFinished(true);
        pushToast({
          title: "Timer done ⏰",
          body: `${fmtTimer(tDuration)} elapsed — back to it.`,
          kind: "success",
        });
        beep();
      } else {
        setTRemaining(rem);
      }
    }, 100);
    return () => window.clearInterval(id);
  }, [tRunning, tDuration]);

  const tApply = useCallback((ms: number) => {
    setTRunning(false);
    setTFinished(false);
    setTDuration(ms);
    setTRemaining(ms);
  }, []);

  const tStart = useCallback(() => {
    if (tRemaining <= 0) return;
    tEndRef.current = Date.now() + tRemaining;
    setTFinished(false);
    setTRunning(true);
  }, [tRemaining]);

  // seed a starter alarm once (deterministic id → idempotent)
  const seededRef = useRef(false);
  useEffect(() => {
    if (seededRef.current) return;
    seededRef.current = true;
    if (payload.alarms !== undefined) return;
    patch({
      alarms: [
        { id: "alarm-wake", time: "07:30", label: "Wake up", on: true, days: "daily" },
        { id: "alarm-stand", time: "15:00", label: "Stand up & stretch", on: false, days: "daily" },
      ] satisfies Alarm[],
    });
  }, [payload.alarms, patch]);

  // alarm watcher: reads the STORE (never a stale closure) so remote
  // alarm edits are honored; fires toast + beep once per minute.
  useEffect(() => {
    const fired = new Set<string>();
    const id = window.setInterval(() => {
      const d = new Date();
      const hhmm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
      const dayKey = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
      const s = useGlassDesk.getState();
      const live = s.state?.windows.find((x) => x.id === win.id);
      const list = parseAlarms(live?.payload.alarms);
      let changed = false;
      for (const a of list) {
        if (!a.on || a.time !== hhmm) continue;
        const key = `${a.id}|${dayKey}|${a.time}`;
        if (fired.has(key)) continue;
        fired.add(key);
        pushToast({ title: "Alarm ⏰", body: a.label ? `${a.label} · ${a.time}` : a.time, kind: "info" });
        beep();
        if (a.days === "once") changed = true;
      }
      if (changed) {
        const next = list.map((a) =>
          a.on && a.days === "once" && a.time === hhmm ? { ...a, on: false } : a,
        );
        dispatch({ t: "app:patch", id: win.id, patch: { alarms: next } });
      }
      if (fired.size > 64) fired.clear();
    }, 1000);
    return () => window.clearInterval(id);
  }, [dispatch, win.id]);

  return (
    <div className="flex h-full flex-col overflow-hidden bg-white/25">
      {/* ------------------------- tabs ------------------------- */}
      <div className="flex shrink-0 gap-1 border-b border-white/60 bg-white/35 px-2 py-2" role="tablist" aria-label="Clock modes">
        {TABS.map((t) => {
          const Icon = t.icon;
          const active = tab === t.id;
          return (
            <button
              key={t.id}
              type="button"
              role="tab"
              aria-selected={active}
              onClick={() => patch({ tab: t.id })}
              className={`relative flex flex-1 items-center justify-center gap-1.5 rounded-lg px-2 py-1.5 text-xs font-medium outline-none focus-visible:ring-2 focus-visible:ring-stone-300 ${
                active ? "text-stone-800" : "text-stone-500 hover:bg-white/50 hover:text-stone-700"
              }`}
            >
              {active && (
                <motion.span
                  layoutId="clock-tab-pill"
                  className="absolute inset-0 rounded-lg bg-white/85 shadow-sm ring-1 ring-white/70"
                  transition={SPRING}
                />
              )}
              <Icon className="relative z-10 size-3.5" aria-hidden="true" />
              <span className="relative z-10">{t.label}</span>
            </button>
          );
        })}
      </div>

      {/* ------------------------- content ------------------------- */}
      <div className="gd-scroll min-h-0 flex-1 overflow-y-auto">
        <AnimatePresence mode="wait" initial={false}>
          <motion.div
            key={tab}
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -10 }}
            transition={SOFT_SPRING}
          >
            {tab === "world" && (
              <WorldTab now={now} cities={cities} patch={patch} />
            )}
            {tab === "stopwatch" && (
              <StopwatchTab
                running={swRunning}
                elapsed={swElapsed}
                laps={swLaps}
                onToggle={swToggle}
                onReset={swReset}
                onLap={swLap}
              />
            )}
            {tab === "timer" && (
              <TimerTab
                duration={tDuration}
                remaining={tRemaining}
                running={tRunning}
                finished={tFinished}
                onApply={tApply}
                onStart={tStart}
                onPause={() => setTRunning(false)}
              />
            )}
            {tab === "alarm" && <AlarmTab alarms={alarms} patch={patch} winId={win.id} />}
          </motion.div>
        </AnimatePresence>
      </div>
    </div>
  );
}

// ============================================================
// WORLD — local hero clock + synced city cards
// ============================================================

// memoized: the stopwatch ticks at 100Hz in the root — the world
// grid only re-renders when `now` (1s) or the city list changes.
const WorldTab = memo(function WorldTab({
  now,
  cities,
  patch,
}: {
  now: Date;
  cities: string[];
  patch: (p: Record<string, unknown>) => void;
}) {
  const [adding, setAdding] = useState(false);
  const localTz = useMemo(() => Intl.DateTimeFormat().resolvedOptions().timeZone, []);
  const local = partsIn(localTz, now);
  const localLabel = cityLabel(localTz);
  const localDate = new Intl.DateTimeFormat("en-US", {
    weekday: "long",
    day: "numeric",
    month: "long",
  }).format(now);

  const removeCity = (tz: string) => patch({ cities: cities.filter((c) => c !== tz) });

  const addCity = (tz: string) => {
    if (cities.includes(tz)) return;
    if (cities.length >= CITIES_CAP) {
      pushToast({
        title: "City limit reached",
        body: `${CITIES_CAP} clocks is plenty — remove one first.`,
        kind: "warn",
      });
      return;
    }
    patch({ cities: [...cities, tz] });
    setAdding(false);
  };

  return (
    <div className="flex flex-col gap-3 p-3">
      <div className="glass-strong rounded-2xl px-4 py-4 text-center">
        <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-stone-400">
          Local time · {localLabel.city}
        </p>
        <p className="gd-mono mt-1.5 text-[2.6rem] font-semibold leading-none tabular-nums text-stone-800">
          {local.h}:{local.m}
          <span className="text-xl text-teal-600">:{local.s}</span>{" "}
          <span className="text-sm text-stone-500">{local.ap}</span>
        </p>
        <p className="mt-1.5 text-xs text-stone-500">{localDate}</p>
      </div>

      <div className="relative flex items-center justify-between px-1">
        <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-stone-400">
          World clocks · synced
        </p>
        <motion.button
          type="button"
          whileTap={{ scale: 0.94 }}
          transition={SPRING}
          onClick={() => setAdding((a) => !a)}
          aria-expanded={adding}
          aria-label={adding ? "Close add city menu" : "Add a city"}
          className="glass flex items-center gap-1 rounded-full px-2.5 py-1 text-[11px] font-medium text-stone-600 hover:bg-white/80"
        >
          {adding ? <X className="size-3" aria-hidden="true" /> : <Plus className="size-3" aria-hidden="true" />}
          {adding ? "Close" : "Add city"}
        </motion.button>

        <AnimatePresence>
          {adding && (
            <motion.div
              initial={{ opacity: 0, y: -6, scale: 0.97 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: -6, scale: 0.97 }}
              transition={SOFT_SPRING}
              className="glass-strong gd-scroll absolute right-0 top-8 z-20 max-h-64 w-60 overflow-y-auto rounded-xl p-1.5 shadow-xl"
              role="menu"
              aria-label="Preset cities"
            >
              {TZ_PRESETS.filter((p) => !cities.includes(p.tz)).map((p) => {
                const t = partsIn(p.tz, now);
                return (
                  <button
                    key={p.tz}
                    type="button"
                    role="menuitem"
                    onClick={() => addCity(p.tz)}
                    className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-xs text-stone-700 outline-none hover:bg-white/80 focus-visible:ring-2 focus-visible:ring-stone-300"
                  >
                    <Plus className="size-3 text-teal-600" aria-hidden="true" />
                    <span className="flex-1 truncate">
                      <span className="font-medium">{p.city}</span>{" "}
                      <span className="text-stone-400">{p.country}</span>
                    </span>
                    <span className="gd-mono text-[10px] tabular-nums text-stone-400">
                      {t.h}:{t.m} {t.ap}
                    </span>
                  </button>
                );
              })}
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      <div className="grid grid-cols-2 gap-2">
        {cities.map((tz) => {
          const t = partsIn(tz, now);
          const hour = hourIn(tz, now);
          const isDay = hour >= 6 && hour < 18;
          const label = cityLabel(tz);
          return (
            <div key={tz} className="glass group relative flex flex-col gap-1 rounded-xl p-3">
              <div className="flex items-center gap-1.5">
                {isDay ? (
                  <Sun className="size-4 shrink-0 text-amber-500" aria-label="Daytime" />
                ) : (
                  <Moon className="size-4 shrink-0 text-stone-400" aria-label="Nighttime" />
                )}
                <p className="truncate text-xs font-semibold text-stone-700">{label.city}</p>
                <motion.button
                  type="button"
                  whileTap={{ scale: 0.88 }}
                  transition={SPRING}
                  onClick={() => removeCity(tz)}
                  aria-label={`Remove ${label.city}`}
                  className="ml-auto grid size-5 shrink-0 place-items-center rounded-md text-stone-300 opacity-0 outline-none transition-opacity hover:bg-rose-100 hover:text-rose-500 focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-rose-300 group-hover:opacity-100"
                >
                  <X className="size-3" aria-hidden="true" />
                </motion.button>
              </div>
              <p className="gd-mono text-xl font-semibold leading-none tabular-nums text-stone-800">
                {t.h}:{t.m}
                <span className="text-xs font-medium text-stone-400">:{t.s}</span>{" "}
                <span className="text-[10px] text-stone-400">{t.ap}</span>
              </p>
              <p className="text-[10px] text-stone-400">
                {dayLabelIn(tz, now)}
                {label.country ? ` · ${label.country}` : ""}
              </p>
            </div>
          );
        })}
      </div>
    </div>
  );
});

// ============================================================
// STOPWATCH — presentational; the run lives in the ClockApp
// root so it keeps ticking in other tabs (local, never synced)
// ============================================================

interface StopwatchTabProps {
  running: boolean;
  elapsed: number;
  laps: { lap: number; split: number; total: number }[];
  onToggle: () => void;
  onReset: () => void;
  onLap: () => void;
}

function StopwatchTab({ running, elapsed, laps, onToggle, onReset, onLap }: StopwatchTabProps) {
  return (
    <div className="flex flex-col items-center gap-4 p-4">
      <div className="glass-strong rounded-2xl px-6 py-5 text-center">
        <p className="gd-mono text-4xl font-semibold tabular-nums text-stone-800" aria-live="off">
          {fmtStopwatch(elapsed)}
        </p>
        <p className="mt-1 text-[10px] font-medium uppercase tracking-[0.14em] text-stone-400">
          {running ? "running" : elapsed > 0 ? "paused" : "ready"}
        </p>
      </div>

      <div className="flex items-center gap-2">
        <motion.button
          type="button"
          whileTap={{ scale: 0.94 }}
          transition={SPRING}
          onClick={onLap}
          disabled={!running}
          aria-label="Record lap"
          className="glass flex h-10 items-center gap-1.5 rounded-full px-4 text-xs font-medium text-stone-600 outline-none transition-opacity enabled:hover:bg-white/80 disabled:opacity-40 focus-visible:ring-2 focus-visible:ring-stone-300"
        >
          <Flag className="size-3.5" aria-hidden="true" />
          Lap
        </motion.button>
        <motion.button
          type="button"
          whileTap={{ scale: 0.94 }}
          transition={SPRING}
          onClick={onToggle}
          className={`flex h-10 items-center gap-1.5 rounded-full px-5 text-xs font-semibold text-white shadow-sm outline-none transition-[filter] hover:brightness-105 focus-visible:ring-2 focus-visible:ring-stone-300 ${
            running ? "bg-[linear-gradient(135deg,#f59e0b,#fb923c)]" : "gd-accent-gradient"
          }`}
        >
          {running ? <Pause className="size-3.5" aria-hidden="true" /> : <Play className="size-3.5" aria-hidden="true" />}
          {running ? "Pause" : elapsed > 0 ? "Resume" : "Start"}
        </motion.button>
        <motion.button
          type="button"
          whileTap={{ scale: 0.94 }}
          transition={SPRING}
          onClick={onReset}
          disabled={elapsed === 0 && laps.length === 0}
          aria-label="Reset stopwatch"
          className="glass flex size-10 items-center justify-center rounded-full text-stone-500 outline-none transition-opacity enabled:hover:bg-white/80 disabled:opacity-40 focus-visible:ring-2 focus-visible:ring-stone-300"
        >
          <RotateCcw className="size-4" aria-hidden="true" />
        </motion.button>
      </div>

      {laps.length > 0 ? (
        <div className="glass w-full overflow-hidden rounded-xl">
          <div className="flex items-center justify-between border-b border-white/60 px-3 py-1.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-stone-400">
            <span>Lap</span>
            <span>Split</span>
            <span>Total</span>
          </div>
          <ul className="gd-scroll max-h-44 overflow-y-auto">
            {[...laps].reverse().map((l) => (
              <li
                key={l.lap}
                className="flex items-center justify-between border-b border-white/40 px-3 py-1.5 last:border-b-0"
              >
                <span className="text-xs font-medium text-stone-500">Lap {l.lap}</span>
                <span className="gd-mono text-xs font-semibold tabular-nums text-teal-700">
                  {fmtStopwatch(l.split)}
                </span>
                <span className="gd-mono text-xs tabular-nums text-stone-400">
                  {fmtStopwatch(l.total)}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <p className="text-[11px] text-stone-400">
          Local only — laps never leave this seat.
        </p>
      )}
    </div>
  );
}

// ============================================================
// TIMER — presentational (ring + presets + custom); countdown
// state lives in the root so it survives tab switches
// ============================================================

const TIMER_PRESETS: { label: string; ms: number }[] = [
  { label: "1 min", ms: 60_000 },
  { label: "5 min", ms: 5 * 60_000 },
  { label: "10 min", ms: 10 * 60_000 },
  { label: "25 min · Pomodoro", ms: 25 * 60_000 },
];

const RING_R = 88;
const RING_C = 2 * Math.PI * RING_R;

interface TimerTabProps {
  duration: number;
  remaining: number;
  running: boolean;
  finished: boolean;
  onApply: (ms: number) => void;
  onStart: () => void;
  onPause: () => void;
}

const TimerTab = memo(function TimerTab({ duration, remaining, running, finished, onApply, onStart, onPause }: TimerTabProps) {
  const [h, setH] = useState("0");
  const [m, setM] = useState("0");
  const [s, setS] = useState("0");

  const progress = duration > 0 ? Math.max(0, Math.min(1, remaining / duration)) : 0;

  const applyCustom = () => {
    const hh = Math.max(0, Math.min(23, Number(h) || 0));
    const mm = Math.max(0, Math.min(59, Number(m) || 0));
    const ss = Math.max(0, Math.min(59, Number(s) || 0));
    const ms = (hh * 3600 + mm * 60 + ss) * 1000;
    if (ms <= 0) {
      pushToast({ title: "Set a duration", body: "Give the timer at least one second.", kind: "warn" });
      return;
    }
    onApply(ms);
  };

  return (
    <div className="flex flex-col items-center gap-4 p-4">
      {/* ring */}
      <div className="relative grid size-[200px] shrink-0 place-items-center">
        <svg viewBox="0 0 200 200" className="absolute inset-0 size-full -rotate-90" aria-hidden="true">
          <defs>
            <linearGradient id="gd-timer-grad" x1="0" y1="0" x2="1" y2="1">
              <stop offset="0%" stopColor="#14b8a6" />
              <stop offset="100%" stopColor="#10b981" />
            </linearGradient>
          </defs>
          <circle cx="100" cy="100" r={RING_R} fill="none" stroke="rgba(120,113,108,0.15)" strokeWidth="10" />
          <circle
            cx="100"
            cy="100"
            r={RING_R}
            fill="none"
            stroke="url(#gd-timer-grad)"
            strokeWidth="10"
            strokeLinecap="round"
            strokeDasharray={RING_C}
            strokeDashoffset={RING_C * (1 - progress)}
          />
        </svg>
        <div className="relative z-10 text-center">
          <p className="gd-mono text-3xl font-semibold tabular-nums text-stone-800" aria-live="off">
            {fmtTimer(remaining)}
          </p>
          {finished ? (
            <p className="mt-1 flex items-center justify-center gap-1 text-[11px] font-semibold text-emerald-600">
              <Check className="size-3.5" aria-hidden="true" />
              Done — take a breath
            </p>
          ) : (
            <p className="mt-1 text-[10px] font-medium uppercase tracking-[0.14em] text-stone-400">
              {running ? "counting down" : `of ${fmtTimer(duration)}`}
            </p>
          )}
        </div>
      </div>

      {/* controls */}
      <div className="flex items-center gap-2">
        <motion.button
          type="button"
          whileTap={{ scale: 0.94 }}
          transition={SPRING}
          onClick={() => (running ? onPause() : onStart())}
          disabled={!running && remaining <= 0}
          className={`flex h-10 items-center gap-1.5 rounded-full px-5 text-xs font-semibold text-white shadow-sm outline-none transition-[filter] enabled:hover:brightness-105 disabled:opacity-40 focus-visible:ring-2 focus-visible:ring-stone-300 ${
            running ? "bg-[linear-gradient(135deg,#f59e0b,#fb923c)]" : "gd-accent-gradient"
          }`}
        >
          {running ? <Pause className="size-3.5" aria-hidden="true" /> : <Play className="size-3.5" aria-hidden="true" />}
          {running ? "Pause" : "Start"}
        </motion.button>
        <motion.button
          type="button"
          whileTap={{ scale: 0.94 }}
          transition={SPRING}
          onClick={() => onApply(duration)}
          disabled={!running && remaining === duration}
          aria-label="Reset timer"
          className="glass flex size-10 items-center justify-center rounded-full text-stone-500 outline-none transition-opacity enabled:hover:bg-white/80 disabled:opacity-40 focus-visible:ring-2 focus-visible:ring-stone-300"
        >
          <RotateCcw className="size-4" aria-hidden="true" />
        </motion.button>
      </div>

      {/* presets */}
      <div className="flex flex-wrap justify-center gap-1.5">
        {TIMER_PRESETS.map((p) => {
          const active = duration === p.ms;
          return (
            <motion.button
              key={p.label}
              type="button"
              whileTap={{ scale: 0.93 }}
              transition={SPRING}
              onClick={() => onApply(p.ms)}
              aria-pressed={active}
              className={`rounded-full px-3 py-1.5 text-[11px] font-medium outline-none focus-visible:ring-2 focus-visible:ring-stone-300 ${
                active
                  ? "gd-accent-gradient text-white shadow-sm"
                  : "glass text-stone-600 hover:bg-white/80"
              }`}
            >
              {p.label}
            </motion.button>
          );
        })}
      </div>

      {/* custom */}
      <div className="glass flex w-full flex-wrap items-end justify-center gap-2 rounded-xl p-2.5">
        {(
          [
            { v: h, set: setH, label: "Hours", max: 23 },
            { v: m, set: setM, label: "Minutes", max: 59 },
            { v: s, set: setS, label: "Seconds", max: 59 },
          ] as const
        ).map((f) => (
          <label key={f.label} className="flex flex-col items-center gap-1">
            <span className="text-[9px] font-semibold uppercase tracking-[0.12em] text-stone-400">
              {f.label}
            </span>
            <input
              type="number"
              min={0}
              max={f.max}
              value={f.v}
              onChange={(e) => f.set(e.target.value.replace(/\D/g, "").slice(0, 2))}
              aria-label={`${f.label} for custom timer`}
              className="glass-strong gd-mono size-14 rounded-lg py-1 text-center text-sm font-semibold tabular-nums text-stone-700 outline-none focus-visible:ring-2 focus-visible:ring-teal-300"
            />
          </label>
        ))}
        <motion.button
          type="button"
          whileTap={{ scale: 0.94 }}
          transition={SPRING}
          onClick={applyCustom}
          className="glass flex h-8 items-center gap-1 rounded-lg px-3 text-xs font-semibold text-teal-700 hover:bg-white/80 focus-visible:ring-2 focus-visible:ring-teal-300"
        >
          <Check className="size-3.5" aria-hidden="true" />
          Set
        </motion.button>
      </div>
    </div>
  );
});

// ============================================================
// ALARM — synced list, minute-watcher in the root component
// ============================================================

const AlarmTab = memo(function AlarmTab({
  alarms,
  patch,
  winId,
}: {
  alarms: Alarm[];
  patch: (p: Record<string, unknown>) => void;
  winId: string;
}) {
  const [time, setTime] = useState("07:30");
  const [label, setLabel] = useState("");
  const [days, setDays] = useState<"once" | "daily">("once");

  /** Freshest alarms straight from the store (beats stale closures
   *  when several toggles land within one render). */
  const currentAlarms = useCallback((): Alarm[] => {
    const s = useGlassDesk.getState();
    const live = s.state?.windows.find((x) => x.id === winId);
    return live ? parseAlarms(live.payload.alarms) : alarms;
  }, [winId, alarms]);

  const sorted = [...alarms].sort((a, b) => a.time.localeCompare(b.time));

  return (
    <div className="flex flex-col gap-3 p-3">
      <p className="px-1 text-[10px] font-semibold uppercase tracking-[0.14em] text-stone-400">
        Alarms · synced to both seats
      </p>

      {/* add form */}
      <div className="glass flex flex-col gap-2.5 rounded-xl p-3">
        <div className="flex flex-wrap items-end gap-2">
          <label className="flex flex-col gap-1">
            <span className="text-[9px] font-semibold uppercase tracking-[0.12em] text-stone-400">
              Time
            </span>
            <input
              type="time"
              value={time}
              onChange={(e) => setTime(e.target.value)}
              aria-label="Alarm time"
              className="glass-strong gd-mono h-9 rounded-lg px-2.5 text-sm font-semibold tabular-nums text-stone-700 outline-none focus-visible:ring-2 focus-visible:ring-teal-300"
            />
          </label>
          <label className="flex min-w-0 flex-1 flex-col gap-1">
            <span className="text-[9px] font-semibold uppercase tracking-[0.12em] text-stone-400">
              Label
            </span>
            <input
              type="text"
              value={label}
              onChange={(e) => setLabel(e.target.value.slice(0, 60))}
              placeholder="e.g. Stand-up call"
              aria-label="Alarm label"
              className="glass-strong h-9 rounded-lg px-2.5 text-xs text-stone-700 outline-none placeholder:text-stone-400 focus-visible:ring-2 focus-visible:ring-teal-300"
            />
          </label>
        </div>
        <div className="flex items-center gap-2">
          <div className="flex rounded-lg bg-white/50 p-0.5" role="group" aria-label="Repeat mode">
            {(["once", "daily"] as const).map((d) => (
              <button
                key={d}
                type="button"
                onClick={() => setDays(d)}
                aria-pressed={days === d}
                className={`relative rounded-md px-3 py-1 text-[11px] font-medium capitalize outline-none focus-visible:ring-2 focus-visible:ring-stone-300 ${
                  days === d ? "bg-white text-stone-800 shadow-sm" : "text-stone-500"
                }`}
              >
                {d}
              </button>
            ))}
          </div>
          <motion.button
            type="button"
            whileTap={{ scale: 0.95 }}
            transition={SPRING}
            onClick={() => {
              if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) {
                pushToast({ title: "Pick a valid time", body: "Alarms need a real HH:MM.", kind: "warn" });
                return;
              }
              const list = currentAlarms();
              if (list.length >= ALARMS_CAP) {
                pushToast({ title: "Alarm limit reached", body: `${ALARMS_CAP} alarms is the max.`, kind: "warn" });
                return;
              }
              patch({
                alarms: [
                  ...list,
                  { id: uid(), time, label: label.trim(), on: true, days },
                ],
              });
              setLabel("");
              pushToast({ title: "Alarm set ⏰", body: `${time}${label.trim() ? ` · ${label.trim()}` : ""} — ${days}`, kind: "success" });
            }}
            className="gd-accent-gradient ml-auto flex h-8 items-center gap-1.5 rounded-lg px-3.5 text-xs font-semibold text-white shadow-sm outline-none transition-[filter] hover:brightness-105 focus-visible:ring-2 focus-visible:ring-stone-300"
          >
            <Plus className="size-3.5" aria-hidden="true" />
            Add alarm
          </motion.button>
        </div>
      </div>

      {/* list */}
      {sorted.length === 0 ? (
        <div className="glass flex flex-col items-center gap-2 rounded-xl px-6 py-8 text-center">
          <div className="grid size-12 place-items-center rounded-full bg-white/70">
            <AlarmClockIcon className="size-6 text-stone-300" aria-hidden="true" />
          </div>
          <p className="text-sm font-medium text-stone-600">No alarms</p>
          <p className="text-xs text-stone-400">Mornings are safe… for now.</p>
        </div>
      ) : (
        <ul className="flex flex-col gap-2">
          <AnimatePresence mode="popLayout">
            {sorted.map((a) => (
              <motion.li
                key={a.id}
                layout
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, scale: 0.94 }}
                transition={SOFT_SPRING}
                className="glass flex items-center gap-3 rounded-xl p-3"
              >
                <span
                  className={`gd-mono w-14 text-2xl font-semibold tabular-nums ${
                    a.on ? "text-stone-800" : "text-stone-300"
                  }`}
                >
                  {a.time}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium text-stone-700">
                    {a.label || "Alarm"}
                  </span>
                  <span className="mt-0.5 inline-flex items-center gap-1">
                    <span
                      className={`rounded-full px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide ${
                        a.days === "daily"
                          ? "bg-emerald-100/80 text-emerald-700"
                          : "bg-amber-100/80 text-amber-700"
                      }`}
                    >
                      {a.days}
                    </span>
                    {!a.on && (
                      <span className="text-[9px] font-semibold uppercase tracking-wide text-stone-400">
                        off
                      </span>
                    )}
                  </span>
                </span>
                <Switch
                  checked={a.on}
                  onCheckedChange={(v) =>
                    patch({
                      alarms: currentAlarms().map((x) => (x.id === a.id ? { ...x, on: v } : x)),
                    })
                  }
                  aria-label={`${a.on ? "Disable" : "Enable"} alarm ${a.label || a.time}`}
                />
                <motion.button
                  type="button"
                  whileTap={{ scale: 0.88 }}
                  transition={SPRING}
                  onClick={() =>
                    patch({ alarms: currentAlarms().filter((x) => x.id !== a.id) })
                  }
                  aria-label={`Delete alarm ${a.label || a.time}`}
                  className="grid size-7 shrink-0 place-items-center rounded-lg text-stone-400 outline-none hover:bg-rose-100 hover:text-rose-500 focus-visible:ring-2 focus-visible:ring-rose-300"
                >
                  <Trash2 className="size-4" aria-hidden="true" />
                </motion.button>
              </motion.li>
            ))}
          </AnimatePresence>
        </ul>
      )}
    </div>
  );
});
