"use client";

// ============================================================
// GlassDesk — Weather: live conditions for any city, shared
// by both seats.
//
// GET /api/vpc/weather?city=… (wttr.in behind it) is fetched
// from the CLIENT with a relative URL; the snapshot is cached
// into win.payload.data + city + fetchedAt, so the co-seat
// gets the exact same report without refetching. Icons follow
// the WWO weatherCode table; a count-up spring lands the big
// temperature when fresh data arrives.
// ============================================================

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { animate, motion } from "framer-motion";
import {
  Clock3,
  Cloud,
  CloudDrizzle,
  CloudFog,
  CloudLightning,
  CloudMoon,
  CloudRain,
  CloudRainWind,
  CloudSnow,
  CloudSun,
  Compass,
  Droplets,
  Eye,
  Gauge,
  MapPin,
  RefreshCw,
  Search,
  Sun,
  Sunrise,
  Sunset,
  Thermometer,
  TriangleAlert,
  Wind,
  type LucideIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { useGlassDesk } from "@/lib/vpc/store";
import type { WindowState } from "@/lib/vpc/types";

// ---------------- payload contract ----------------

interface CurrentWx {
  temperature: number;
  apparent: number;
  humidity: number;
  isDay: boolean;
  precipitation: number;
  weatherCode: number;
  windSpeed: number;
  windDir: number;
  observedAt: string;
  desc: string;
  uv: number;
  pressure: number;
  visibility: number;
  cloudcover: number;
}
interface DailyWx {
  date: string;
  code: number;
  max: number;
  min: number;
  sunrise: string;
  sunset: string;
}
interface WeatherData {
  city: string;
  region: string;
  country: string;
  source: string;
  current: CurrentWx;
  daily: DailyWx[];
}
interface WxPayload {
  city?: string;
  data?: WeatherData | null;
  unit?: "c";
  fetchedAt?: number;
}

const DEFAULT_CITY = "Bengaluru";
const QUICK_CITIES = ["Bengaluru", "Tokyo", "London", "Paris", "New York", "Sydney"];
const SPRING = { type: "spring", stiffness: 400, damping: 30 } as const;

function readWx(winId: string): WxPayload {
  const st = useGlassDesk.getState().state;
  const w = st?.windows.find((x) => x.id === winId);
  return (w?.payload ?? {}) as WxPayload;
}

// ---------------- WWO code → icon (concrete JSX) / skin ----------------

/** WWO weatherCode → lucide icon, following the wttr.in code table. */
function WxIcon({ code, isDay, className }: { code: number; isDay: boolean; className: string }) {
  if (code === 113) return isDay ? <Sun className={className} /> : <CloudMoon className={className} />;
  if (code === 116 || code === 119) return isDay ? <CloudSun className={className} /> : <CloudMoon className={className} />;
  if (code === 122) return <Cloud className={className} />;
  if (code === 143 || code === 248 || code === 260) return <CloudFog className={className} />;
  if (code === 176 || code === 263 || code === 266 || code === 281 || code === 284) return <CloudDrizzle className={className} />;
  if (code === 293 || code === 298 || code === 302 || code === 305 || code === 308) return <CloudRain className={className} />;
  if (code >= 311 && code <= 359) return <CloudRainWind className={className} />;
  if (code === 200 || code === 386 || code === 389 || code === 392 || code === 395) return <CloudLightning className={className} />;
  if (code >= 323 && code <= 371) return <CloudSnow className={className} />;
  if (code === 179 || code === 227 || code === 230 || code === 182 || code === 185 || code === 350 || code === 377)
    return <CloudSnow className={className} />;
  return <Cloud className={className} />;
}

function wxSkin(code: number): { bg: string; fg: string } {
  if (code === 113) return { bg: "from-amber-300 to-orange-400", fg: "text-white drop-shadow-md" };
  if (code === 116 || code === 119) return { bg: "from-amber-200 to-amber-300", fg: "text-amber-700" };
  if (code === 143 || code === 248 || code === 260) return { bg: "from-stone-200 to-stone-400", fg: "text-stone-600" };
  if (code === 176 || code === 263 || code === 266 || code === 281 || code === 284)
    return { bg: "from-teal-200 to-emerald-300", fg: "text-teal-700" };
  if (code === 293 || code === 298 || code === 302 || code === 305 || code === 308)
    return { bg: "from-teal-300 to-emerald-400", fg: "text-white drop-shadow-md" };
  if (code >= 311 && code <= 359) return { bg: "from-teal-400 to-emerald-600", fg: "text-white drop-shadow-md" };
  if (code === 200 || code === 386 || code === 389 || code === 392 || code === 395)
    return { bg: "from-amber-300 to-rose-400", fg: "text-white drop-shadow-md" };
  if (code >= 323 && code <= 371) return { bg: "from-stone-100 to-stone-300", fg: "text-stone-500" };
  return { bg: "from-stone-200 to-stone-300", fg: "text-stone-600" };
}

function dayLabel(date: string, idx: number): string {
  if (idx === 0) return "Today";
  if (idx === 1) return "Tomorrow";
  const d = new Date(`${date}T00:00:00`);
  if (Number.isNaN(d.getTime())) return date;
  return d.toLocaleDateString("en-US", { weekday: "long" });
}

function freshLabel(at: number | undefined, now: number): string {
  if (!at) return "snapshot from your co-seat";
  const s = Math.max(0, Math.floor((now - at) / 1000));
  if (s < 60) return "updated just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `updated ${m} min ago`;
  return `updated ${Math.floor(m / 60)} hr ago`;
}

// ============================================================
// main component
// ============================================================

export default function WeatherApp({ win }: { win: WindowState }) {
  const dispatch = useGlassDesk((s) => s.dispatch);
  const payload = win.payload as Partial<WxPayload>;

  const city = typeof payload.city === "string" && payload.city.trim() ? payload.city : DEFAULT_CITY;
  const raw = payload.data;
  const data = raw && typeof raw === "object" && "current" in raw ? (raw as WeatherData) : null;
  const fetchedAt = typeof payload.fetchedAt === "number" ? payload.fetchedAt : undefined;

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const [draft, setDraft] = useState(city);
  const busyRef = useRef(false);

  // keep the search box in sync when the co-seat changes city
  useEffect(() => {
    setDraft(city);
  }, [city]);

  // live ticker for the freshness badge
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(t);
  }, []);

  const fetchCity = useCallback(
    async (name: string) => {
      const clean = name.trim().slice(0, 64);
      if (!clean || busyRef.current) return;
      busyRef.current = true;
      setLoading(true);
      setError(false);
      try {
        const res = await fetch(`/api/vpc/weather?city=${encodeURIComponent(clean)}`);
        if (!res.ok) throw new Error("bad status");
        const j = (await res.json()) as WeatherData;
        dispatch({
          t: "app:patch",
          id: win.id,
          patch: { city: clean, data: j, unit: "c", fetchedAt: Date.now() },
        });
      } catch {
        setError(true);
      } finally {
        busyRef.current = false;
        setLoading(false);
      }
    },
    [dispatch, win.id],
  );

  // auto-fetch once on mount — but if the co-seat already cached
  // a snapshot in the payload, render it without refetching
  const bootedRef = useRef(false);
  useEffect(() => {
    if (bootedRef.current) return;
    bootedRef.current = true;
    const live = readWx(win.id);
    const liveData = live.data;
    if (!(liveData && typeof liveData === "object" && "current" in liveData)) {
      void fetchCity(city);
    }
  }, [fetchCity, city, win.id]);

  const showSkeleton = loading && !data;

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      {/* ---------------- search header ---------------- */}
      <header className="shrink-0 border-b border-white/60 bg-white/40 px-3 py-2.5">
        <form
          className="relative flex items-center"
          onSubmit={(e) => {
            e.preventDefault();
            void fetchCity(draft);
          }}
        >
          <MapPin className="pointer-events-none absolute left-3 h-3.5 w-3.5 text-stone-400" aria-hidden />
          <Input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="Search any city — try “Reykjavík”"
            aria-label="Search city"
            spellCheck={false}
            className="h-8 rounded-full pl-9 pr-3 text-xs focus-visible:ring-teal-400/50"
          />
          <Button
            type="submit"
            size="icon"
            className="ml-2 h-8 w-8 shrink-0 rounded-full"
            aria-label="Search city"
            title="Get weather"
          >
            <Search className="h-4 w-4" />
          </Button>
        </form>
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          {QUICK_CITIES.map((c) => (
            <button
              key={c}
              type="button"
              onClick={() => {
                setDraft(c);
                void fetchCity(c);
              }}
              aria-pressed={c === city}
              className={`rounded-full px-2.5 py-1 text-[11px] transition-colors focus-visible:ring-2 focus-visible:ring-teal-400/60 ${
                c === city
                  ? "bg-gradient-to-r from-teal-400 to-emerald-400 font-medium text-white shadow-sm"
                  : "bg-white/60 text-stone-600 hover:bg-white/90"
              }`}
            >
              {c}
            </button>
          ))}
        </div>
      </header>

      {/* ---------------- body ---------------- */}
      <div className="gd-scroll min-h-0 flex-1 overflow-y-auto p-4">
        {error ? (
          <div
            role="alert"
            className="flex flex-wrap items-center gap-3 rounded-2xl border border-rose-200 bg-rose-50/80 p-4"
          >
            <TriangleAlert className="h-5 w-5 shrink-0 text-rose-400" aria-hidden />
            <p className="min-w-0 flex-1 text-xs font-medium text-rose-700">
              Couldn&apos;t reach the weather service
            </p>
            <Button
              variant="outline"
              size="sm"
              className="rounded-full border-rose-200 text-rose-600 hover:bg-rose-100"
              onClick={() => void fetchCity(city)}
            >
              <RefreshCw className="h-3.5 w-3.5" /> Retry
            </Button>
          </div>
        ) : showSkeleton ? (
          <WxSkeleton />
        ) : data ? (
          <WxReport
            key={`${data.city}|${data.current.temperature}|${data.current.weatherCode}`}
            data={data}
            loading={loading}
            fresh={freshLabel(fetchedAt, now)}
            onRefresh={() => void fetchCity(city)}
          />
        ) : (
          <WxSkeleton />
        )}
      </div>
    </div>
  );
}

