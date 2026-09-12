"use client";

// ============================================================
// GlassDesk — Task Manager 2.0 (Windows 11 grade). Fully derived
// from DesktopState + a 1 Hz local telemetry ticker:
//
//   • 3 stat cards — CPU (simulated: window count + RAM load +
//     sine wobble), Memory (real ramUsage), Disk (fsBytes of 16 GB
//     with a snapd flush heartbeat on the activity sparkline)
//   • each card has a LIVE SPARKLINE — last 60 samples, smooth
//     Catmull-Rom bezier path + area fill, inline SVG
//   • process table: processList rows, sortable by memory, thin
//     per-row mem bars, "system" badges, inline confirm popover
//     before win:close (synced — ends the task on both seats)
//   • footer: uptime, hostname, pulsing "gd-kernel healthy",
//     snapshot theater (window + fs node counts)
// ============================================================

import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { motion } from "framer-motion";
import { ArrowDown, ArrowUp, Cpu, HardDrive, MemoryStick, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useGlassDesk } from "@/lib/vpc/store";
import { pushToast } from "@/lib/vpc/toast";
import {
  DISK_GB,
  accentOf,
  fmtBytes,
  fmtUptime,
  fsBytes,
  processList,
  ramUsage,
  type AppKind,
  type FSMap,
  type ProcRow,
  type WindowState,
} from "@/lib/vpc/types";

const APP_LABEL: Record<AppKind, string> = {
  files: "Files",
  textedit: "TextEdit",
  terminal: "Terminal",
  whiteboard: "Whiteboard",
  browser: "Nova",
  media: "Media",
  calculator: "Calculator",
  settings: "Settings",
  taskmgr: "Task Manager",
  photos: "Photos",
  notes: "Notes",
  calendar: "Calendar",
  clock: "Clock",
  weather: "Weather",
  paint: "Paint",
  mines: "Minesweeper",
  snake: "Snake",
  g2048: "2048",
  youtube: "Tube",
  ai: "Glass AI",
  code: "Code",
  mail: "Mail",
  camera: "Camera",
  voice: "Voice Memos",
  maps: "Maps",
  contacts: "People",
  security: "Security Center",
  store: "Glass Store",
};

const SPARK_N = 60; // 60 s of history at 1 Hz
const TICK_MS = 1000;
const GRID = "grid-cols-[56px_minmax(0,1fr)_104px_40px]";

const MEM_COLOR = "#10b981"; // emerald
const MEM_COLOR2 = "#34d399";
const DISK_COLOR = "#f59e0b"; // amber
const DISK_COLOR2 = "#fbbf24";

// ---------------- telemetry simulation ----------------

function simCpu(nowMs: number, winCount: number, ramPct: number): number {
  const base = 5 + winCount * 3.5 + ramPct * 0.22;
  const wobble = Math.sin(nowMs / 5300) * 6 + Math.sin(nowMs / 1900) * 3 + Math.sin(nowMs / 640) * 1.5;
  return Math.min(99, Math.max(1, base + wobble));
}

/** Disk I/O theater: a calm baseline + a heartbeat spike while a
 *  snapd flush is landing (any fs node written in the last 1.6 s). */
function simIo(nowMs: number, fs: FSMap): number {
  let lastUpdate = 0;
  for (const n of Object.values(fs)) if (n.updatedAt > lastUpdate) lastUpdate = n.updatedAt;
  const since = nowMs - lastUpdate;
  const base = 2.5 + Math.sin(nowMs / 7300) * 1.5 + Math.sin(nowMs / 1100) * 0.8;
  const flush = since < 1600 ? 24 + (Math.sin(nowMs / 260) + 1) * 10 : 0;
  return Math.min(95, Math.max(1, base + flush));
}

interface Series {
  cpu: number[];
  mem: number[];
  io: number[];
}

/** Seed the sparklines with one minute of plausible history so the
 *  charts are alive from the very first paint. */
function seedSeries(): Series {
  const st = useGlassDesk.getState().state;
  const ram = st ? ramUsage(st) : { used: 0, total: 0, pct: 0 };
  const nowMs = Date.now();
  const back = (i: number) => nowMs - (SPARK_N - 1 - i) * TICK_MS;
  return {
    cpu: Array.from({ length: SPARK_N }, (_, i) => simCpu(back(i), st?.windows.length ?? 0, ram.pct)),
    mem: Array.from({ length: SPARK_N }, () => ram.pct),
    io: Array.from({ length: SPARK_N }, (_, i) => simIo(back(i), st?.fs ?? {})),
  };
}

