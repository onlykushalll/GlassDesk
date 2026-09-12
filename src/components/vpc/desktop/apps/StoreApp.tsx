"use client";

// ============================================================
// GlassDesk — Glass Store. The catalog that REALLY installs.
//
// Installing writes a real FS node (kind "app", parent =
// DESKTOP_NODE_ID, content = AppKind) via fs:upsert — the
// desktop instantly renders the shortcut with the app's true
// icon+gradient, on BOTH seats (free through live sync).
// Uninstall = fs:delete of that node. The store's own payload
// stays {} — installed state derives LIVE from the filesystem.
//
// Motion set-pieces (springs, transform/opacity only):
//   • featured carousel — x-slide spring transition, scaleX
//     dot indicator, autoplay isolated inside a memoized
//     component (never re-renders the grid)
//   • category rail — gliding accent pill (layoutId + glide)
//   • grid — rise+stagger entrance, subtle layout FLIP on
//     category/search changes
//   • install flow — determinate progress bar (scaleX spring),
//     cycling stage captions, check burst on completion
// ============================================================

import { memo, useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Check, Download, Play, Search, Star, Trash2, X } from "lucide-react";
import { APP_META, ORDER, openApp } from "@/components/vpc/desktop/Dock";
import { AppIcon } from "@/components/vpc/icons/AppIcon";
import { useGlassDesk } from "@/lib/vpc/store";
import { pushToast } from "@/lib/vpc/toast";
import { FLIP, SPRING, riseIn, stagger } from "@/lib/vpc/motion";
import { APP_RAM, DESKTOP_NODE_ID, fsChildren, uid, type AppKind, type FSMap, type FSNode, type WindowState } from "@/lib/vpc/types";

// ---------------- catalog data ----------------

const DESC: Record<AppKind, string> = {
  files: "Browse, move and share the GlassDesk HD volume",
  browser: "Tabbed co-browsing with the live web",
  youtube: "Search and watch videos together, in sync",
  ai: "A shared AI co-pilot for two pilots",
  media: "A live synth radio both seats can DJ",
  photos: "Albums of wallpaper-grade photography",
  notes: "Quick shared notes that autosave to disk",
  calendar: "One month grid for shared plans and events",
  clock: "World clocks, timers and alarms in sync",
  weather: "Live conditions for any city on Earth",
  maps: "Explore OpenStreetMap together",
  textedit: "Distraction-free editor for files on disk",
  code: "A tiny IDE with a live JS runner",
  paint: "Brushes, palettes and real PNG export",
  whiteboard: "Infinite shared canvas for sketches",
  camera: "Snap filtered shots from the device camera",
  voice: "Record and trim voice memos together",
  terminal: "A real shell for the software PC",
  mail: "A playful shared inbox for the machine",
  contacts: "The little black book of GlassDesk",
  calculator: "Number crunching with tape history",
  mines: "Classic first-click-safe Minesweeper",
  snake: "The timeless grid game, synced",
  g2048: "Merge the tiles all the way to 2048",
  taskmgr: "Live RAM graphs and process control",
  security: "Harden the whole machine with one dial",
  store: "Install more apps straight to the desktop",
  settings: "Wallpapers, accents and machine specs",
};

const WAVE9 = new Set<AppKind>(["ai", "code", "mail", "camera", "voice", "maps", "contacts", "security", "store"]);

type CatId = "all" | "featured" | "create" | "work" | "play" | "system";

const CATS: { id: CatId; label: string; apps: AppKind[] }[] = [
  { id: "all", label: "All", apps: ORDER },
  { id: "featured", label: "Featured", apps: [...WAVE9] },
  {
    id: "create",
    label: "Creativity",
    apps: ["whiteboard", "paint", "photos", "camera", "voice", "media", "ai", "code", "textedit"],
  },
  {
    id: "work",
    label: "Work",
    apps: ["files", "textedit", "notes", "calendar", "mail", "contacts", "calculator", "code", "terminal", "maps", "weather", "taskmgr"],
  },
  { id: "play", label: "Play", apps: ["mines", "snake", "g2048", "youtube", "media", "paint"] },
  { id: "system", label: "System", apps: ["files", "terminal", "settings", "taskmgr", "security", "store", "clock", "weather"] },
];

