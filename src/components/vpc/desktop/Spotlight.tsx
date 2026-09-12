"use client";

// ============================================================
// GlassDesk — Spotlight (macOS ⌘K search × liquid glass).
// Permanently mounted by the shell; renders (and runs hooks)
// only while uiStore.overlay === "spotlight".
//   • results: apps (label match) · files (name match) · shell
//     commands (keyword match) — plus a special FIRST result
//     when the raw query is a YouTube link or 11-char video id
//     ("Watch together on YouTube" → openApp("browser",
//     { page: "yt:<id>" }) → Nova's YTTheater watch-party).
//   • RUN MODE: a query starting with ">" switches to command
//     mode — `> open terminal`, `> wallpaper sakura`, `> accent
//     rose`, `> yt <query|url>`, `> say hi`, `> lock / restart /
//     shutdown`, `> help`. One preview row + ghost-row hint list;
//     Enter executes. Everything for non-">" queries is untouched.
//   • ↑/↓ move the active row, ↵ runs it, esc / backdrop closes.
// The active index is CLAMPED DURING RENDER (never set inside
// an effect) so a shrinking result list can't go out of range.
// ============================================================

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react";
import { AnimatePresence, motion } from "framer-motion";
import {
  ChevronRight,
  FilePlus2,
  FileText,
  Image as ImageIcon,
  Play,
  Search,
  Terminal,
  type LucideIcon,
} from "lucide-react";
import { Input } from "@/components/ui/input";
import { AppIcon } from "@/components/vpc/icons/AppIcon";
import { APP_META, ORDER, openApp } from "@/components/vpc/desktop/Dock";
import { useGlassDesk } from "@/lib/vpc/store";
import { useShellUi } from "@/lib/vpc/uiStore";
import { pushToast } from "@/lib/vpc/toast";
import { TRASH_ID } from "@/lib/vpc/trash";
import {
  ACCENTS,
  WALLPAPERS,
  type AppKind,
  type AccentId,
  type FSNode,
  type WallpaperId,
} from "@/lib/vpc/types";

const SPRING = { type: "spring", stiffness: 420, damping: 30 } as const;

const YT_URL_RE = /(?:youtube\.com\/(?:watch\?v=|shorts\/)|youtu\.be\/)([A-Za-z0-9_-]{11})/;
const YT_ID_RE = /^[A-Za-z0-9_-]{11}$/;

function parseYouTubeId(raw: string): string | null {
  const m = YT_URL_RE.exec(raw);
  // m[1] is safe to return unguarded: the capture group participates
  // in every possible match of this (group-less-optional) regex.
  if (m) return m[1];
  return YT_ID_RE.test(raw) ? raw : null;
}

interface Command {
  id: string;
  label: string;
  /** tile classes for the icon tile (no blue/indigo) */
  tile: string;
  icon: LucideIcon;
  keywords: RegExp;
  run: () => void;
}

const COMMANDS: Command[] = [
  {
    id: "cmd-note",
    label: "New Text Note",
    tile: "bg-gradient-to-br from-emerald-400 to-teal-400",
    icon: FilePlus2,
    keywords: /note/,
    run: () => openApp("textedit"),
  },
  {
    id: "cmd-wallpaper",
    label: "Change Wallpaper",
    tile: "bg-gradient-to-br from-amber-400 to-orange-400",
    icon: ImageIcon,
    keywords: /wall|wallpaper|theme/,
    run: () => openApp("settings"),
  },
];

type SpotResult =
  | { key: string; kind: "yt"; videoId: string }
  | { key: string; kind: "app"; app: AppKind }
  | { key: string; kind: "file"; node: FSNode }
  | { key: string; kind: "cmd"; cmd: Command };

// ============================================================
// run-command mode ("> …")
// ============================================================

/** sessionStorage keys backing the Restart boot replay (StartMenu copies this exactly). */
const FORCE_BOOT_KEY = "gd:force-boot";
const REJOIN_CODE_KEY = "gd:rejoin-code";

interface RunParsed {
  verb: string;
  ok: boolean;
  title: string;
  caption: string;
  execute: () => void;
}