// ---------------- sparkline (smooth Catmull-Rom → bezier) ----------------

const SPARK_W = 240;
const SPARK_H = 40;

function sparkPath(data: number[]): { line: string; area: string } {
  const n = data.length;
  if (n < 2) return { line: "", area: "" };
  const pad = 3;
  const pts = data.map((v, i) => ({
    x: (i / (n - 1)) * SPARK_W,
    y: SPARK_H - pad - (Math.min(100, Math.max(0, v)) / 100) * (SPARK_H - pad * 2),
  }));
  let line = `M ${pts[0].x.toFixed(2)} ${pts[0].y.toFixed(2)}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] ?? pts[i];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p3 = pts[i + 2] ?? p2;
    line += ` C ${(p1.x + (p2.x - p0.x) / 6).toFixed(2)} ${(p1.y + (p2.y - p0.y) / 6).toFixed(2)} ${(p2.x - (p3.x - p1.x) / 6).toFixed(2)} ${(p2.y - (p3.y - p1.y) / 6).toFixed(2)} ${p2.x.toFixed(2)} ${p2.y.toFixed(2)}`;
  }
  const area = `${line} L ${SPARK_W} ${SPARK_H} L 0 ${SPARK_H} Z`;
  return { line, area };
}

function Sparkline({ data, stroke, fill }: { data: number[]; stroke: string; fill: string }) {
  const gid = `spark-${useId().replace(/[^a-zA-Z0-9]/g, "")}`;
  const { line, area } = useMemo(() => sparkPath(data), [data]);
  if (!line) return null;
  return (
    <svg viewBox={`0 0 ${SPARK_W} ${SPARK_H}`} preserveAspectRatio="none" className="block h-10 w-full" aria-hidden>
      <defs>
        <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={fill} stopOpacity="0.32" />
          <stop offset="100%" stopColor={fill} stopOpacity="0.02" />
        </linearGradient>
      </defs>
      <line x1="0" y1={SPARK_H - 0.5} x2={SPARK_W} y2={SPARK_H - 0.5} stroke="rgba(87,83,78,0.14)" strokeWidth="1" />
      <path d={area} fill={`url(#${gid})`} />
      <path
        d={line}
        fill="none"
        stroke={stroke}
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}

function StatCard({
  icon,
  label,
  value,
  sub,
  data,
  color,
  color2,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  sub: string;
  data: number[];
  color: string;
  color2: string;
}) {
  return (
    <div className="glass min-w-0 rounded-2xl p-2.5">
      <div className="flex items-center gap-1.5">
        <span
          className="grid h-6 w-6 shrink-0 place-items-center rounded-lg"
          style={{ background: `${color}1f`, color }}
        >
          {icon}
        </span>
        <span className="truncate text-[10px] font-semibold uppercase tracking-wider text-stone-400">{label}</span>
        <span className="ml-auto flex shrink-0 items-center gap-1.5">
          <motion.span
            className="h-1.5 w-1.5 rounded-full"
            style={{ background: color }}
            animate={{ opacity: [1, 0.25, 1] }}
            transition={{ duration: 1.8, repeat: Infinity, ease: "easeInOut" }}
          />
          <span className="gd-mono text-sm font-semibold tabular-nums text-stone-700">{value}</span>
        </span>
      </div>
      <div className="pt-1.5">
        <Sparkline data={data} stroke={color} fill={color2} />
      </div>
      <p className="gd-mono truncate pt-1 text-[9px] text-stone-400">{sub}</p>
    </div>
  );
}

// ---------------- the app ----------------

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

export default function TaskMgrApp({ win }: { win: WindowState }) {
  const dispatch = useGlassDesk((s) => s.dispatch);
  const state = useGlassDesk((s) => s.state);
  const accentId = useGlassDesk((s) => s.state?.accent) ?? "teal";

  const [series, setSeries] = useState<Series>(seedSeries);
  const [now, setNow] = useState(() => Date.now());
  const [sortDesc, setSortDesc] = useState(true);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [rootRef, w] = useMeasure<HTMLDivElement>();
  const narrow = w > 0 && w < 520;

  // 1 Hz telemetry: append one sample per metric, cap at 60
  useEffect(() => {
    const iv = window.setInterval(() => {
      const st = useGlassDesk.getState().state;
      if (!st) return;
      const ram = ramUsage(st);
      const nowMs = Date.now();
      const cpu = simCpu(nowMs, st.windows.length, ram.pct);
      const io = simIo(nowMs, st.fs);
      setSeries((prev) => ({
        cpu: [...prev.cpu.slice(1), cpu],
        mem: [...prev.mem.slice(1), ram.pct],
        io: [...prev.io.slice(1), io],
      }));
      setNow(nowMs);
    }, TICK_MS);
    return () => window.clearInterval(iv);
  }, []);

  const procs = useMemo(() => (state ? processList(state) : []), [state]);
  const sorted = useMemo(() => {
    const arr = [...procs];
    arr.sort((a, b) => (sortDesc ? b.mem - a.mem : a.mem - b.mem));
    return arr;
  }, [procs, sortDesc]);
  const maxMem = useMemo(() => Math.max(1, ...procs.map((p) => p.mem)), [procs]);

  if (!state) return null;

  const acc = accentOf(accentId);
  const ram = ramUsage(state);
  const diskUsed = fsBytes(state.fs);
  const cpuNow = series.cpu[series.cpu.length - 1] ?? 0;
  const ioNow = series.io[series.io.length - 1] ?? 0;

  const endTask = (row: ProcRow) => {
    if (!row.winId) return;
    dispatch({ t: "win:close", id: row.winId });
    pushToast({ title: "Task ended", body: `${row.name} · ${row.mem} MB freed`, kind: "info" });
    setConfirmId(null);
  };

  return (
    <div ref={rootRef} className="flex h-full min-h-0 flex-col gap-2.5 overflow-hidden p-3">
      {/* ---------------- stat cards ---------------- */}
      <div className="grid shrink-0 grid-cols-3 gap-2">
        <StatCard
          icon={<Cpu className="h-3.5 w-3.5" />}
          label="CPU"
          value={`${Math.round(cpuNow)}%`}
          sub={`${state.machine.cores} vCores · ${procs.length} threads`}
          data={series.cpu}
          color={acc.hex}
          color2={acc.hex2}
        />
        <StatCard
          icon={<MemoryStick className="h-3.5 w-3.5" />}
          label="Memory"
          value={`${ram.pct}%`}
          sub={`${ram.used} MB of ${ram.total} MB`}
          data={series.mem}
          color={MEM_COLOR}
          color2={MEM_COLOR2}
        />
        <StatCard
          icon={<HardDrive className="h-3.5 w-3.5" />}
          label="Disk"
          value={`${Math.round(ioNow)}%`}
          sub={`I/O · ${fmtBytes(diskUsed)} of ${DISK_GB} GB`}
          data={series.io}
          color={DISK_COLOR}
          color2={DISK_COLOR2}
        />
      </div>

      {/* ---------------- process table ---------------- */}
      <div className="glass flex min-h-0 flex-1 flex-col rounded-2xl p-3">
        <div className="flex items-center gap-2 px-1 pb-2">
          <h2 className="text-[10px] font-semibold uppercase tracking-wider text-stone-400">Processes</h2>
          <span className="gd-mono text-[10px] text-stone-400">{procs.length} running</span>
          <span className="flex-1" />
          {!narrow && (
            <span className="gd-mono text-[10px] text-stone-400">
              end task closes the window on both seats
            </span>
          )}
        </div>

        <div className={`grid ${GRID} items-center gap-2 border-b border-white/60 px-2 pb-1.5`}>
          <span className="gd-mono text-[9px] uppercase tracking-wider text-stone-400">pid</span>
          <span className="gd-mono text-[9px] uppercase tracking-wider text-stone-400">name</span>
          <button
            type="button"
            onClick={() => setSortDesc((d) => !d)}
            aria-label={`Sort by memory, currently ${sortDesc ? "highest first" : "lowest first"}`}
            className="gd-mono flex items-center justify-end gap-1 text-[9px] uppercase tracking-wider text-stone-400 transition-colors hover:text-stone-600"
          >
            memory
            {sortDesc ? <ArrowDown className="h-3 w-3" /> : <ArrowUp className="h-3 w-3" />}
          </button>
          <span />
        </div>

        <div className="gd-scroll min-h-0 flex-1 overflow-y-auto" role="list" aria-label="Process list">
          {sorted.map((row) => {
            const appKind = row.sys ? null : (row.name.slice(3) as AppKind);
            const appLabel = appKind && appKind in APP_LABEL ? APP_LABEL[appKind] : null;
            const confirming = confirmId !== null && confirmId === row.winId;
            const isSelf = row.winId === win.id;
            return (
              <div
                key={row.winId ?? `sys-${row.pid}`}
                role="listitem"
                className={`relative grid ${GRID} items-center gap-2 rounded-lg px-2 py-1.5 transition-colors hover:bg-white/50`}
              >
                <span className="gd-mono text-xs tabular-nums text-stone-500">{row.pid}</span>
                <span className="flex min-w-0 items-center gap-1.5">
                  <span
                    className="gd-mono truncate text-xs text-stone-700"
                    style={confirming ? { color: "#f43f5e" } : undefined}
                  >
                    {row.name}
                  </span>
                  {row.sys ? (
                    <Badge variant="secondary" className="shrink-0 px-1.5 text-[9px] text-stone-500">
                      system
                    </Badge>
                  ) : (
                    appLabel && (
                      <span className="shrink-0 text-[10px] text-stone-400" title={appLabel}>
                        {appLabel}
                      </span>
                    )
                  )}
                  {isSelf && <span className="shrink-0 text-[10px] text-stone-400">· this window</span>}
                </span>
                <span className="flex min-w-0 flex-col items-end gap-1">
                  <span className="gd-mono text-[11px] tabular-nums text-stone-600">{row.mem} MB</span>
                  <span className="h-1 w-full max-w-[84px] overflow-hidden rounded-full bg-stone-200/70">
                    <motion.span
                      className="block h-full rounded-full"
                      style={{
                        width: `${Math.max(3, (row.mem / maxMem) * 100)}%`,
                        background: row.sys
                          ? "linear-gradient(90deg,#a8a29e,#78716c)"
                          : `linear-gradient(90deg,${acc.hex},${acc.hex2})`,
                      }}
                      initial={false}
                      transition={{ type: "spring", stiffness: 160, damping: 26 }}
                    />
                  </span>
                </span>
                {row.sys ? (
                  <span />
                ) : (
                  <button
                    type="button"
                    onClick={() => setConfirmId(confirming ? null : (row.winId ?? null))}
                    aria-label={`End task ${row.name}`}
                    title="End task"
                    className="grid h-8 w-8 place-items-center rounded-md text-stone-400 transition-colors hover:bg-rose-50 hover:text-rose-500"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                )}

                {/* inline confirm popover — never window.confirm */}
                {confirming && (
                  <motion.div
                    initial={{ opacity: 0, scale: 0.97 }}
                    animate={{ opacity: 1, scale: 1 }}
                    transition={{ type: "spring", stiffness: 480, damping: 28 }}
                    className="glass-strong absolute inset-0 z-10 flex items-center justify-between gap-2 rounded-lg px-2.5"
                    role="alertdialog"
                    aria-label={`End ${row.name}`}
                  >
                    <p className="min-w-0 truncate text-xs">
                      <span className="font-semibold text-stone-700">End {row.name}?</span>{" "}
                      <span className="text-[10px] text-stone-400">closes on both seats</span>
                    </p>
                    <span className="flex shrink-0 gap-1.5">
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-7 px-2.5 text-[11px]"
                        onClick={() => setConfirmId(null)}
                      >
                        Cancel
                      </Button>
                      <Button
                        size="sm"
                        className="h-7 bg-rose-500 px-2.5 text-[11px] text-white shadow-sm hover:bg-rose-600"
                        onClick={() => endTask(row)}
                      >
                        End task
                      </Button>
                    </span>
                  </motion.div>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* ---------------- footer ---------------- */}
      <div className="glass flex shrink-0 flex-wrap items-center gap-2.5 rounded-2xl px-3.5 py-2.5">
        <span className="relative flex h-2.5 w-2.5 shrink-0" aria-hidden>
          <motion.span
            className="absolute inset-0 rounded-full bg-emerald-500"
            animate={{ scale: [1, 1.7, 1], opacity: [0.6, 0, 0.6] }}
            transition={{ duration: 2, repeat: Infinity, ease: "easeInOut" }}
          />
          <span className="relative h-2.5 w-2.5 rounded-full bg-emerald-500" />
        </span>
        <span className="text-xs font-medium text-stone-600">gd-kernel healthy</span>
        <span className="gd-mono truncate text-[10px] text-stone-400">{state.machine.hostname}</span>
        <span className="flex-1" />
        <span className="gd-mono text-[10px] tabular-nums text-stone-500">up {fmtUptime(now - state.machine.createdAt)}</span>
        {!narrow && (
          <span className="gd-mono text-[10px] text-stone-400">
            · {state.windows.length} windows · {Object.keys(state.fs).length} fs nodes
          </span>
        )}
      </div>
    </div>
  );
}