const CAT_BY_ID = new Map<CatId, AppKind[]>(CATS.map((c) => [c.id, c.apps]));

const SLIDES: { img: string; title: string; sub: string; cta: string; app: AppKind }[] = [
  { img: "/wallpapers/aurora-peak.png", title: "The AI wave", sub: "Glass AI — a co-pilot built for two", cta: "Try Glass AI", app: "ai" },
  { img: "/wallpapers/dawn-dunes.png", title: "Create together", sub: "One shared canvas, live cursors", cta: "Open Whiteboard", app: "whiteboard" },
  { img: "/wallpapers/sakura.png", title: "Play together", sub: "Arcade classics, synced seat to seat", cta: "Play 2048", app: "g2048" },
];

const STAGES = ["Fetching package…", "Verifying signature…", "Creating shortcut…"];

const EMPTY_FS: FSMap = {};

/** Deterministic 4-or-5 star rating from the app kind. */
function starsOf(app: AppKind): number {
  let h = 0;
  for (let i = 0; i < app.length; i++) h = (h * 31 + app.charCodeAt(i)) >>> 0;
  return 4 + (h % 2);
}

// ---------------- featured carousel (isolated, memoized) ----------------

function FeaturedCarousel() {
  const [i, setI] = useState(0);
  const [paused, setPaused] = useState(false);

  useEffect(() => {
    if (paused) return;
    const t = setInterval(() => setI((v) => (v + 1) % SLIDES.length), 5000);
    return () => clearInterval(t);
  }, [paused]);

  const s = SLIDES[i];

  return (
    <div
      className="relative h-40 overflow-hidden rounded-2xl shadow-lg shadow-stone-900/10"
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
    >
      <AnimatePresence initial={false}>
        <motion.div
          key={i}
          className="absolute inset-0"
          initial={{ opacity: 0, x: 72 }}
          animate={{ opacity: 1, x: 0 }}
          exit={{ opacity: 0, x: -72 }}
          transition={SPRING.window}
        >
          <img src={s.img} alt="" draggable={false} className="absolute inset-0 h-full w-full object-cover" />
          <div className="absolute inset-0 bg-gradient-to-r from-stone-900/60 via-stone-900/25 to-transparent" />
          <div className="absolute top-1/2 left-5 flex w-[70%] -translate-y-1/2 flex-col gap-1.5">
            <span className="text-lg font-bold tracking-tight text-white drop-shadow-sm">{s.title}</span>
            <span className="text-[11px] font-medium text-white/85">{s.sub}</span>
            <motion.button
              type="button"
              onClick={() => openApp(s.app)}
              whileHover={{ scale: 1.05 }}
              whileTap={{ scale: 0.95 }}
              transition={SPRING.snappy}
              className="gd-accent-gradient mt-1.5 w-fit rounded-full px-3.5 py-1.5 text-xs font-semibold text-white shadow-lg shadow-emerald-900/25"
            >
              {s.cta}
            </motion.button>
          </div>
        </motion.div>
      </AnimatePresence>

      {/* dots — active dot elongates via scaleX (transform only) */}
      <div className="absolute bottom-3 left-1/2 flex -translate-x-1/2 items-center gap-1.5">
        {SLIDES.map((_, d) => (
          <button
            key={d}
            type="button"
            aria-label={`Slide ${d + 1}`}
            onClick={() => setI(d)}
            className="grid size-3 cursor-pointer place-items-center"
          >
            <motion.span
              className={`block h-1.5 w-1.5 rounded-full ${d === i ? "bg-white" : "bg-white/50"}`}
              initial={false}
              animate={{ scaleX: d === i ? 2.4 : 1 }}
              transition={SPRING.snappy}
            />
          </button>
        ))}
      </div>
    </div>
  );
}