/** Ghost-row documentation for the command list. */
const RUN_DOCS: { cmd: string; desc: string }[] = [
  { cmd: "open <app>", desc: "launch an app (fuzzy by name)" },
  { cmd: "wallpaper <name>", desc: "set the desktop wallpaper" },
  { cmd: "accent <name>", desc: "teal · emerald · amber · rose · violet" },
  { cmd: "yt <query|url>", desc: "search or watch on Tube" },
  { cmd: "say <text>", desc: "Glass AI speaks a toast" },
  { cmd: "lock", desc: "lock this seat's screen" },
  { cmd: "restart", desc: "reboot — session preserved" },
  { cmd: "shutdown", desc: "leave, back to landing" },
  { cmd: "help", desc: "this list" },
];

function runErr(verb: string, msg: string): RunParsed {
  return { verb, ok: false, title: msg, caption: `> ${verb}`, execute: () => {} };
}

/** fuzzy app match — exact > startsWith > includes, over label + kind id. */
function matchAppByName(input: string): AppKind | null {
  const a = input.trim().toLowerCase();
  if (!a) return null;
  for (const app of ORDER) {
    if (APP_META[app].label.toLowerCase() === a || app === a) return app;
  }
  for (const app of ORDER) {
    if (APP_META[app].label.toLowerCase().startsWith(a) || app.startsWith(a)) return app;
  }
  for (const app of ORDER) {
    if (APP_META[app].label.toLowerCase().includes(a)) return app;
  }
  return null;
}

function matchWallpaper(input: string): WallpaperId | null {
  const a = input.trim().toLowerCase();
  if (!a) return null;
  for (const w of WALLPAPERS) {
    if (w.id.toLowerCase() === a || w.label.toLowerCase() === a) return w.id;
  }
  for (const w of WALLPAPERS) {
    if (w.id.toLowerCase().includes(a) || w.label.toLowerCase().includes(a)) return w.id;
  }
  return null;
}

function matchAccent(input: string): AccentId | null {
  const a = input.trim().toLowerCase();
  if (!a) return null;
  for (const acc of ACCENTS) {
    if (acc.id.toLowerCase() === a || acc.label.toLowerCase() === a) return acc.id;
  }
  for (const acc of ACCENTS) {
    if (acc.id.toLowerCase().includes(a) || acc.label.toLowerCase().includes(a)) return acc.id;
  }
  return null;
}

/** Restart = boot-theater REJOIN (StartMenu's exact mechanism). */
function restartMachine(): void {
  try {
    sessionStorage.setItem(FORCE_BOOT_KEY, "1");
    const code = useGlassDesk.getState().code;
    if (code) sessionStorage.setItem(REJOIN_CODE_KEY, code);
  } catch {
    /* private mode — plain reload still auto-rejoins via ?join= */
  }
  window.location.reload();
}

/** yt <query> — open Tube, then land real search results in its payload. */
function runYtSearch(q: string): void {
  openApp("youtube");
  void (async () => {
    try {
      const res = await fetch(`/api/vpc/yt?q=${encodeURIComponent(q)}`);
      if (!res.ok) throw new Error("bad status");
      const j = (await res.json()) as { videos?: unknown[] };
      const videos = (Array.isArray(j.videos) ? j.videos : []).slice(0, 12);
      openApp("youtube", { page: "results", q, results: videos });
    } catch {
      pushToast({
        title: "Tube search failed",
        body: "couldn't reach the search service",
        kind: "danger",
      });
    }
  })();
}