// ============================================================
// report
// ============================================================

function WxReport({
  data,
  loading,
  fresh,
  onRefresh,
}: {
  data: WeatherData;
  loading: boolean;
  fresh: string;
  onRefresh: () => void;
}) {
  const c = data.current;

  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={SPRING}
      className="space-y-3"
    >
      {/* freshness row */}
      <div className="flex items-center justify-between gap-2 px-1">
        <span className="flex items-center gap-1.5 text-[11px] text-stone-400" title="Snapshot cached in the shared session">
          <Clock3 className="h-3 w-3" aria-hidden /> {fresh} · cached
        </span>
        <Button
          variant="ghost"
          size="sm"
          onClick={onRefresh}
          aria-label="Refresh weather"
          title="Refresh"
          className="h-7 rounded-full px-2.5 text-[11px] text-stone-500"
        >
          <RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} /> Refresh
        </Button>
      </div>

      {/* hero */}
      <section className="glass glass-sheen rounded-2xl p-5" aria-label={`Current weather in ${data.city}`}>
        <div className="flex flex-wrap items-center justify-between gap-6">
          <div className="min-w-0">
            <div className="flex items-center gap-1.5 text-xs font-medium text-stone-500">
              <MapPin className="h-3.5 w-3.5 shrink-0 text-rose-400" aria-hidden />
              <span className="truncate">
                {[data.city, data.region, data.country].filter(Boolean).join(" · ")}
              </span>
            </div>
            <div className="mt-2 flex items-start">
              <span className="text-6xl font-extralight tracking-tighter text-stone-800">
                <CountUp key={`${data.city}|${c.temperature}`} value={Math.round(c.temperature)} />
              </span>
              <span className="ml-1 mt-2 text-2xl font-light text-stone-400">°C</span>
            </div>
            <div className="mt-1 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-xs text-stone-500">
              <span className="font-medium">{c.desc || "—"}</span>
              <span aria-hidden className="text-stone-300">
                ·
              </span>
              <span className="text-stone-400">observed {c.observedAt || "recently"}</span>
              <span aria-hidden className="text-stone-300">
                ·
              </span>
              <span className="gd-mono text-[10px] uppercase tracking-wide text-stone-400">{data.source}</span>
            </div>
          </div>

          {/* floating condition icon */}
          <motion.div
            animate={{ y: [0, -7, 0] }}
            transition={{ duration: 4.5, repeat: Infinity, ease: "easeInOut" }}
            className={`grid h-24 w-24 shrink-0 place-items-center rounded-3xl bg-gradient-to-br ${wxSkin(c.weatherCode).bg} shadow-inner`}
            aria-hidden
          >
            <WxIcon code={c.weatherCode} isDay={c.isDay} className={`h-11 w-11 ${wxSkin(c.weatherCode).fg}`} />
          </motion.div>
        </div>
      </section>

      {/* metric chips */}
      <section aria-label="Current conditions detail" className="grid grid-cols-2 gap-2.5 sm:grid-cols-3">
        <Metric icon={Thermometer} label="Feels like" value={`${Math.round(c.apparent)}°`} />
        <Metric icon={Droplets} label="Humidity" value={`${c.humidity}%`} />
        <Metric
          icon={Wind}
          label="Wind"
          value={
            <span className="flex items-center justify-center gap-1.5">
              <motion.span
                animate={{ rotate: c.windDir }}
                transition={{ type: "spring", stiffness: 90, damping: 20 }}
                className="inline-grid"
                aria-hidden
              >
                <Compass className="h-3.5 w-3.5 text-teal-500" />
              </motion.span>
              {Math.round(c.windSpeed)} km/h
            </span>
          }
        />
        <Metric icon={Sun} label="UV index" value={`${Math.round(c.uv)}`} />
        <Metric icon={Gauge} label="Pressure" value={`${c.pressure} hPa`} />
        <Metric icon={Eye} label="Visibility" value={`${c.visibility} km`} />
      </section>

      {/* 3-day forecast */}
      <section aria-label="3-day forecast" className="grid gap-2.5 sm:grid-cols-3">
        {data.daily.slice(0, 3).map((d, i) => (
          <motion.div
            key={d.date || i}
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ ...SPRING, delay: 0.08 + i * 0.07 }}
            className="glass rounded-2xl p-4"
          >
            <div className="flex items-center justify-between gap-2">
              <h3 className="text-xs font-semibold text-stone-700">{dayLabel(d.date, i)}</h3>
              <WxIcon code={d.code} isDay className="h-5 w-5 text-stone-400" />
            </div>
            <div className="mt-3 flex items-baseline gap-2">
              <span className="text-3xl font-semibold tracking-tight text-stone-800">{Math.round(d.max)}°</span>
              <span className="text-sm text-stone-400">{Math.round(d.min)}°</span>
            </div>
            <div className="mt-3 flex items-center justify-between gap-2 text-[10px] text-stone-500">
              <span className="flex items-center gap-1" title="Sunrise">
                <Sunrise className="h-3.5 w-3.5 text-amber-400" aria-hidden /> {d.sunrise || "—"}
              </span>
              <span className="flex items-center gap-1" title="Sunset">
                <Sunset className="h-3.5 w-3.5 text-rose-400" aria-hidden /> {d.sunset || "—"}
              </span>
            </div>
          </motion.div>
        ))}
      </section>
    </motion.div>
  );
}