const Carousel = memo(FeaturedCarousel);

// ---------------- install / open / uninstall actions ----------------

function CardActions({ app, node }: { app: AppKind; node: FSNode | null }) {
  const dispatch = useGlassDesk((s) => s.dispatch);
  const label = APP_META[app].label;
  const [stage, setStage] = useState(-1); // -1 idle · 0..2 installing
  const [burst, setBurst] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const timers = useRef<number[]>([]);
  useEffect(() => {
    return () => {
      timers.current.forEach((t) => clearTimeout(t));
    };
  }, []);

  function later(fn: () => void, ms: number): void {
    timers.current.push(window.setTimeout(fn, ms));
  }

  function install(): void {
    if (stage >= 0) return;
    setConfirm(false);
    setStage(0);
    later(() => setStage(1), 560);
    later(() => setStage(2), 1120);
    later(() => {
      setStage(-1);
      // dedupe against the LIVE filesystem (the co-seat may have installed
      // the same app a second ago — never write a second shortcut node)
      const live = useGlassDesk.getState().state;
      const exists = live
        ? fsChildren(live.fs, DESKTOP_NODE_ID).some((n) => n.kind === "app" && n.content === app)
        : false;
      if (!exists) {
        dispatch({
          t: "fs:upsert",
          node: { id: uid(), name: label, kind: "app", parent: DESKTOP_NODE_ID, content: app, updatedAt: Date.now() },
        });
        pushToast({ title: `Installed ${label}`, body: "It's on the desktop.", kind: "success" });
      }
      setBurst(true);
      later(() => setBurst(false), 950);
    }, 1680);
  }

  function uninstall(): void {
    if (!confirm) {
      setConfirm(true);
      later(() => setConfirm(false), 3200);
      return;
    }
    setConfirm(false);
    if (node) {
      dispatch({ t: "fs:delete", id: node.id });
      pushToast({ title: `Removed ${label}`, body: "Shortcut deleted from the desktop.", kind: "info" });
    }
  }

  // installing — determinate progress bar with cycling stage text
  if (stage >= 0) {
    return (
      <div className="relative h-8 overflow-hidden rounded-full bg-stone-800/90 shadow-inner">
        <motion.div
          className="absolute inset-0 origin-left gd-accent-gradient"
          initial={{ scaleX: 0 }}
          animate={{ scaleX: 1 }}
          transition={{ type: "spring", stiffness: 55, damping: 20, restDelta: 0.001 }}
        />
        <div className="relative flex h-full items-center justify-center">
          <AnimatePresence mode="wait" initial={false}>
            <motion.span
              key={stage}
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -6 }}
              transition={SPRING.snappy}
              className="text-[11px] font-semibold text-white/95"
            >
              {STAGES[stage]}
            </motion.span>
          </AnimatePresence>
        </div>
      </div>
    );
  }

  // installed — Open + Uninstall (two-click confirm)
  if (node) {
    return (
      <div className="relative flex items-center gap-2">
        <motion.button
          type="button"
          onClick={() => openApp(app)}
          whileHover={{ scale: 1.03 }}
          whileTap={{ scale: 0.96 }}
          transition={SPRING.snappy}
          className="flex h-8 flex-1 items-center justify-center gap-1.5 rounded-full border border-white/70 bg-white/85 text-xs font-semibold text-stone-700 shadow-sm"
        >
          <Play size={12} strokeWidth={2.5} style={{ color: "var(--gd-accent)" }} />
          Open
        </motion.button>
        <motion.button
          type="button"
          layout
          transition={{ layout: FLIP }}
          onClick={uninstall}
          className={`flex h-8 shrink-0 cursor-pointer items-center gap-1.5 rounded-full text-[11px] font-semibold ${
            confirm
              ? "bg-rose-500 px-3 text-white shadow-md shadow-rose-500/30"
              : "border border-white/70 bg-white/85 px-2.5 text-stone-400 shadow-sm"
          }`}
        >
          <Trash2 size={13} />
          <AnimatePresence initial={false}>
            {confirm && (
              <motion.span
                key="cf"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.14 }}
                className="whitespace-nowrap"
              >
                Uninstall?
              </motion.span>
            )}
          </AnimatePresence>
        </motion.button>

        {/* check burst right after an install lands */}
        <AnimatePresence>
          {burst && (
            <motion.span
              key="burst"
              initial={{ scale: 0.5, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.8, opacity: 0 }}
              transition={SPRING.playful}
              className="absolute -top-3.5 right-0 flex items-center gap-1 rounded-full bg-emerald-100/95 px-2 py-1 text-[10px] font-bold whitespace-nowrap text-emerald-700 shadow-md"
            >
              <Check size={11} strokeWidth={3} />
              added
            </motion.span>
          )}
        </AnimatePresence>
      </div>
    );
  }

  // not installed — Install
  return (
    <motion.button
      type="button"
      onClick={install}
      whileHover={{ scale: 1.03 }}
      whileTap={{ scale: 0.96 }}
      transition={SPRING.snappy}
      className="gd-accent-gradient flex h-8 flex-1 cursor-pointer items-center justify-center gap-1.5 rounded-full text-xs font-semibold text-white shadow-md shadow-emerald-500/25"
    >
      <Download size={13} strokeWidth={2.5} />
      Install
    </motion.button>
  );
}