/** Parse a "> …" command line. null → no verb yet (show the full list). */
function parseRun(cmd: string): RunParsed | null {
  const trimmed = cmd.trim();
  if (!trimmed) return null;
  const sp = trimmed.indexOf(" ");
  const verb = (sp === -1 ? trimmed : trimmed.slice(0, sp)).toLowerCase();
  const arg = sp === -1 ? "" : trimmed.slice(sp + 1).trim();

  switch (verb) {
    case "open": {
      if (!arg) return runErr(verb, "open needs an app name — e.g. > open terminal");
      const app = matchAppByName(arg);
      if (!app) return runErr(verb, `no app matches “${arg}”`);
      return {
        verb,
        ok: true,
        title: `Open ${APP_META[app].label}`,
        caption: "application",
        execute: () => openApp(app),
      };
    }
    case "wallpaper": {
      if (!arg) {
        return runErr(verb, "wallpaper needs a name — e.g. > wallpaper sakura");
      }
      const id = matchWallpaper(arg);
      if (!id) {
        return runErr(verb, `no wallpaper matches “${arg}” — try: ${WALLPAPERS.map((w) => w.id).join(", ")}`);
      }
      const label = WALLPAPERS.find((w) => w.id === id)?.label ?? id;
      return {
        verb,
        ok: true,
        title: `Wallpaper → ${label}`,
        caption: "system patch (synced)",
        execute: () => useGlassDesk.getState().dispatch({ t: "sys", patch: { wallpaper: id } }),
      };
    }
    case "accent": {
      if (!arg) {
        return runErr(verb, "accent needs a name — e.g. > accent amber");
      }
      const id = matchAccent(arg);
      if (!id) {
        return runErr(verb, `no accent matches “${arg}” — try: ${ACCENTS.map((a) => a.id).join(", ")}`);
      }
      return {
        verb,
        ok: true,
        title: `Accent → ${id}`,
        caption: "system patch (synced)",
        execute: () => useGlassDesk.getState().dispatch({ t: "sys", patch: { accent: id } }),
      };
    }
    case "yt": {
      if (!arg) return runErr(verb, "yt needs a search query or a video link");
      const vid = parseYouTubeId(arg);
      if (vid) {
        return {
          verb,
          ok: true,
          title: "Watch on Tube",
          caption: "watch-party",
          execute: () => openApp("youtube", { page: "watch", videoId: vid }),
        };
      }
      return {
        verb,
        ok: true,
        title: `Search Tube for “${arg}”`,
        caption: "fetching results…",
        execute: () => runYtSearch(arg),
      };
    }
    case "say": {
      if (!arg) return runErr(verb, "say needs something to say — e.g. > say hello");
      return {
        verb,
        ok: true,
        title: "Glass AI says",
        caption: arg.length > 60 ? `${arg.slice(0, 60)}…` : arg,
        execute: () => pushToast({ title: "Glass AI says", body: arg }),
      };
    }
    case "lock":
      return {
        verb,
        ok: true,
        title: "Lock screen",
        caption: "local — this seat only",
        execute: () => useShellUi.getState().lock(),
      };
    case "restart":
      return {
        verb,
        ok: true,
        title: "Restart GlassDesk",
        caption: "session preserved · boot replay",
        execute: restartMachine,
      };
    case "shutdown":
      return {
        verb,
        ok: true,
        title: "Shut down",
        caption: "end session · back to landing",
        execute: () => useGlassDesk.getState().leave(),
      };
    case "help":
      return {
        verb,
        ok: true,
        title: "Command help",
        caption: "the list below is everything",
        execute: () => {},
      };
    default:
      return runErr(verb, "unknown command — try help");
  }
}

export default function Spotlight() {
  const open = useShellUi((s) => s.overlay === "spotlight");
  const setOverlay = useShellUi((s) => s.setOverlay);
  return (
    <AnimatePresence>
      {open && <SpotlightPanel key="spotlight-panel" close={() => setOverlay(null)} />}
    </AnimatePresence>
  );
}