function Metric({ icon: Icon, label, value }: { icon: LucideIcon; label: string; value: ReactNode }) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={SPRING}
      className="glass flex items-center gap-3 rounded-xl px-3.5 py-3"
    >
      <Icon className="h-4 w-4 shrink-0 text-stone-400" aria-hidden />
      <div className="min-w-0">
        <p className="text-[10px] uppercase tracking-wide text-stone-400">{label}</p>
        <p className="truncate text-sm font-semibold text-stone-700">{value}</p>
      </div>
    </motion.div>
  );
}

/** Spring count-up for the big temperature readout. */
function CountUp({ value }: { value: number }) {
  const [shown, setShown] = useState(0);
  useEffect(() => {
    const controls = animate(0, value, {
      type: "spring",
      stiffness: 90,
      damping: 22,
      onUpdate: (v) => setShown(Math.round(v)),
    });
    return () => controls.stop();
  }, [value]);
  return <span aria-label={`${value} degrees Celsius`}>{shown}</span>;
}

function WxSkeleton() {
  return (
    <div className="space-y-3" aria-hidden>
      <div className="flex items-center justify-between px-1">
        <Skeleton className="h-3.5 w-32 rounded bg-white/70" />
        <Skeleton className="h-7 w-20 rounded-full bg-white/70" />
      </div>
      <Skeleton className="h-44 w-full rounded-2xl bg-white/70" />
      <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3">
        {Array.from({ length: 6 }, (_, i) => (
          <Skeleton key={i} className="h-[62px] rounded-xl bg-white/70" />
        ))}
      </div>
      <div className="grid gap-2.5 sm:grid-cols-3">
        {Array.from({ length: 3 }, (_, i) => (
          <Skeleton key={i} className="h-36 rounded-2xl bg-white/70" />
        ))}
      </div>
    </div>
  );
}
