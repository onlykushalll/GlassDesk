"use client";

// ============================================================
// GlassDesk — Maps. A real OpenStreetMap window shared by BOTH
// seats: the current VIEW is the synced payload ({q, pin, z}), so
// any patch (place pick, zoom, node locate) re-renders the OSM
// embed on every seat — literal co-panning. Place search runs
// through /api/vpc/geocode (our Nominatim proxy — CORS relief).
// ============================================================

import { useCallback, useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import {
  Copy,
  Loader2,
  LocateFixed,
  MapPin,
  Minus,
  Plus,
  Search,
  Server,
  Users,
  X,
} from "lucide-react";
import { pushToast } from "@/lib/vpc/toast";
import { SPRING, pop, riseIn, stagger } from "@/lib/vpc/motion";
import { useGlassDesk } from "@/lib/vpc/store";
import type { WindowState } from "@/lib/vpc/types";

// ---------------- payload contract ----------------

interface Pin {
  lat: number;
  lon: number;
  label: string;
}
interface P {
  q: string;
  pin: Pin | null;
  z: number;
}
interface Hit {
  name: string;
  lat: number;
  lon: number;
  kind: string;
}

/** The shared machine's home node — also the default map view. */
const NODE: Pin = { lat: 12.9716, lon: 77.5946, label: "GlassDesk node local-1 · Bengaluru" };
const HOME = { lat: NODE.lat, lon: NODE.lon };
const Z_MIN = 3;
const Z_MAX = 17;
const Z_DEFAULT = 11;
const SUGG_CAP = 6; // geocode rows in the dropdown

const QUICK: { label: string; full: string; lat: number; lon: number }[] = [
  { label: "Bengaluru", full: "Bengaluru, Karnataka, India", lat: 12.9716, lon: 77.5946 },
  { label: "Tokyo", full: "Tokyo, Japan", lat: 35.6762, lon: 139.6503 },
  { label: "Paris", full: "Paris, Île-de-France, France", lat: 48.8566, lon: 2.3522 },
  { label: "London", full: "London, United Kingdom", lat: 51.5074, lon: -0.1278 },
  { label: "New York", full: "New York City, NY, United States", lat: 40.7128, lon: -74.006 },
];

// ---------------- helpers ----------------

function clampZ(raw: unknown): number {
  const n = typeof raw === "number" && Number.isFinite(raw) ? raw : Z_DEFAULT;
  return Math.min(Z_MAX, Math.max(Z_MIN, Math.round(n)));
}

/** Defensive payload → pin (old windows may lack the field). */
function parsePin(raw: unknown): Pin | null {
  if (typeof raw !== "object" || raw === null) return null;
  const o = raw as Record<string, unknown>;
  const lat = Number(o.lat);
  const lon = Number(o.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  return { lat, lon, label: typeof o.label === "string" ? o.label : "" };
}

function shortName(full: string): string {
  return full.split(",")[0]?.trim() || full;
}

function coordText(lat: number, lon: number): string {
  const ns = lat >= 0 ? "N" : "S";
  const ew = lon >= 0 ? "E" : "W";
  return `${Math.abs(lat).toFixed(4)}° ${ns}  ${Math.abs(lon).toFixed(4)}° ${ew}`;
}

async function geocode(q: string): Promise<Hit[]> {
  try {
    const res = await fetch("/api/vpc/geocode", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ q }),
    });
    if (!res.ok) throw new Error("bad status");
    const j = (await res.json()) as { hits?: Hit[] };
    return Array.isArray(j.hits) ? j.hits : [];
  } catch {
    return [];
  }
}

// ============================================================
// main component
// ============================================================