function SpotlightPanel({ close }: { close: () => void }) {
  const fs = useGlassDesk((s) => (s.state ? s.state.fs : null));
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);

  // The field owns the keyboard the moment Spotlight opens.
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Escape closes from anywhere (input handler below also fires first).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [close]);

  const q = query.trim();

  // run-command mode — query starts with ">"
  const runMode = query.startsWith(">");
  const runParsed = runMode ? parseRun(query.slice(1)) : null;

  const results = useMemo<SpotResult[]>(() => {
    if (!q || q.startsWith(">")) return [];
    const ql = q.toLowerCase();
    const out: SpotResult[] = [];
    const yt = parseYouTubeId(q);
    if (yt) out.push({ key: `yt:${yt}`, kind: "yt", videoId: yt });
    for (const app of ORDER) {
      if (APP_META[app].label.toLowerCase().includes(ql)) {
        out.push({ key: `app:${app}`, kind: "app", app });
      }
    }
    if (fs) {
      for (const n of Object.values(fs)) {
        if (n.kind === "file" && n.parent !== TRASH_ID && n.name.toLowerCase().includes(ql)) {
          out.push({ key: `file:${n.id}`, kind: "file", node: n });
        }
      }
    }
    for (const c of COMMANDS) {
      if (c.keywords.test(ql)) out.push({ key: c.id, kind: "cmd", cmd: c });
    }
    return out;
  }, [q, fs]);

  // Derived clamp — result lists can shrink between keystrokes.
  const index = results.length === 0 ? 0 : Math.min(active, results.length - 1);

  function run(r: SpotResult): void {
    if (r.kind === "yt") openApp("browser", { page: `yt:${r.videoId}` });
    else if (r.kind === "app") openApp(r.app);
    else if (r.kind === "file") openApp("textedit", { fileId: r.node.id, value: r.node.content });
    else r.cmd.run();
    close();
  }

  /** run mode: Enter executes the preview row (the top result). */
  function execRun(): void {
    if (runParsed?.ok) {
      runParsed.execute();
      close();
    }
  }

  function onKeyDown(e: ReactKeyboardEvent<HTMLInputElement>): void {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (!runMode) setActive((i) => Math.min(i + 1, results.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      if (!runMode) setActive((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (runMode) {
        execRun();
        return;
      }
      const r = results[index];
      if (r) run(r);
    } else if (e.key === "Escape") {
      close();
    }
  }

  return (
    <>
      {/* dim + blur backdrop; clicking anywhere dismisses */}
      <motion.div
        aria-hidden
        onPointerDown={close}
        className="fixed inset-0 z-[150] bg-stone-900/20 backdrop-blur-[2px]"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        transition={{ duration: 0.16 }}
      />
      {/* centered top panel (plain wrapper keeps -translate-x-1/2 intact
          while the motion child animates scale/y on its own transform) */}
      <div className="fixed left-1/2 top-[18vh] z-[160] w-[min(92vw,560px)] -translate-x-1/2">
        <motion.div
          role="dialog"
          aria-label="Spotlight search"
          className="glass-strong overflow-hidden rounded-2xl"
          initial={{ opacity: 0, scale: 0.97, y: 10 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          exit={{ opacity: 0, scale: 0.98, y: 6 }}
          transition={SPRING}
        >
          {/* big search field — accent underline while typing.
              Run mode swaps the search glyph for a Terminal + RUN
              chip (mono, accent) prefix indicator. */}
          <div className="relative border-b border-transparent transition-colors focus-within:border-[var(--gd-accent)]">
            {runMode ? (
              <span className="pointer-events-none absolute left-3 top-1/2 flex -translate-y-1/2 items-center gap-1.5">
                <Terminal size={15} className="text-[var(--gd-accent)]" />
                <span
                  className="gd-mono rounded-md px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider"
                  style={{ background: "rgba(255,255,255,0.75)", color: "var(--gd-accent)" }}
                >
                  Run
                </span>
              </span>
            ) : (
              <Search
                size={17}
                className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-stone-400"
              />
            )}
            <Input
              ref={inputRef}
              autoFocus
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setActive(0); // fresh query → fresh selection
              }}
              onKeyDown={onKeyDown}
              placeholder={runMode ? "type a command… (help lists them all)" : "Search apps, files, or paste a YouTube link…"}
              aria-label={runMode ? "Run a command" : "Search GlassDesk"}
              spellCheck={false}
              /* inline style beats the base border/ring classes (the caret
                 + accent underline are the focus indicators for this field) */
              style={{ border: "none", boxShadow: "none" }}
              className={`${runMode ? "pl-[72px]" : "pl-11"} h-12 rounded-none bg-transparent pr-4 text-sm text-stone-700 placeholder:text-stone-400`}
            />
          </div>

          {runMode ? (
            /* -------- run-command mode: one preview row + ghost hints -------- */
            <div className="gd-scroll max-h-80 overflow-y-auto p-2">
              {runParsed && (
                <button
                  type="button"
                  onClick={execRun}
                  disabled={!runParsed.ok}
                  aria-label={runParsed.ok ? `Run: ${runParsed.title}` : runParsed.title}
                  className={`flex w-full items-center gap-3 rounded-xl border-l-2 py-2 pl-3 pr-3 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--gd-accent)] ${
                    runParsed.ok
                      ? "border-transparent bg-white/80 hover:bg-white"
                      : "cursor-default border-rose-300 bg-rose-50/80"
                  }`}
                  style={runParsed.ok ? { borderLeftColor: "var(--gd-accent)" } : undefined}
                >
                  <span
                    className={`flex size-8 shrink-0 items-center justify-center rounded-lg text-white shadow-sm ${
                      runParsed.ok ? "gd-accent-gradient" : "bg-rose-400"
                    }`}
                  >
                    <Terminal size={15} strokeWidth={2.1} />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span
                      className={`block truncate text-sm ${runParsed.ok ? "text-stone-700" : "text-rose-600"}`}
                    >
                      {runParsed.title}
                    </span>
                    <span className="block truncate text-[10px] text-stone-400">
                      {runParsed.caption}
                    </span>
                  </span>
                  {runParsed.ok && (
                    <ChevronRight size={14} className="shrink-0 text-stone-400" />
                  )}
                </button>
              )}

              {/* hint list — every available command as ghost rows */}
              <div className="mt-1 space-y-0.5">
                {RUN_DOCS.map((d) => (
                  <div
                    key={d.cmd}
                    className="flex items-baseline gap-2.5 rounded-lg px-3 py-1.5"
                    aria-hidden
                  >
                    <span className="gd-mono shrink-0 text-[11px] font-medium text-stone-500">
                      {d.cmd}
                    </span>
                    <span className="truncate text-[10px] text-stone-400">{d.desc}</span>
                  </div>
                ))}
              </div>
            </div>
          ) : (
            q !== "" && (
              <div>
                {results.length === 0 ? (
                  <p className="px-4 py-6 text-center text-xs text-stone-400">No matches</p>
                ) : (
                  <div
                    role="listbox"
                    aria-label="Search results"
                    className="gd-scroll max-h-80 overflow-y-auto p-2"
                  >
                    {results.map((r, i) => {
                      const isActive = i === index;
                      let tile: ReactNode;
                      let title: string;
                      let caption: string;
                      if (r.kind === "yt") {
                        tile = (
                          <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-red-500 text-white shadow-sm">
                            <Play size={15} className="fill-current" />
                          </span>
                        );
                        title = "Watch together on YouTube";
                        caption = "watch-party";
                      } else if (r.kind === "app") {
                        const meta = APP_META[r.app];
                        tile = <AppIcon id={r.app} size={28} />;
                        title = meta.label;
                        caption = "Application";
                      } else if (r.kind === "file") {
                        tile = (
                          <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-stone-100 text-stone-500">
                            <FileText size={15} />
                          </span>
                        );
                        title = r.node.name;
                        caption = "GlassDesk HD";
                      } else {
                        const CmdIcon = r.cmd.icon;
                        tile = (
                          <span
                            className={`flex size-8 shrink-0 items-center justify-center rounded-lg ${r.cmd.tile} text-white shadow-sm`}
                          >
                            <CmdIcon size={15} />
                          </span>
                        );
                        title = r.cmd.label;
                        caption = "command";
                      }
                      return (
                        <button
                          key={r.key}
                          type="button"
                          role="option"
                          aria-selected={isActive}
                          onPointerEnter={() => setActive(i)}
                          onClick={() => run(r)}
                          className={`flex w-full items-center gap-3 rounded-xl border-l-2 border-transparent py-2 pl-3 pr-3 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--gd-accent)] ${
                            isActive ? "bg-white/80" : "hover:bg-white/60"
                          }`}
                          style={isActive ? { borderLeftColor: "var(--gd-accent)" } : undefined}
                        >
                          {tile}
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-sm text-stone-700">{title}</span>
                            <span className="block truncate text-[10px] text-stone-400">
                              {caption}
                            </span>
                          </span>
                          <ChevronRight
                            size={14}
                            className={isActive ? "shrink-0 text-stone-400" : "shrink-0 text-transparent"}
                          />
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            )
          )}

          <p className="border-t border-white/50 px-4 py-2 text-[10px] text-stone-400">
            {"↑↓ navigate · ↵ open · esc close · > for commands"}
          </p>
        </motion.div>
      </div>
    </>
  );
}