// ---------------- app card ----------------

function AppCard({ app, node }: { app: AppKind; node: FSNode | null }) {
  const meta = APP_META[app];
  const rating = starsOf(app);

  return (
    <motion.article
      layout
      variants={riseIn}
      transition={{ layout: FLIP }}
      whileHover={{ y: -3 }}
      className="glass flex flex-col gap-2.5 rounded-2xl p-3.5"
    >
      <div className="flex items-start gap-3">
        <AppIcon id={app} size={48} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <h3 className="truncate text-[13px] font-bold text-stone-800">{meta.label}</h3>
            {WAVE9.has(app) && (
              <span className="shrink-0 rounded-full bg-gradient-to-r from-rose-400 to-amber-400 px-1.5 py-px text-[8.5px] font-extrabold tracking-wide text-white">
                NEW
              </span>
            )}
          </div>
          <p className="mt-0.5 line-clamp-2 text-[11px] leading-snug text-stone-500">{DESC[app]}</p>
        </div>
      </div>

      <div className="flex items-center justify-between">
        <div className="flex items-center gap-0.5">
          {[0, 1, 2, 3, 4].map((n) => (
            <Star key={n} size={10} className={n < rating ? "fill-amber-400 text-amber-400" : "fill-stone-200 text-stone-200"} />
          ))}
        </div>
        <span className="gd-mono rounded-full bg-white/70 px-2 py-0.5 text-[10px] font-medium text-stone-500">{APP_RAM[app]} MB</span>
      </div>

      <CardActions app={app} node={node} />
    </motion.article>
  );
}

// ---------------- app ----------------