export default function MapsApp({ win }: { win: WindowState }) {
  const liveWin = useGlassDesk((s) => s.state?.windows.find((w) => w.id === win.id));
  const dispatch = useGlassDesk((s) => s.dispatch);
  const w = liveWin ?? win;
  const payload = (w.payload ?? {}) as Partial<P>;

  const q = typeof payload.q === "string" ? payload.q : "";
  const pin = parsePin(payload.pin);
  const z = clampZ(payload.z);

  const patch = useCallback(
    (p: Record<string, unknown>) => dispatch({ t: "app:patch", id: win.id, patch: p }),
    [dispatch, win.id],
  );

  // ---- local ui state (search box + suggestion dropdown) ----
  const [input, setInput] = useState(q);
  const [sugg, setSugg] = useState<Hit[]>([]);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [cursor, setCursor] = useState(0);
  const reqRef = useRef(0);

  // the co-seat moved the map → mirror the committed query into the box
  useEffect(() => {
    setInput(q);
  }, [q]);

  // debounced (300ms) suggestion fetch — only while the dropdown is live
  useEffect(() => {
    if (!open) return;
    const clean = input.trim();
    if (clean.length < 2) return;
    const id = ++reqRef.current;
    const t = window.setTimeout(async () => {
      setBusy(true);
      const hits = await geocode(clean);
      if (reqRef.current !== id) return; // a newer keystroke won
      setBusy(false);
      setSugg(hits.slice(0, SUGG_CAP));
      setCursor(0);
    }, 300);
    return () => window.clearTimeout(t);
  }, [input, open]);

  /** Freshest zoom straight from the store (peer-safe increments). */
  const liveZ = (): number => clampZ(useGlassDesk.getState().state?.windows.find((x) => x.id === win.id)?.payload.z);

  const view = pin ?? HOME;

  // ---- place selection (the co-panning moment) ----
  const selectHit = (hit: Hit) => {
    const short = shortName(hit.name);
    patch({ q: short, pin: { lat: hit.lat, lon: hit.lon, label: hit.name }, z: 12 });
    setInput(short);
    setOpen(false);
    setSugg([]);
    pushToast({ title: `Map moved to ${short} — both seats follow`, body: hit.name, kind: "success" });
  };

  const goQuick = (chip: { label: string; full: string; lat: number; lon: number }) => {
    patch({ q: chip.label, pin: { lat: chip.lat, lon: chip.lon, label: chip.full }, z: 12 });
    setInput(chip.label);
    setOpen(false);
    setSugg([]);
    pushToast({ title: `Map moved to ${chip.label} — both seats follow`, body: chip.full, kind: "success" });
  };

  const goNode = () => {
    patch({ q: "The node", pin: { ...NODE }, z: 12 });
    setInput("The node");
    setOpen(false);
    setSugg([]);
    pushToast({ title: "Back at the node — both seats follow", body: NODE.label, kind: "info" });
  };

  const zoomBy = (dz: number) => patch({ z: clampZ(liveZ() + dz) });

  const copyCoords = async () => {
    const text = `${view.lat.toFixed(4)}, ${view.lon.toFixed(4)}`;
    try {
      await navigator.clipboard.writeText(text);
      pushToast({ title: "Coordinates copied", body: text, kind: "success" });
    } catch {
      pushToast({ title: "Clipboard blocked", body: "The browser refused clipboard access", kind: "warn" });
    }
  };

  const commit = async () => {
    const clean = input.trim();
    if (!clean) return;
    const pick = open && sugg.length > 0 ? sugg[Math.min(cursor, sugg.length - 1)] : undefined;
    const hit = pick ?? (await geocode(clean))[0];
    if (hit) {
      selectHit(hit);
      return;
    }
    setOpen(false);
    pushToast({ title: "No results", body: `Nothing on the map for “${clean.slice(0, 48)}”`, kind: "warn" });
  };

  // ---- OSM embed geometry (bbox delta scales with zoom) ----
  const d = (360 / 2 ** z) * 0.5;
  const latLo = Math.max(-90, view.lat - d);
  const latHi = Math.min(90, view.lat + d);
  const lonLo = Math.max(-180, view.lon - d);
  const lonHi = Math.min(180, view.lon + d);
  const bbox = `${lonLo.toFixed(6)},${latLo.toFixed(6)},${lonHi.toFixed(6)},${latHi.toFixed(6)}`;
  const marker = pin ? `${pin.lat.toFixed(6)},${pin.lon.toFixed(6)}` : null;
  const mapSrc =
    `https://www.openstreetmap.org/export/embed.html?bbox=${encodeURIComponent(bbox)}&layer=mapnik` +
    (marker ? `&marker=${encodeURIComponent(marker)}` : "");
  // key = JSON of bbox+marker → a changed view remounts (reloads) the iframe
  const mapKey = JSON.stringify({ bbox, marker });

  // tiles overlay: derived from WHICH key last fired onLoad
  const [loadedKey, setLoadedKey] = useState<string | null>(null);
  const tilesLoading = loadedKey !== mapKey;

  // safety: never trap the overlay if tiles stall (blocked network etc.)
  useEffect(() => {
    if (!tilesLoading) return;
    const t = window.setTimeout(() => setLoadedKey(mapKey), 6000);
    return () => window.clearTimeout(t);
  }, [tilesLoading, mapKey]);

  const showList = open && input.trim().length >= 2;
  const activeChip = q === "The node" ? "The node" : q;

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      {/* ---------------- search header ---------------- */}
      <header className="shrink-0 px-3 pt-2.5">
        <div className="relative">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-stone-400" aria-hidden />
          <input
            value={input}
            onChange={(e) => {
              setInput(e.target.value);
              setOpen(true);
            }}
            onFocus={() => {
              if (input.trim().length >= 2) setOpen(true);
            }}
            onBlur={() => setOpen(false)}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown" && showList && sugg.length > 0) {
                e.preventDefault();
                setCursor((c) => Math.min(c + 1, sugg.length - 1));
              } else if (e.key === "ArrowUp" && showList && sugg.length > 0) {
                e.preventDefault();
                setCursor((c) => Math.max(c - 1, 0));
              } else if (e.key === "Enter") {
                e.preventDefault();
                void commit();
              } else if (e.key === "Escape") {
                setOpen(false);
              }
            }}
            placeholder="Search the planet — try “Kyoto”"
            aria-label="Search places"
            spellCheck={false}
            className="h-8 w-full rounded-full border border-white/70 bg-white/70 pl-9 pr-8 text-xs text-stone-700 shadow-sm outline-none backdrop-blur placeholder:text-stone-400 focus:border-teal-300 focus:ring-2 focus:ring-teal-400/40"
          />
          {input && (
            <button
              type="button"
              onClick={() => {
                setInput("");
                setSugg([]);
                setOpen(false);
              }}
              aria-label="Clear search"
              className="absolute right-2.5 top-1/2 grid h-5 w-5 -translate-y-1/2 place-items-center rounded-full text-stone-400 hover:bg-white/80 hover:text-stone-600"
            >
              <X className="h-3 w-3" />
            </button>
          )}

          {/* suggestion dropdown (rises + staggers in) */}
          <AnimatePresence>
            {showList && (
              <motion.div
                key="sugg"
                initial={{ opacity: 0, y: -6, scale: 0.99 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, y: -6, scale: 0.99 }}
                transition={SPRING.snappy}
                className="glass-strong absolute left-0 right-0 top-10 z-40 overflow-hidden rounded-xl p-1.5 shadow-xl"
              >
                <motion.div variants={stagger(0.035, 0.02)} initial="hidden" animate="show">
                  {busy && sugg.length === 0 ? (
                    <div className="flex items-center gap-2 px-2.5 py-2.5 text-xs text-stone-500">
                      <Loader2 className="h-3.5 w-3.5 animate-spin text-teal-500" />
                      Searching the planet…
                    </div>
                  ) : sugg.length === 0 ? (
                    <div className="px-2.5 py-2.5 text-xs text-stone-400">No places found.</div>
                  ) : (
                    sugg.map((hit, i) => (
                      <motion.button
                        key={`${hit.name}-${i}-${hit.lat}`}
                        variants={riseIn}
                        type="button"
                        // mousedown + preventDefault → the input never blurs, no race
                        onMouseDown={(e) => {
                          e.preventDefault();
                          selectHit(hit);
                        }}
                        onMouseEnter={() => setCursor(i)}
                        className={`flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left ${
                          i === cursor ? "bg-teal-50 ring-1 ring-teal-200/80" : "hover:bg-white/80"
                        }`}
                      >
                        <MapPin className="h-3.5 w-3.5 shrink-0 text-teal-500" />
                        <span className="min-w-0 flex-1 truncate text-xs font-medium text-stone-700">{hit.name}</span>
                        <span className="shrink-0 rounded-full bg-stone-100 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-stone-500">
                          {hit.kind}
                        </span>
                      </motion.button>
                    ))
                  )}
                </motion.div>
              </motion.div>
            )}
          </AnimatePresence>
        </div>

        {/* quick picks + the node */}
        <div className="mt-2 flex flex-wrap items-center gap-1.5 pb-2">
          {QUICK.map((chip) => {
            const active = activeChip === chip.label;
            return (
              <button
                key={chip.label}
                type="button"
                onClick={() => goQuick(chip)}
                aria-pressed={active}
                className={`rounded-full px-2.5 py-1 text-[11px] transition-colors focus-visible:ring-2 focus-visible:ring-teal-400/60 ${
                  active
                    ? "gd-accent-gradient font-semibold text-white shadow-sm"
                    : "bg-white/60 text-stone-600 hover:bg-white/90"
                }`}
              >
                {chip.label}
              </button>
            );
          })}
          <button
            type="button"
            onClick={goNode}
            aria-pressed={activeChip === "The node"}
            title={NODE.label}
            className={`flex items-center gap-1 rounded-full px-2.5 py-1 text-[11px] transition-colors focus-visible:ring-2 focus-visible:ring-teal-400/60 ${
              activeChip === "The node"
                ? "gd-accent-gradient font-semibold text-white shadow-sm"
                : "bg-white/60 text-stone-600 hover:bg-white/90"
            }`}
          >
            <Server className="h-3 w-3" />
            The node
          </button>
        </div>
      </header>

      {/* ---------------- map in a glass frame ---------------- */}
      <div className="min-h-0 flex-1 px-3">
        <div className="relative h-full overflow-hidden rounded-2xl border border-white/70 bg-white/60 shadow-[0_10px_30px_rgba(31,41,55,0.12),inset_0_2px_10px_rgba(31,41,55,0.14)] backdrop-blur-sm">
          <iframe
            key={mapKey}
            src={mapSrc}
            title={`Map: ${pin ? pin.label || q || "pinned place" : "Bengaluru (default view)"}`}
            className="absolute inset-0 h-full w-full border-0 bg-white"
            referrerPolicy="no-referrer"
            onLoad={() => setLoadedKey(mapKey)}
          />

          {/* pinned place chip */}
          <AnimatePresence>
            {pin && (
              <motion.div
                key="pin-label"
                initial={{ opacity: 0, y: -8 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -8 }}
                transition={SPRING.snappy}
                className="pointer-events-none absolute left-3 top-3 z-20 flex max-w-[75%] items-center gap-1.5 rounded-full border border-white/70 bg-white/80 px-3 py-1.5 shadow-sm backdrop-blur"
              >
                <MapPin className="h-3.5 w-3.5 shrink-0 text-teal-500" />
                <span className="truncate text-xs font-medium text-stone-700">{pin.label || q}</span>
              </motion.div>
            )}
          </AnimatePresence>

          {/* tile loading overlay */}
          <AnimatePresence>
            {tilesLoading && (
              <motion.div
                key="tiles"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.18 }}
                className="pointer-events-none absolute inset-0 z-30 grid place-items-center bg-white/55 backdrop-blur-[2px]"
              >
                <div className="flex flex-col items-center gap-2">
                  <Loader2 className="h-6 w-6 animate-spin text-teal-500" />
                  <p className="text-xs font-medium text-stone-500">Rendering tiles…</p>
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </div>

      {/* ---------------- control strip ---------------- */}
      <footer className="flex shrink-0 items-center gap-1.5 px-3 py-2">
        <div className="flex items-center gap-1">
          <motion.button
            variants={pop}
            initial="rest"
            whileHover="hover"
            whileTap="tap"
            type="button"
            onClick={() => zoomBy(-1)}
            disabled={z <= Z_MIN}
            aria-label="Zoom out"
            title="Zoom out"
            className="grid h-7 w-7 place-items-center rounded-full border border-white/70 bg-white/80 text-stone-600 shadow-sm disabled:opacity-40"
          >
            <Minus className="h-3.5 w-3.5" />
          </motion.button>
          <motion.button
            variants={pop}
            initial="rest"
            whileHover="hover"
            whileTap="tap"
            type="button"
            onClick={() => zoomBy(1)}
            disabled={z >= Z_MAX}
            aria-label="Zoom in"
            title="Zoom in"
            className="grid h-7 w-7 place-items-center rounded-full border border-white/70 bg-white/80 text-stone-600 shadow-sm disabled:opacity-40"
          >
            <Plus className="h-3.5 w-3.5" />
          </motion.button>
        </div>

        <span className="gd-mono min-w-0 flex-1 truncate text-center text-[11px] font-medium text-stone-500">
          {coordText(view.lat, view.lon)}
        </span>

        <motion.button
          variants={pop}
          initial="rest"
          whileHover="hover"
          whileTap="tap"
          type="button"
          onClick={() => void copyCoords()}
          aria-label="Copy coordinates"
          title="Copy coordinates"
          className="grid h-7 w-7 place-items-center rounded-full border border-white/70 bg-white/80 text-stone-600 shadow-sm"
        >
          <Copy className="h-3.5 w-3.5" />
        </motion.button>

        <span className="gd-mono rounded-full border border-stone-200 bg-white/70 px-2 py-0.5 text-[10px] font-semibold text-stone-500">
          z{z}
        </span>

        <motion.button
          variants={pop}
          initial="rest"
          whileHover="hover"
          whileTap="tap"
          type="button"
          onClick={goNode}
          title={NODE.label}
          className="flex h-7 items-center gap-1.5 rounded-full border border-teal-200 bg-teal-50/80 px-2.5 text-[11px] font-medium text-teal-700 shadow-sm"
        >
          <LocateFixed className="h-3.5 w-3.5" />
          Locate node
        </motion.button>

        <span className="ml-auto flex items-center gap-1 rounded-full border border-emerald-200 bg-emerald-50/80 px-2 py-1 text-[10px] font-semibold text-emerald-700">
          <span className="flex items-center">
            <Users className="h-3 w-3" />
            <Users className="-ml-1 h-3 w-3" />
          </span>
          co-panning on
        </span>
      </footer>
    </div>
  );
}
