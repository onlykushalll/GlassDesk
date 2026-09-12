"use client";

// ============================================================
// GlassDesk — Security Center (Tails-inspired hardening dash).
//
// One dial, three levels: Careful / Safer / Safest. Picking a
// level auto-sets the four feature toggles; manual toggles are
// allowed too. Everything lands in the SYNCED window payload
// (app:patch) — both seats harden the same machine together.
//
// Motion set-pieces (springs only, transform/opacity only):
//   • 270° shield gauge — arc fill + needle rotate + count-up
//     number (motion value → useTransform, zero layout)
//   • gliding level pill (layoutId + SPRING.glide)
//   • iOS-style switches (knob x-spring, bg opacity crossfade)
//   • LIVE network graph — tor circuit (3 relays) vs direct,
//     infinite staggered packet dots on <g> x/y keyframes
//   • streaming event log (2.5s interval, capped 80, auto-scroll)
//   • intrusion test — 8 rose probes fly in, wall flash, spring
//     deflection, check-burst result card (1.8s total)
// ============================================================

import { useEffect, useId, useRef, useState } from "react";
import { AnimatePresence, animate, motion, useMotionValue, useTransform } from "framer-motion";
import { Activity, BrickWall, Check, Fingerprint, Lock, Play, ShieldCheck, Waypoints, type LucideIcon } from "lucide-react";
import { useGlassDesk } from "@/lib/vpc/store";
import { pushToast } from "@/lib/vpc/toast";
import { SPRING, riseIn, stagger } from "@/lib/vpc/motion";
import type { WindowState } from "@/lib/vpc/types";

// ---------------- constants ----------------

type FeatureKey = "macSpoof" | "tor" | "firewall" | "httpsOnly";

interface FeatureMeta {
  key: FeatureKey;
  label: string;
  desc: string;
  icon: LucideIcon;
  gradient: string;
}

const FEATURES: FeatureMeta[] = [
  {
    key: "macSpoof",
    label: "MAC spoofing",
    desc: "Rotates the hardware address on every session",
    icon: Fingerprint,
    gradient: "from-teal-400 to-emerald-500",
  },
  {
    key: "tor",
    label: "Tor routing",
    desc: "Bounces traffic through three volunteer relays",
    icon: Waypoints,
    gradient: "from-emerald-400 to-teal-600",
  },
  {
    key: "firewall",
    label: "Firewall",
    desc: "Drops unsolicited packets at the edge",
    icon: BrickWall,
    gradient: "from-amber-400 to-rose-400",
  },
  {
    key: "httpsOnly",
    label: "HTTPS-only",
    desc: "Forces TLS on every outbound request",
    icon: Lock,
    gradient: "from-emerald-300 to-teal-500",
  },
];

const LEVELS: { id: number; label: string; hint: string }[] = [
  { id: 0, label: "Careful", hint: "Everyday mode — fast and direct. Best on trusted networks." },
  { id: 1, label: "Safer", hint: "Tor routing, HTTPS-only and a live firewall. Speed meets privacy." },
  { id: 2, label: "Safest", hint: "Full lockdown — every shield on, nothing kept between sessions." },
];

const LEVEL_PRESETS: { level: number; macSpoof: boolean; tor: boolean; firewall: boolean; httpsOnly: boolean }[] = [
  { level: 0, macSpoof: true, tor: false, firewall: true, httpsOnly: false },
  { level: 1, macSpoof: true, tor: true, firewall: true, httpsOnly: true },
  { level: 2, macSpoof: true, tor: true, firewall: true, httpsOnly: true },
];

// Gauge geometry — 270° arc around center (100, 82), r = 64.
const ARC_D =
  "M 54.75 127.25 A 64 64 0 0 1 54.75 36.75 A 64 64 0 0 1 145.25 36.75 A 64 64 0 0 1 145.25 127.25";

interface LogRow {
  id: number;
  time: string;
  text: string;
}

const LOG_CAP = 80;

function pad2(n: number): string {
  return n.toString().padStart(2, "0");
}