export default function StoreApp({ win }: { win: WindowState }) {
  const dispatch = useGlassDesk((s) => s.dispatch);
  const fs = useGlassDesk((s) => (s.state ? s.state.fs : EMPTY_FS));
  const [q, setQ] = useState("");
  const [cat, setCat] = useState<CatId>("all");

  // installed = any Desktop child node with kind "app" — LIVE from the
  // synced FS, so both seats see installs/uninstalls the instant they land
  const installedByApp = useMemo(() => {
    const m = new Map<AppKind, FSNode>();
    for (const n of fsChildren(fs, DESKTOP_NODE_ID)) {
      if (n.kind === "app") {
        const key = n.content as AppKind;
        if (!m.has(key)) m.set(key, n);
      }
    }
    return m;
  }, [fs]);

  const visible = useMemo(() => {
    const ql = q.trim().toLowerCase();
    const inCat = cat === "all" ? ORDER : (CAT_BY_ID.get(cat) ?? []);
    return inCat.filter((app) => {
      if (!ql) return true;
      return (
        APP_META[app].label.toLowerCase().includes(ql) ||
        DESC[app].toLowerCase().includes(ql)
      );
    });
  }, [cat, q]);

  // keep the window title honest about what's on the desktop
  useEffect(() => {
    const title = `Glass Store · ${installedByApp.size} installed`;
    if (win.title !== title) {
      dispatch({ t: "win:title", id: win.id, title });
    }
  }, [installedByApp, win.id, win.title, dispatch]);

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {/* header */}
      <header className="flex shrink-0 items-center gap-3 px-5 pt-4 pb-3">
        <AppIcon id="store" size={44} />
        <div className="min-w-0">
          <h1 className="text-base font-bold tracking-tight text-stone-800">Glass Store</h1>
          <p className="text-[11px] text-stone-500">Installs land on the shared desktop — both seats, instantly</p>
        </div>
        <span className="ml-auto shrink-0 rounded-full bg-emerald-100/70 px-2.5 py-1 text-[10px] font-semibold text-emerald-700">{installedByApp.size} installed</span>
        <label className="flex shrink-0 cursor-text items-center gap-2 rounded-full border border-white/70 bg-white/75 px-3 py-1.5 shadow-sm focus-within:ring-2 focus-within:ring-emerald-400/40">
          <Search size={13} className="shrink-0 text-stone-400" />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search apps"
            className="w-44 bg-transparent text-xs text-stone-700 outline-none placeholder:text-stone-400"
          />
          {q && (
            <button
              type="button"
              aria-label="Clear search"
              onClick={() => setQ("")}
              className="grid size-4 shrink-0 cursor-pointer place-items-center rounded-full text-stone-400 hover:text-stone-600"
            >
              <X size={11} strokeWidth={2.5} />
            </button>
          )}
        </label>
      </header>

      {/* featured hero carousel */}
      <div className="shrink-0 px-5 pb-3">
        <Carousel />
      </div>

      {/* category rail — gliding accent pill */}
      <div className="shrink-0 px-5 pb-3">
        <div className="glass flex w-fit items-center gap-1 rounded-full p-1">
          {CATS.map((c) => (
            <button
              key={c.id}
              type="button"
              onClick={() => setCat(c.id)}
              className="relative cursor-pointer rounded-full px-3.5 py-1.5 text-xs font-semibold"
            >
              {cat === c.id && (
                <motion.span
                  layoutId={`store-cat-${win.id}`}
                  className="absolute inset-0 rounded-full gd-accent-gradient shadow-md"
                  initial={false}
                  transition={SPRING.glide}
                />
              )}
              <span className={`relative z-10 ${cat === c.id ? "text-white" : "text-stone-500"}`}>{c.label}</span>
            </button>
          ))}
        </div>
      </div>

      {/* app grid */}
      <div className="gd-scroll flex-1 overflow-y-auto px-5 pb-5">
        <motion.div
          variants={stagger(0.024, 0.04)}
          initial="hidden"
          animate="show"
          className="grid grid-cols-[repeat(auto-fill,minmax(214px,1fr))] gap-3"
        >
          <AnimatePresence mode="popLayout" initial={false}>
            {visible.map((app) => (
              <AppCard key={app} app={app} node={installedByApp.get(app) ?? null} />
            ))}
          </AnimatePresence>
        </motion.div>

        {visible.length === 0 && (
          <motion.div
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={SPRING.window}
            className="glass mt-3 grid place-items-center gap-2 rounded-2xl p-10 text-center"
          >
            <Search size={22} className="text-stone-300" />
            <p className="text-sm font-semibold text-stone-700">No apps match “{q.trim()}”</p>
            <p className="text-[11px] text-stone-500">Try a different spelling — or clear the search.</p>
          </motion.div>
        )}
      </div>
    </div>
  );
}