function clock(): string {
  const d = new Date();
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

function hex(): string {
  return Math.floor(Math.random() * 256).toString(16).padStart(2, "0");
}

function randMac(): string {
  return `${hex()}:${hex()}:${hex()}:…`;
}

interface SecState {
  tor: boolean;
  firewall: boolean;
  macSpoof: boolean;
  httpsOnly: boolean;
}

/** Plausible ambient line — weighted by the LIVE hardening state. */
function nextLogLine(sec: SecState): string {
  const pool: string[] = [];
  if (sec.macSpoof) {
    pool.push(`macspoof: eth0 → ${randMac()}`, "macspoof: identity rotation scheduled");
  } else {
    pool.push("macspoof: passthrough (real NIC id)");
  }
  if (sec.tor) {
    pool.push(
      `tor: circuit #${4000 + Math.floor(Math.random() * 999)} extended (middle relay)`,
      "tor: guard consensus ok (3/3 relays up)",
      "tor: stream attached to circuit",
    );
  } else {
    pool.push("net: direct route via 10.42.0.1 (no relay)");
  }
  if (sec.firewall) {
    pool.push(`firewall: dropped ${1 + Math.floor(Math.random() * 6)} unsolicited SYNs`, "firewall: rule set reloaded (14 active)");
  } else {
    pool.push("firewall: rules idle — all ports reachable");
  }
  if (sec.httpsOnly) {
    pool.push(`https: upgraded ${3 + Math.floor(Math.random() * 14)} requests`, "https: 100% of flows negotiated TLS 1.3");
  } else {
    pool.push("net: 2 plain-http requests observed");
  }
  pool.push(
    "watchdog: kernel heartbeat ok",
    `snapd: snapshot committed (${(8 + Math.random() * 40).toFixed(1)} KB)`,
    `netd: sync ack in ${28 + Math.floor(Math.random() * 50)}ms`,
    "entropy: pool at 94%",
  );
  return pool[Math.floor(Math.random() * pool.length)];
}

function seedLog(): LogRow[] {
  const rows: LogRow[] = [];
  for (let i = 0; i < 4; i++) {
    rows.push({
      id: i,
      time: clock(),
      text: nextLogLine({ tor: true, firewall: true, macSpoof: true, httpsOnly: true }),
    });
  }
  return rows;
}

// Intrusion-test particle choreography (8 probes, deterministic).
const ATTACK_PARTICLES = [
  { top: 14, ty: 34, out: 118 },
  { top: 62, ty: -12, out: 132 },
  { top: 30, ty: 18, out: 126 },
  { top: 78, ty: -30, out: 140 },
  { top: 8, ty: 42, out: 122 },
  { top: 70, ty: -22, out: 134 },
  { top: 44, ty: 4, out: 128 },
  { top: 86, ty: -38, out: 144 },
];

const PROBE_FLY = 470; // px a probe travels from the right edge to the shield

// ---------------- Gauge ----------------

function Gauge({ pct, winId }: { pct: number; winId: string }) {
  const gid = `sg-${winId}-${useId().replace(/:/g, "")}`;
  const count = useMotionValue(0);
  useEffect(() => {
    const controls = animate(count, pct, SPRING.window);
    return () => controls.stop();
  }, [pct, count]);
  const rounded = useTransform(count, (v) => Math.round(v));

  return (
    <div className="relative w-[196px] shrink-0">
      <svg viewBox="0 0 200 140" className="block w-full" role="img" aria-label={`Shield score ${pct}%`}>
        <defs>
          <linearGradient id={`${gid}-fill`} x1="0" y1="1" x2="1" y2="0">
            <stop offset="0" style={{ stopColor: "var(--gd-accent)" }} />
            <stop offset="1" style={{ stopColor: "var(--gd-accent-2)" }} />
          </linearGradient>
        </defs>
        <path d={ARC_D} fill="none" stroke="#e7e5e4" strokeWidth={10} strokeLinecap="round" />
        <motion.path
          d={ARC_D}
          fill="none"
          stroke={`url(#${gid}-fill)`}
          strokeWidth={10}
          strokeLinecap="round"
          initial={{ pathLength: 0 }}
          animate={{ pathLength: pct / 100 }}
          transition={SPRING.window}
        />
        <motion.g
          style={{ transformBox: "view-box", transformOrigin: "100px 82px" }}
          initial={false}
          animate={{ rotate: 135 + 2.7 * pct }}
          transition={SPRING.window}
        >
          <line x1={88} y1={82} x2={136} y2={82} stroke={`url(#${gid}-fill)`} strokeWidth={3.5} strokeLinecap="round" />
        </motion.g>
        <circle cx={100} cy={82} r={6} fill="#fff" strokeWidth={3} style={{ stroke: "var(--gd-accent)" }} />
      </svg>
      <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center pt-1.5">
        <div className="flex items-baseline">
          <motion.span className="gd-mono text-4xl font-bold tabular-nums text-stone-800">{rounded}</motion.span>
          <span className="text-sm font-semibold text-stone-400">%</span>
        </div>
        <span className="mt-0.5 text-[9px] font-semibold uppercase tracking-[0.18em] text-stone-400">shield score</span>
      </div>
    </div>
  );
}

// ---------------- iOS-style switch ----------------

function Switch({ on, onToggle, label }: { on: boolean; onToggle: () => void; label: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      onClick={onToggle}
      className="relative h-6 w-11 shrink-0 cursor-pointer rounded-full outline-none focus-visible:ring-2 focus-visible:ring-emerald-400/50"
    >
      <span className="absolute inset-0 rounded-full bg-stone-300/70 shadow-inner" />
      <motion.span
        className="absolute inset-0 rounded-full gd-accent-gradient"
        initial={false}
        animate={{ opacity: on ? 1 : 0 }}
        transition={{ duration: 0.16 }}
      />
      <motion.span
        className="absolute top-0.5 left-0.5 size-5 rounded-full bg-white shadow-[0_1px_3px_rgba(0,0,0,0.25)]"
        initial={false}
        animate={{ x: on ? 20 : 0 }}
        transition={SPRING.snappy}
      />
    </button>
  );
}

// ---------------- live network graph ----------------

const TOR_DOTS = 4;
const DIRECT_DOTS = 5;

function NetworkGraph({ tor }: { tor: boolean }) {
  const gid = `ng-${useId().replace(/:/g, "")}`;
  const relays = [
    { x: 252, y: 84, label: "guard", ly: 118 },
    { x: 330, y: 52, label: "middle", ly: 28 },
    { x: 414, y: 96, label: "exit", ly: 130 },
  ];

  return (
    <div className="glass rounded-2xl p-3.5">
      <div className="flex items-center justify-between">
        <span className="text-[10px] font-semibold uppercase tracking-widest text-stone-400">Network</span>
        <AnimatePresence mode="wait" initial={false}>
          <motion.span
            key={tor ? "tor" : "direct"}
            initial={{ opacity: 0, y: 6, scale: 0.95 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -6, scale: 0.95 }}
            transition={SPRING.snappy}
            className={`flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[10px] font-semibold ${
              tor ? "bg-emerald-100/80 text-emerald-700" : "bg-amber-100/80 text-amber-700"
            }`}
          >
            <motion.span
              className="size-1.5 rounded-full"
              style={{ background: tor ? "#10b981" : "#f59e0b" }}
              animate={{ opacity: [1, 0.35, 1] }}
              transition={{ duration: 1.6, repeat: Infinity, ease: "easeInOut" }}
            />
            {tor ? "circuit established · 3 relays" : "direct connection · 0 relays"}
          </motion.span>
        </AnimatePresence>
      </div>

      <svg viewBox="0 0 660 150" className="mt-1.5 block w-full">
        <defs>
          <radialGradient id={`${gid}-relay`} cx="0.35" cy="0.3" r="1">
            <stop offset="0" stopColor="#6ee7b7" />
            <stop offset="1" stopColor="#10b981" />
          </radialGradient>
          <linearGradient id={`${gid}-you`} x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor="#ffffff" />
            <stop offset="1" stopColor="#d1fae5" />
          </linearGradient>
        </defs>

        {/* YOU tile */}
        <g>
          <rect x={6} y={48} width={94} height={56} rx={14} fill={`url(#${gid}-you)`} stroke="#a7f3d0" strokeWidth={1.5} />
          <rect x={40} y={57} width={26} height={17} rx={2.5} fill="none" stroke="#57534e" strokeWidth={1.6} />
          <line x1={45} y1={79} x2={61} y2={79} stroke="#57534e" strokeWidth={1.6} strokeLinecap="round" />
          <text x={53} y={96} textAnchor="middle" fontSize={11} fontWeight={700} fill="#334155" letterSpacing="0.08em">
            YOU
          </text>
        </g>

        {/* relay path (tor) */}
        <motion.g initial={false} animate={{ opacity: tor ? 1 : 0 }} transition={SPRING.window}>
          <path
            d="M100 76 L252 84 L330 52 L414 96 L596 88"
            fill="none"
            strokeWidth={2}
            strokeLinejoin="round"
            style={{ stroke: "var(--gd-accent)", strokeOpacity: 0.45 }}
          />
        </motion.g>

        {/* direct path */}
        <motion.g initial={false} animate={{ opacity: tor ? 0 : 1 }} transition={SPRING.window}>
          <path
            d="M100 76 L596 88"
            fill="none"
            strokeWidth={2}
            style={{ stroke: "var(--gd-accent)", strokeOpacity: 0.45 }}
          />
        </motion.g>

        {/* relays — fade to 25% when tor is off */}
        <motion.g initial={false} animate={{ opacity: tor ? 1 : 0.25 }} transition={SPRING.window}>
          {relays.map((r, i) => (
            <g key={r.label}>
              <motion.circle
                cx={r.x}
                cy={r.y}
                r={15}
                fill={`url(#${gid}-relay)`}
                stroke="#ffffff"
                strokeWidth={2.5}
                style={{ transformBox: "fill-box", transformOrigin: "center" }}
                initial={false}
                animate={tor ? { scale: [1, 1.09, 1] } : { scale: 1 }}
                transition={{ duration: 2.4, repeat: Infinity, ease: "easeInOut", delay: i * 0.55 }}
              />
              <circle cx={r.x} cy={r.y} r={4} fill="#ffffff" opacity={0.85} />
              <text x={r.x} y={r.ly} textAnchor="middle" fontSize={9.5} fontWeight={600} fill="#78716c">
                {r.label}
              </text>
            </g>
          ))}
        </motion.g>

        {/* internet */}
        <g>
          <circle cx={596} cy={88} r={19} fill="#ffffff" style={{ stroke: "var(--gd-accent)" }} strokeWidth={2} />
          <ellipse cx={596} cy={88} rx={8} ry={19} fill="none" style={{ stroke: "var(--gd-accent)" }} strokeWidth={1.4} opacity={0.55} />
          <line x1={577} y1={88} x2={615} y2={88} style={{ stroke: "var(--gd-accent)" }} strokeWidth={1.4} opacity={0.55} />
          <line x1={596} y1={69} x2={596} y2={107} style={{ stroke: "var(--gd-accent)" }} strokeWidth={1.4} opacity={0.55} />
          <text x={596} y={126} textAnchor="middle" fontSize={9} fontWeight={700} fill="#78716c" letterSpacing="0.12em">
            INTERNET
          </text>
        </g>

        {/* packet dots — tor circuit: staggered, forever */}
        {tor &&
          Array.from({ length: TOR_DOTS }, (_, i) => (
            <motion.g
              key={`t${i}`}
              initial={{ x: 100, y: 76 }}
              animate={{ x: [100, 252, 330, 414, 596], y: [76, 84, 52, 96, 88] }}
              transition={{ duration: 2.7, times: [0, 0.28, 0.52, 0.78, 1], repeat: Infinity, ease: "linear", delay: (i * 2.7) / TOR_DOTS }}
            >
              <circle r={3.2} style={{ fill: "var(--gd-accent)" }} />
            </motion.g>
          ))}

        {/* packet dots — direct: fast */}
        {!tor &&
          Array.from({ length: DIRECT_DOTS }, (_, i) => (
            <motion.g
              key={`d${i}`}
              initial={{ x: 100, y: 76 }}
              animate={{ x: [100, 596], y: [76, 88] }}
              transition={{ duration: 0.85, repeat: Infinity, ease: "linear", delay: i * 0.17 }}
            >
              <circle r={2.7} style={{ fill: "var(--gd-accent)" }} />
            </motion.g>
          ))}
      </svg>
    </div>
  );
}

// ---------------- app ----------------

export default function SecurityApp({ win }: { win: WindowState }) {
  const dispatch = useGlassDesk((s) => s.dispatch);

  // synced payload (patch-level merge) — defaults = the "Safer" preset
  const rawLevel = typeof win.payload.level === "number" ? win.payload.level : 1;
  const level = Math.max(0, Math.min(2, Math.round(rawLevel)));
  const tor = win.payload.tor === undefined ? true : win.payload.tor === true;
  const firewall = win.payload.firewall === undefined ? true : win.payload.firewall === true;
  const macSpoof = win.payload.macSpoof === undefined ? true : win.payload.macSpoof === true;
  const httpsOnly = win.payload.httpsOnly === undefined ? true : win.payload.httpsOnly === true;

  const pct = 40 + (level / 2) * 60;
  const hardened = level >= 1;
  const sec: SecState = { tor, firewall, macSpoof, httpsOnly };

  function patch(p: Record<string, unknown>): void {
    dispatch({ t: "app:patch", id: win.id, patch: p });
  }

  function setLevel(l: number): void {
    const preset = LEVEL_PRESETS[l];
    if (!preset) return;
    patch({ ...preset });
    if (l === 2) {
      pushToast({ title: "Safest level", body: "Nothing persists between sessions.", kind: "warn" });
    }
  }

  function toggleFeature(key: FeatureKey, value: boolean): void {
    patch({ [key]: !value });
  }

  // ---- event log (LOCAL flavor — ambient, never synced) ----
  const [log, setLog] = useState<LogRow[]>(() => seedLog());
  const logRef = useRef<HTMLDivElement | null>(null);
  const idRef = useRef(100);
  const secRef = useRef<SecState>(sec);
  useEffect(() => {
    secRef.current = sec;
  });

  useEffect(() => {
    const t = setInterval(() => {
      const row: LogRow = { id: idRef.current++, time: clock(), text: nextLogLine(secRef.current) };
      setLog((prev) => {
        const next = [...prev, row];
        return next.length > LOG_CAP ? next.slice(next.length - LOG_CAP) : next;
      });
    }, 2500);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [log]);

  // ---- intrusion test choreography (1.8s) ----
  const [intr, setIntr] = useState<"ready" | "run" | "done">("ready");
  const [ran, setRan] = useState(false);
  const intrTimers = useRef<number[]>([]);
  useEffect(() => {
    return () => {
      intrTimers.current.forEach((t) => clearTimeout(t));
    };
  }, []);

  function runIntrusion(): void {
    if (intr !== "ready") return;
    setIntr("run");
    setRan(true);
    intrTimers.current.push(window.setTimeout(() => setIntr("done"), 1150));
    intrTimers.current.push(window.setTimeout(() => setIntr("ready"), 1850));
  }

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {/* header */}
      <header className="flex shrink-0 items-center gap-3 px-5 pt-4 pb-3">
        <div className="grid size-11 shrink-0 place-items-center rounded-2xl bg-gradient-to-br from-emerald-400 to-teal-600 text-white shadow-lg shadow-emerald-500/20">
          <ShieldCheck size={20} strokeWidth={2.2} />
        </div>
        <div className="min-w-0">
          <h1 className="text-base font-bold tracking-tight text-stone-800">Security Center</h1>
          <p className="text-[11px] text-stone-500">Both seats harden this machine together</p>
        </div>
        <AnimatePresence mode="wait" initial={false}>
          <motion.span
            key={hardened ? "hardened" : "relaxed"}
            initial={{ opacity: 0, scale: 0.85, y: -4 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.9, y: 4 }}
            transition={SPRING.snappy}
            className={`ml-auto shrink-0 rounded-full px-3 py-1 text-[11px] font-semibold text-white shadow-md ${
              hardened ? "gd-accent-gradient shadow-emerald-500/25" : "bg-amber-400/90 shadow-amber-400/25"
            }`}
          >
            {hardened ? "Hardened" : "Relaxed"}
          </motion.span>
        </AnimatePresence>
      </header>

      {/* body */}
      <motion.div
        variants={stagger(0.055, 0.03)}
        initial="hidden"
        animate="show"
        className="gd-scroll flex-1 space-y-3.5 overflow-y-auto px-5 pb-5"
      >
        {/* HERO — gauge + level dial + intrusion test */}
        <motion.section variants={riseIn} className="glass relative overflow-hidden rounded-2xl p-4">
          <div className="flex items-center gap-5">
            <Gauge pct={pct} winId={win.id} />
            <div className="flex min-w-0 flex-1 flex-col gap-2.5">
              {/* level segmented control — gliding accent pill */}
              <div className="flex rounded-full bg-white/70 p-1 shadow-inner">
                {LEVELS.map((l) => (
                  <button
                    key={l.id}
                    type="button"
                    onClick={() => setLevel(l.id)}
                    className="relative flex-1 cursor-pointer rounded-full py-2 text-center text-xs font-semibold"
                  >
                    {level === l.id && (
                      <motion.span
                        layoutId={`sec-level-${win.id}`}
                        className="absolute inset-0 rounded-full gd-accent-gradient shadow-md"
                        initial={false}
                        transition={SPRING.glide}
                      />
                    )}
                    <span className={`relative z-10 ${level === l.id ? "text-white" : "text-stone-500"}`}>{l.label}</span>
                  </button>
                ))}
              </div>
              <p className="min-h-[30px] px-1 text-[11px] leading-snug text-stone-500">{LEVELS[level]?.hint}</p>

              <motion.button
                type="button"
                disabled={intr !== "ready"}
                onClick={runIntrusion}
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                whileHover={intr === "ready" ? { scale: 1.03 } : undefined}
                whileTap={intr === "ready" ? { scale: 0.96 } : undefined}
                transition={SPRING.snappy}
                className="gd-accent-gradient flex h-9 items-center justify-center gap-2 rounded-full px-4 text-xs font-semibold text-white shadow-md shadow-emerald-500/25 disabled:opacity-60"
              >
                <Play size={13} strokeWidth={2.5} />
                {ran ? "Run again" : "Run intrusion test"}
              </motion.button>

              <AnimatePresence>
                {ran && intr !== "run" && (
                  <motion.div
                    key="result"
                    initial={{ opacity: 0, scale: 0.9, y: 10 }}
                    animate={{ opacity: 1, scale: 1, y: 0 }}
                    exit={{ opacity: 0, scale: 0.95, y: 8 }}
                    transition={SPRING.window}
                    className="flex items-center gap-3 rounded-xl border border-emerald-200/80 bg-emerald-50/80 px-3 py-2.5"
                  >
                    <span className="relative grid size-8 shrink-0 place-items-center">
                      <motion.span
                        className="absolute inset-0 rounded-full border-2 border-emerald-400"
                        initial={{ scale: 1, opacity: 0.75 }}
                        animate={{ scale: 2.1, opacity: 0 }}
                        transition={{ duration: 0.7, ease: "easeOut" }}
                      />
                      <motion.span
                        className="absolute inset-0 rounded-full border-2 border-emerald-300"
                        initial={{ scale: 1, opacity: 0.6 }}
                        animate={{ scale: 1.9, opacity: 0 }}
                        transition={{ duration: 0.7, delay: 0.22, ease: "easeOut" }}
                      />
                      <motion.span
                        className="grid size-8 place-items-center rounded-full bg-gradient-to-br from-emerald-400 to-teal-500 text-white"
                        initial={{ scale: 0.4, rotate: -30 }}
                        animate={{ scale: 1, rotate: 0 }}
                        transition={SPRING.playful}
                      >
                        <Check size={15} strokeWidth={3} />
                      </motion.span>
                    </span>
                    <div className="min-w-0">
                      <div className="text-[13px] font-bold text-emerald-700">0 breaches</div>
                      <div className="text-[10px] font-medium text-emerald-600/80">8 probes deflected</div>
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          </div>

          {/* attack overlay — probes + wall flash */}
          {intr === "run" && (
            <div className="pointer-events-none absolute inset-0 z-10 overflow-hidden rounded-2xl">
              <motion.span
                className="absolute top-2 left-3 h-[calc(100%-1rem)] w-[196px] rounded-3xl border-2 border-emerald-400/70 bg-emerald-300/15"
                initial={{ opacity: 0 }}
                animate={{ opacity: [0, 1, 0], scale: [0.93, 1.03, 1.06] }}
                transition={{ duration: 0.62, delay: 0.42 }}
              />
              {ATTACK_PARTICLES.map((p, i) => (
                <motion.span
                  key={i}
                  className="absolute right-0 size-2 rounded-full bg-rose-500 shadow-[0_0_10px_rgba(244,63,94,0.75)]"
                  style={{ top: `${p.top}%` }}
                  initial={{ x: 24, y: 0, opacity: 0 }}
                  animate={{
                    x: [24, -PROBE_FLY, -PROBE_FLY + p.out],
                    y: [0, p.ty, p.ty + (i % 2 === 0 ? -64 : 64)],
                    opacity: [0, 1, 0],
                    scale: [0.5, 1, 0.6],
                  }}
                  transition={{ duration: 0.95, times: [0, 0.46, 1], delay: 0.05 * i, ease: ["easeIn", "backOut"] }}
                />
              ))}
            </div>
          )}
        </motion.section>

        {/* feature list */}
        <motion.section variants={riseIn} className="glass rounded-2xl p-2">
          {FEATURES.map((f) => {
            const on = f.key === "macSpoof" ? macSpoof : f.key === "tor" ? tor : f.key === "firewall" ? firewall : httpsOnly;
            return (
              <div
                key={f.key}
                className={`flex items-center gap-3 rounded-xl px-2.5 py-2.5 transition-colors ${tor && f.key === "tor" ? "bg-emerald-50/70" : "hover:bg-white/60"}`}
              >
                <div className={`grid size-9 shrink-0 place-items-center rounded-xl bg-gradient-to-br ${f.gradient} text-white shadow-sm`}>
                  <f.icon size={16} strokeWidth={2.2} />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="text-[13px] font-semibold text-stone-800">{f.label}</div>
                  <div className="truncate text-[11px] text-stone-500">{f.desc}</div>
                </div>
                <Switch on={on} onToggle={() => toggleFeature(f.key, on)} label={f.label} />
              </div>
            );
          })}
        </motion.section>

        {/* network graph */}
        <motion.section variants={riseIn}>
          <NetworkGraph tor={tor} />
        </motion.section>

        {/* event log */}
        <motion.section variants={riseIn} className="glass rounded-2xl p-3.5">
          <div className="flex items-center gap-2">
            <Activity size={12} className="text-stone-400" />
            <span className="text-[10px] font-semibold uppercase tracking-widest text-stone-400">Event log</span>
            <motion.span
              className="size-1.5 rounded-full bg-emerald-500"
              animate={{ opacity: [1, 0.3, 1] }}
              transition={{ duration: 1.8, repeat: Infinity, ease: "easeInOut" }}
            />
            <span className="ml-auto gd-mono text-[10px] text-stone-400">streaming · local</span>
          </div>
          <div ref={logRef} className="gd-scroll mt-2 h-36 overflow-y-auto rounded-xl bg-stone-900/[0.04] p-2.5">
            <AnimatePresence initial={false}>
              {log.map((row) => (
                <motion.div
                  key={row.id}
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={SPRING.snappy}
                  className="gd-mono flex gap-2.5 whitespace-nowrap text-[10.5px] leading-[1.7]"
                >
                  <span className="shrink-0 opacity-70" style={{ color: "var(--gd-accent)" }}>
                    {row.time}
                  </span>
                  <span className="truncate text-stone-600">{row.text}</span>
                </motion.div>
              ))}
            </AnimatePresence>
          </div>
        </motion.section>
      </motion.div>
    </div>
  );
}
