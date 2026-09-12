"use client";

// ============================================================
// GlassDesk — Dock (app launcher) + THE shared app registry.
//
// This module is the CONTRACT every other UI agent imports:
//   • ORDER / APP_META / DEFAULT_PAYLOADS / openApp / nextZ
//   • openNewWindow (NEW — always spawns a fresh instance)
// Apps never hand-roll a `win:open` op — always go through
// openApp(): it dedupes per app, raises + un-minimizes, and
// seeds a sane default payload (incl. the live terminal banner).
// openNewWindow() skips the dedupe — Windows "New window" from
// a jump list must produce a true second instance.
//
// TASKBAR 2.0 (Windows 11 grade) — the shell section below:
//   • click: open / minimize / restore + focus / cycle multi-
//     window apps (Windows semantics)
//   • hover ~350ms: glass PREVIEW popover above the launcher —
//     one mini-window card per window (gradient + true aspect
//     ratio + title + close X) — see taskbar/PreviewPop.tsx
//   • right-click: JUMP LIST via openContextMenu — see
//     taskbar/jumpList.tsx (recents for textedit/files, New
//     window, Close all windows)
//   • tray: session pill (peers · code · connection — the menubar's
//     essentials, relocated in 12-d) · workspace chips · task view
//     (F3) · notification bell (unread dot) · network + battery
//     status · media mini · fullscreen (12-d) · control center ·
//     clock · show desktop
// ============================================================

import { useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from "react";
import { AnimatePresence, motion, useMotionValue, useSpring, useTransform, type MotionValue } from "framer-motion";
import {
  Activity,
  BatteryMedium,
  Bell,
  Bomb,
  Calculator,
  CalendarDays,
  Camera,
  Clock3,
  CloudSun,
  Code2,
  Compass,
  Copy,
  Crown,
  FileText,
  Folder,
  Gamepad2,
  Grid2x2,
  Hash,
  Image,
  LayoutGrid,
  Mail,
  Map as MapIcon,
  Maximize,
  MessageCircle,
  Mic,
  Minimize,
  Music,
  Palette,
  Pause,
  PenTool,
  Play,
  Settings,
  ShieldCheck,
  ShoppingBag,
  SlidersHorizontal,
  Sparkles,
  SquareTerminal,
  StickyNote,
  Users,
  Wifi,
  Youtube,
  type LucideIcon,
} from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { AppIcon } from "@/components/vpc/icons/AppIcon";
import { useGlassDesk, type PeerInfo } from "@/lib/vpc/store";
import { useToast } from "@/hooks/use-toast";
import { TRACK_TITLES } from "@/lib/vpc/media";
import { toastUnread, useToasts } from "@/lib/vpc/toast";
import { useShellUi } from "@/lib/vpc/uiStore";
import { uid, WORKSPACES, type AppKind, type WindowState } from "@/lib/vpc/types";
import { openContextMenu } from "./ContextMenu";
import PreviewPop, { type PreviewAnchor } from "./taskbar/PreviewPop";
import { buildAppJumpList } from "./taskbar/jumpList";

export const ORDER: AppKind[] = [
  "files",
  "browser",
  "youtube",
  "ai",
  "media",
  "photos",
  "notes",
  "calendar",
  "clock",
  "weather",
  "maps",
  "textedit",
  "code",
  "paint",
  "whiteboard",
  "camera",
  "voice",
  "terminal",
  "mail",
  "contacts",
  "calculator",
  "mines",
  "snake",
  "g2048",
  "taskmgr",
  "security",
  "store",
  "settings",
];

export interface AppMeta {
  label: string;
  icon: LucideIcon;
  /** tailwind from-/to- gradient classes for the icon tile (no blue/indigo) */
  gradient: string;
  /** default window size */
  w: number;
  h: number;
  /** minimum window size (resize clamp) */
  minW: number;
  minH: number;
}

export const APP_META: Record<AppKind, AppMeta> = {
  files: {
    label: "Files",
    icon: Folder,
    gradient: "from-teal-400 to-emerald-400",
    w: 760,
    h: 500,
    minW: 480,
    minH: 320,
  },
  textedit: {
    label: "TextEdit",
    icon: FileText,
    gradient: "from-emerald-400 to-teal-400",
    w: 560,
    h: 420,
    minW: 380,
    minH: 280,
  },
  terminal: {
    label: "Terminal",
    icon: SquareTerminal,
    gradient: "from-stone-500 to-stone-700",
    w: 680,
    h: 440,
    minW: 460,
    minH: 300,
  },
  whiteboard: {
    label: "Whiteboard",
    icon: PenTool,
    gradient: "from-violet-400 to-fuchsia-400",
    w: 780,
    h: 540,
    minW: 520,
    minH: 380,
  },
  browser: {
    label: "Nova",
    icon: Compass,
    gradient: "from-amber-400 to-orange-400",
    w: 880,
    h: 580,
    minW: 560,
    minH: 400,
  },
  media: {
    label: "Media",
    icon: Music,
    gradient: "from-rose-400 to-pink-400",
    w: 420,
    h: 380,
    minW: 360,
    minH: 320,
  },
  calculator: {
    label: "Calculator",
    icon: Calculator,
    gradient: "from-teal-500 to-cyan-500",
    w: 300,
    h: 430,
    minW: 280,
    minH: 400,
  },
  settings: {
    label: "Settings",
    icon: Settings,
    gradient: "from-emerald-500 to-teal-600",
    w: 660,
    h: 500,
    minW: 480,
    minH: 380,
  },
  taskmgr: {
    label: "Task Manager",
    icon: Activity,
    gradient: "from-rose-500 to-amber-500",
    w: 580,
    h: 480,
    minW: 460,
    minH: 380,
  },
  photos: {
    label: "Photos",
    icon: Image,
    gradient: "from-teal-400 to-emerald-500",
    w: 860,
    h: 560,
    minW: 620,
    minH: 400,
  },
  notes: {
    label: "Notes",
    icon: StickyNote,
    gradient: "from-amber-300 to-orange-400",
    w: 720,
    h: 500,
    minW: 520,
    minH: 360,
  },
  calendar: {
    label: "Calendar",
    icon: CalendarDays,
    gradient: "from-rose-400 to-pink-500",
    w: 760,
    h: 540,
    minW: 560,
    minH: 400,
  },
  clock: {
    label: "Clock",
    icon: Clock3,
    gradient: "from-emerald-300 to-teal-500",
    w: 520,
    h: 480,
    minW: 420,
    minH: 360,
  },
  weather: {
    label: "Weather",
    icon: CloudSun,
    gradient: "from-amber-300 to-rose-400",
    w: 800,
    h: 560,
    minW: 560,
    minH: 420,
  },
  paint: {
    label: "Paint",
    icon: Palette,
    gradient: "from-fuchsia-400 to-rose-500",
    w: 800,
    h: 560,
    minW: 560,
    minH: 420,
  },
  mines: {
    label: "Minesweeper",
    icon: Bomb,
    gradient: "from-stone-500 to-stone-700",
    w: 520,
    h: 600,
    minW: 420,
    minH: 460,
  },
  snake: {
    label: "Snake",
    icon: Gamepad2,
    gradient: "from-lime-400 to-emerald-600",
    w: 520,
    h: 600,
    minW: 420,
    minH: 460,
  },
  g2048: {
    label: "2048",
    icon: Hash,
    gradient: "from-orange-400 to-amber-600",
    w: 460,
    h: 580,
    minW: 380,
    minH: 480,
  },
  youtube: {
    label: "Tube",
    icon: Youtube,
    gradient: "from-rose-500 to-red-500",
    w: 940,
    h: 600,
    minW: 640,
    minH: 440,
  },
  ai: {
    label: "Glass AI",
    icon: Sparkles,
    gradient: "from-teal-300 via-emerald-400 to-emerald-500",
    w: 520,
    h: 620,
    minW: 420,
    minH: 460,
  },
  code: {
    label: "Code",
    icon: Code2,
    gradient: "from-emerald-400 to-teal-600",
    w: 900,
    h: 600,
    minW: 620,
    minH: 420,
  },
  mail: {
    label: "Mail",
    icon: Mail,
    gradient: "from-rose-400 to-amber-400",
    w: 900,
    h: 580,
    minW: 640,
    minH: 440,
  },
  camera: {
    label: "Camera",
    icon: Camera,
    gradient: "from-teal-400 to-emerald-600",
    w: 720,
    h: 560,
    minW: 520,
    minH: 420,
  },
  voice: {
    label: "Voice Memos",
    icon: Mic,
    gradient: "from-fuchsia-400 to-rose-500",
    w: 520,
    h: 600,
    minW: 420,
    minH: 460,
  },
  maps: {
    label: "Maps",
    icon: MapIcon,
    gradient: "from-emerald-300 to-teal-500",
    w: 880,
    h: 580,
    minW: 620,
    minH: 440,
  },
  contacts: {
    label: "People",
    icon: Users,
    gradient: "from-amber-300 to-orange-400",
    w: 720,
    h: 520,
    minW: 520,
    minH: 400,
  },
  security: {
    label: "Security Center",
    icon: ShieldCheck,
    gradient: "from-emerald-400 to-teal-600",
    w: 720,
    h: 560,
    minW: 540,
    minH: 420,
  },
  store: {
    label: "Glass Store",
    icon: ShoppingBag,
    gradient: "from-teal-400 to-rose-400",
    w: 880,
    h: 580,
    minW: 620,
    minH: 440,
  },
};

// Static per-app payloads. NOTE for app agents:
//  • terminal `lines` is intentionally [] here — openApp() seeds the
//    banner with the LIVE hostname (it lives in the store, unknowable
//    at module scope). Always open apps via openApp().
export const DEFAULT_PAYLOADS: Record<AppKind, Record<string, unknown>> = {
  files: { cwd: null },
  textedit: { fileId: null, value: "" },
  terminal: { lines: [] as string[], cwd: "/", history: [] as string[] },
  whiteboard: { strokes: [] },
  browser: { page: "home", history: [] as string[] },
  media: { track: 0, playing: false, t: 0, medBy: "" },
  calculator: { expr: "" },
  settings: {},
  taskmgr: {},
  photos: { album: "all", sel: null as string | null },
  notes: { noteId: null as string | null },
  calendar: { sel: null as string | null },
  clock: { tab: "world" as string },
  weather: { city: "Bengaluru", data: null as unknown },
  paint: { strokes: [] },
  mines: { status: "new" as string, diff: "easy" as string },
  snake: { best: 0 as number },
  g2048: { status: "new" as string },
  youtube: { page: "home" as string, q: "", videoId: null as string | null, results: [] as unknown[] },
  ai: { thread: [] as unknown[], busy: false, draft: "" },
  code: { fileId: null, path: "", value: "", lang: "js" as string, out: [] as string[] },
  mail: { box: "inbox" as string, sel: null as string | null, mails: [] as unknown[] },
  camera: { filter: "none" as string, shots: 0 },
  voice: { memos: [] as unknown[], sel: null as string | null },
  maps: { q: "", pin: null as unknown, z: 11 },
  contacts: { sel: null as string | null },
  security: {},
  store: {},
};

export function openApp(app: AppKind, payload?: Record<string, unknown>): void {
  const s = useGlassDesk.getState();
  if (!s.state) return;

  const existing = s.state.windows.find((w) => w.app === app);
  if (existing) {
    // focus + restore + merge payload; if it lives on another workspace,
    // pull it to the active one (the user asked for it HERE, now)
    s.dispatch({ t: "win:z", id: existing.id, z: s.nextZ() });
    s.dispatch({ t: "win:min", id: existing.id, minimized: false });
    if (existing.workspace !== s.state.workspace) {
      s.dispatch({ t: "win:ws", id: existing.id, ws: s.state.workspace });
    }
    if (payload) s.dispatch({ t: "app:patch", id: existing.id, patch: payload });
    return;
  }

  openNewWindow(app, payload);
}

/** Windows-style "New window": ALWAYS spawns a fresh instance —
 *  openApp() intentionally focuses+reuses the existing window (single-
 *  instance UX); jump lists and power users want a true second one.
 *  Same geometry + default-payload seeding as openApp. */
export function openNewWindow(app: AppKind, payload?: Record<string, unknown>): void {
  const s = useGlassDesk.getState();
  if (!s.state) return;

  const n = s.state.windows.length;
  const meta = APP_META[app];
  const base: Record<string, unknown> = { ...DEFAULT_PAYLOADS[app] };
  if (app === "terminal") {
    base.lines = [`GlassDesk terminal · ${s.state.machine.hostname} · type \`help\``, ""];
  }

  s.dispatch({
    t: "win:open",
    win: {
      id: uid(),
      app,
      title: meta.label,
      x: 90 + (n * 26) % 180,
      y: 64 + (n * 22) % 120,
      w: meta.w,
      h: meta.h,
      z: s.nextZ(),
      minimized: false,
      maximized: false,
      workspace: s.state.workspace,
      payload: { ...base, ...payload },
    },
  });
}

/** Re-export of the store's z allocator (frozen contract). */
export function nextZ(): number {
  return useGlassDesk.getState().nextZ();
}

// ------------------------------------------------------------
// The Taskbar (Windows 11 center × Apple glass). Contract exports
// above stay frozen — this section is the shell component.
//
//  • LEFT:  Start button → StartMenu overlay (uiStore "start")
//  • CENTER: app launchers — ONE per app regardless of window
//    count; count badge (2+), running underline intensity scales
//    with window count, active app glows. Click = Windows
//    semantics (open / minimize / restore+focus / cycle). Hover
//    ~350ms = preview popover; right-click = jump list.
//  • RIGHT tray: workspace chips (Linux pager) · task view (F3) ·
//    notification bell (unread dot) · net + battery · media mini
//    (play/pause the shared synth radio) · session pill (peers ·
//    code · connection) · fullscreen (F11) · chat (Ctrl+Shift+C,
//    12-e) · control center · clock (opens CalendarPop) ·
//    show-desktop sliver
// ------------------------------------------------------------

function pad2(n: number): string {
  return n.toString().padStart(2, "0");
}

/** Peer initials for the session-pill avatars (ex-MenuBar). */
function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  const first = parts[0].charAt(0);
  const last = parts.length > 1 ? parts[parts.length - 1].charAt(0) : "";
  return (first + last).toUpperCase() || "?";
}

interface PreviewState {
  app: AppKind;
  anchor: PreviewAnchor;
}

// ------------------------------------------------------------
// macOS-style dock magnification, recalibrated (12-d): the old ×1.5
// peak read as cartoonish, dead-still reads as broken — the middle
// ground is a ×1.22 peak over a WIDER falloff (130→170) with a
// heavier spring (more mass, more damping), so icons glide a little
// instead of popping. Everything still lives in motion values —
// ZERO React re-renders, transforms only.
// ------------------------------------------------------------
function Magnify({ mouseX, children }: { mouseX: MotionValue<number>; children: React.ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const rawScale = useTransform(mouseX, (gx: number) => {
    const el = ref.current;
    if (!el) return 1;
    // live rect read is cheap here: we only ever write composited
    // transforms, so layout never invalidates between reads
    const r = el.getBoundingClientRect();
    const d = gx - (r.x + r.width / 2);
    const RADIUS = 170;
    const a = Math.abs(d);
    if (a >= RADIUS) return 1;
    const t = 1 - a / RADIUS;
    return 1 + 0.22 * t * t; // gaussian-ish falloff, max ×1.22 (12-d)
  });
  const scale = useSpring(rawScale, { stiffness: 420, damping: 26, mass: 0.9 });
  const y = useTransform(scale, (s: number) => -(s - 1) * 12);
  return (
    <motion.div ref={ref} style={{ scale, y }} className="relative shrink-0 origin-bottom">
      {children}
    </motion.div>
  );
}

export default function Dock() {
  const windows = useGlassDesk((s) => (s.state ? s.state.windows : null));
  const activeWs = useGlassDesk((s) => s.state?.workspace);
  const dispatch = useGlassDesk((s) => s.dispatch);
  // shared pointer-x for dock magnification (motion values → no re-renders)
  const dockMouseX = useMotionValue(-9999);
  const toggleOverlay = useShellUi((s) => s.toggleOverlay);
  const overlay = useShellUi((s) => s.overlay);
  const toastHistory = useToasts((s) => s.history);
  const toastSeen = useToasts((s) => s.seenCount);
  const unread = toastUnread(toastHistory, toastSeen);

  // session pill (12-d) — the menubar's essentials, relocated into
  // the tray: peers, the code (click to copy), connection dot
  const code = useGlassDesk((s) => s.code);
  const connected = useGlassDesk((s) => s.connected);
  const peers = useGlassDesk((s) => s.peers);
  const { toast } = useToast();

  const fullscreen = useShellUi((s) => s.fullscreen);
  const toggleFullscreen = useShellUi((s) => s.toggleFullscreen);

  // standalone chat panel (12-e) — independent of the call; the
  // unread badge is the CHAT unread (rose dot, same as the bell)
  const chatOpen = useShellUi((s) => s.chatOpen);
  const toggleChat = useShellUi((s) => s.toggleChat);
  const chatUnread = useGlassDesk((s) => s.unread);

  // ALL seats incl. self, host first (ex-MenuBar sort)
  const peerList = useMemo(
    () =>
      Object.values(peers).sort((a, b) =>
        a.seat === b.seat ? a.name.localeCompare(b.name) : a.seat === "host" ? -1 : 1,
      ),
    [peers],
  );

  async function copyCode(): Promise<void> {
    const value = code.trim();
    if (!value) return;
    try {
      await navigator.clipboard.writeText(value);
      toast({ title: "Code copied" });
    } catch {
      toast({ title: `Copy blocked — session code ${value}` });
    }
  }

  const windowsByApp = useMemo(() => {
    const m = new Map<AppKind, WindowState[]>();
    for (const app of ORDER) m.set(app, []);
    for (const w of windows ?? []) {
      const list = m.get(w.app);
      if (list) list.push(w);
      else m.set(w.app, [w]);
    }
    return m;
  }, [windows]);

  // ---- launch bounce — when an app gains its FIRST window (local or
  // remote), its taskbar icon does a happy little hop. Counts are
  // diffed across renders via a ref; the setState itself is deferred
  // to a timeout callback per the effect house rules.
  const [bounce, setBounce] = useState<AppKind | null>(null);
  const prevCounts = useRef<Map<AppKind, number> | null>(null);
  useEffect(() => {
    const counts = new Map<AppKind, number>();
    for (const app of ORDER) counts.set(app, windowsByApp.get(app)?.length ?? 0);
    const prev = prevCounts.current;
    prevCounts.current = counts;
    if (prev === null) return; // mount baseline — never fires
    let launched: AppKind | null = null;
    for (const app of ORDER) {
      const n = counts.get(app) ?? 0;
      const was = prev.get(app) ?? 0;
      if (n > was && was === 0) launched = app; // first window only
    }
    if (launched === null) return;
    const app = launched;
    const t0 = setTimeout(() => setBounce(app), 0);
    const t1 = setTimeout(() => setBounce((cur) => (cur === app ? null : cur)), 720);
    return () => {
      clearTimeout(t0);
      clearTimeout(t1);
    };
  }, [windowsByApp]);

  // globally focused window = highest z, not minimized
  const topWin = useMemo(() => {
    const list = windows ?? [];
    if (list.length === 0) return null;
    return list.reduce((a, b) => (b.z > a.z ? b : a));
  }, [windows]);
  const focusedApp: AppKind | null = topWin && !topWin.minimized ? topWin.app : null;
  const focusedId: string | null = topWin && !topWin.minimized ? topWin.id : null;

  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 10_000);
    return () => clearInterval(t);
  }, []);

  const mediaWin = (windows ?? []).find((w) => w.app === "media");
  const mediaPlaying = mediaWin?.payload?.playing === true;
  const mediaTrack = typeof mediaWin?.payload?.track === "number" ? mediaWin.payload.track : 0;

  // ---- hover-preview state machine -----------------------------------
  // Timers are the single source of truth: an open timer (dwell) and a
  // close timer (grace). Entering a launcher/popover cancels closes;
  // leaving schedules one. Nothing reads e.currentTarget deferred —
  // the anchor rect is captured SYNCHRONOUSLY at pointer-enter.
  const [preview, setPreview] = useState<PreviewState | null>(null);
  const openT = useRef<ReturnType<typeof setTimeout> | null>(null);
  const closeT = useRef<ReturnType<typeof setTimeout> | null>(null);

  function clearOpenT(): void {
    if (openT.current !== null) {
      clearTimeout(openT.current);
      openT.current = null;
    }
  }
  function clearCloseT(): void {
    if (closeT.current !== null) {
      clearTimeout(closeT.current);
      closeT.current = null;
    }
  }
  function schedulePreviewClose(delay: number): void {
    clearCloseT();
    closeT.current = setTimeout(() => {
      closeT.current = null;
      setPreview(null);
    }, delay);
  }
  function closePreviewNow(): void {
    clearOpenT();
    clearCloseT();
    setPreview(null);
  }
  function launcherEnter(app: AppKind, rect: DOMRect, pointerType: string): void {
    if (pointerType === "touch") return; // taps should act, not dwell-preview
    clearCloseT(); // back on a launcher → cancel any pending dismissal
    const dwell = preview ? 90 : 350; // snappy switch once one is already open
    const anchor: PreviewAnchor = {
      x: rect.left + rect.width / 2,
      top: rect.top,
      vw: window.innerWidth,
      vh: window.innerHeight,
    };
    clearOpenT();
    openT.current = setTimeout(() => {
      openT.current = null;
      setPreview({ app, anchor });
    }, dwell);
  }
  function launcherLeave(): void {
    clearOpenT(); // sweeping across the bar must never flash a popover
    if (preview) schedulePreviewClose(150);
  }

  // never leak timers on unmount
  useEffect(() => {
    return () => {
      clearOpenT();
      clearCloseT();
    };
  }, []);

  const previewWins = useMemo(() => {
    if (!preview) return [] as WindowState[];
    return (windows ?? []).filter((w) => w.app === preview.app).sort((a, b) => b.z - a.z);
  }, [preview, windows]);

  // ---- window actions -------------------------------------------------

  /** Restore + focus; pulls the window to the ACTIVE workspace (the
   *  taskbar is global — same semantics as openApp's reuse branch). */
  function pullAndFocus(win: WindowState): void {
    const s = useGlassDesk.getState();
    s.dispatch({ t: "win:min", id: win.id, minimized: false });
    s.dispatch({ t: "win:z", id: win.id, z: s.nextZ() });
    if ((win.workspace ?? 0) !== (s.state?.workspace ?? 0)) {
      s.dispatch({ t: "win:ws", id: win.id, ws: s.state?.workspace ?? 0 });
    }
  }

  /** Windows taskbar click semantics. */
  function clickLauncher(app: AppKind): void {
    closePreviewNow();
    const s = useGlassDesk.getState();
    if (!s.state) return;

    const wins = s.state.windows.filter((w) => w.app === app);
    if (wins.length === 0) {
      openApp(app);
      return;
    }

    const top = s.state.windows.reduce((a, b) => (b.z > a.z ? b : a));
    const appFocused = top.app === app && !top.minimized;

    if (appFocused && wins.length === 1) {
      // the app's single window is the focused one → minimize (Windows)
      s.dispatch({ t: "win:min", id: top.id, minimized: true });
      return;
    }
    if (appFocused) {
      // multi-window: cycle to the next window. `wins` keeps creation
      // order (applyOp never reorders the array) and `top` is the one
      // we last raised, so (pos+1)%n walks the whole group in turn.
      const pos = Math.max(0, wins.findIndex((w) => w.id === top.id));
      pullAndFocus(wins[(pos + 1) % wins.length]);
      return;
    }
    // not focused → restore + focus the app's most recent window
    const mru = [...wins].sort((a, b) => b.z - a.z)[0] ?? wins[0];
    pullAndFocus(mru);
  }

  /** Right-click launcher → jump list (singleton ContextMenuHost). */
  function openLauncherMenu(app: AppKind, e: ReactMouseEvent<HTMLDivElement>): void {
    e.preventDefault();
    e.stopPropagation(); // keep the desktop root menu out of our way
    closePreviewNow();
    const s = useGlassDesk.getState();
    if (!s.state) return;
    const items = buildAppJumpList(app, {
      meta: APP_META[app],
      wins: s.state.windows.filter((w) => w.app === app),
      fs: s.state.fs,
      openNew: (a) => openNewWindow(a),
      openRecent: (node) => {
        if (app === "textedit") openApp("textedit", { fileId: node.id, value: node.content });
        else openApp("files", { cwd: node.id });
      },
      closeAll: () => {
        const live = useGlassDesk.getState().state?.windows.filter((w) => w.app === app) ?? [];
        for (const w of live) dispatch({ t: "win:close", id: w.id });
      },
    });
    openContextMenu(e.clientX, e.clientY, items);
  }

  function toggleMedia(): void {
    const w = useGlassDesk.getState().state?.windows.find((x) => x.app === "media");
    if (!w) {
      openApp("media");
      return;
    }
    dispatch({ t: "app:patch", id: w.id, patch: { playing: !(w.payload.playing === true), t: typeof w.payload.t === "number" ? w.payload.t : 0, medBy: useGlassDesk.getState().selfId ?? "self" } });
  }

  function showDesktop(): void {
    const s = useGlassDesk.getState();
    if (!s.state) return;
    const anyVisible = s.state.windows.some((w) => !w.minimized && (w.workspace ?? 0) === s.state!.workspace);
    for (const w of s.state.windows) {
      if ((w.workspace ?? 0) !== (s.state.workspace ?? 0)) continue;
      dispatch({ t: "win:min", id: w.id, minimized: anyVisible });
    }
  }

  return (
    <div className="absolute bottom-2 left-1/2 -translate-x-1/2 z-[100] w-[calc(100%-1rem)] max-w-[1000px]">
      <nav
        aria-label="Taskbar"
        className="glass-strong gd-spec rounded-2xl h-[60px] px-2 flex items-center gap-1 select-none"
        onContextMenu={(e) => {
          // taskbar right-clicks belong to launchers (jump lists) —
          // never leak through to the desktop surface menu
          e.preventDefault();
          e.stopPropagation();
        }}
        onPointerMove={(e) => {
          // liquid-glass specular: track the pointer for the ::after highlight
          const el = e.currentTarget;
          const r = el.getBoundingClientRect();
          el.style.setProperty("--gd-mx", `${e.clientX - r.left}px`);
          el.style.setProperty("--gd-my", `${e.clientY - r.top}px`);
        }}
      >
        {/* Start */}
        <Tooltip>
          <TooltipTrigger asChild>
            <motion.button
              type="button"
              aria-label="Start"
              aria-pressed={overlay === "start"}
              whileHover={{ scale: 1.08 }}
              whileTap={{ scale: 0.94 }}
              transition={{ type: "spring", stiffness: 420, damping: 18 }}
              onClick={() => toggleOverlay("start")}
              className="gd-accent-gradient grid size-11 shrink-0 place-items-center rounded-xl text-white shadow-md"
            >
              <Grid2x2 size={20} strokeWidth={2.2} />
            </motion.button>
          </TooltipTrigger>
          <TooltipContent side="top">Start · apps, files, power</TooltipContent>
        </Tooltip>

        <span className="mx-0.5 h-8 w-px shrink-0 bg-white/60" aria-hidden />

        {/* app launchers — ONE per app: click = Windows semantics,
            hover = preview popover, right-click = jump list.
            The row feeds a shared mouseX motion value → macOS-style
            magnification (composited transforms only, no re-renders).
            NOTE the w-max + mx-auto inner row: plain justify-center on an
            overflowing scroll container clips the LEFT tiles behind the
            edge (unreachable overflow). Margin-auto centering degrades
            to left-aligned + scrollable instead — every tile reachable. */}
        <div
          className="gd-scroll flex min-w-0 flex-1 items-center overflow-x-auto"
          onPointerMove={(e) => {
            if (e.pointerType === "mouse") dockMouseX.set(e.clientX);
          }}
          onPointerLeave={() => dockMouseX.set(-9999)}
        >
          <div className="mx-auto flex w-max items-center gap-0.5">
          {ORDER.map((app) => {
            const meta = APP_META[app];
            const wins = windowsByApp.get(app) ?? [];
            const count = wins.length;
            const focused = focusedApp === app;

            const hoverProps = {
              onPointerEnter: (e: ReactPointerEvent<HTMLDivElement>) =>
                launcherEnter(app, e.currentTarget.getBoundingClientRect(), e.pointerType),
              onPointerLeave: () => launcherLeave(),
              onContextMenu: (e: ReactMouseEvent<HTMLDivElement>) => openLauncherMenu(app, e),
            };

            const tile = (
              <>
                <motion.button
                  type="button"
                  title={meta.label}
                  aria-label={`${meta.label}${count > 0 ? `, ${count} window${count > 1 ? "s" : ""}${focused ? ", active" : ""}` : ""}`}
                  whileHover={{ y: -3 }}
                  whileTap={{ scale: 0.92 }}
                  animate={
                    bounce === app
                      ? { y: [0, -13, 0, -7, 0], scale: [1, 1.1, 1, 1.05, 1], transition: { duration: 0.62, ease: "easeOut" } }
                      : { y: 0 }
                  }
                  transition={{ type: "spring", stiffness: 420, damping: 17 }}
                  onClick={() => clickLauncher(app)}
                  className="group grid size-11 place-items-center rounded-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70"
                >
                  {/* AppIcon IS the tile — gradient, sheen and glyph in one.
                      Group-driven brightness gives hover/press a live feel
                      (12-d) without touching the magnify transforms. */}
                  <AppIcon
                    id={app}
                    size={44}
                    className="transition-[filter] duration-200 group-hover:brightness-[1.06] group-active:brightness-[0.97]"
                  />
                </motion.button>

                {/* running indicator — intensity scales with window count;
                    the FOCUSED dot breathes (12-d .gd-dot-breathe), the
                    rest stay static — subtle is the keyword */}
                {count > 0 && (
                  <span
                    aria-hidden
                    className={`absolute left-1/2 -translate-x-1/2 bottom-[-4px] h-[3px] rounded-full transition-all${
                      focused ? " gd-dot-breathe" : ""
                    }`}
                    style={{
                      width: count > 1 ? 18 : 10,
                      background: "var(--gd-accent)",
                      opacity: focused ? 1 : count > 1 ? 0.85 : 0.55,
                    }}
                  />
                )}

                {/* window-count badge (2+) */}
                {count > 1 && (
                  <span
                    aria-hidden
                    className="absolute -right-1 -top-1 grid h-4 min-w-4 place-items-center rounded-full px-1 text-[9px] font-bold leading-none text-white shadow"
                    style={{ background: "linear-gradient(135deg, var(--gd-accent), var(--gd-accent-2))" }}
                  >
                    {count > 9 ? "9+" : count}
                  </span>
                )}
              </>
            );

            // not running → label tooltip; running → the hover preview
            // popover (with live titles) IS the rich tooltip.
            // Magnify wraps both paths: distance-falloff scale from the
            // row's mouseX motion value (Apple dock feel).
            return (
              <Magnify key={app} mouseX={dockMouseX}>
                {count === 0 ? (
                  <Tooltip delayDuration={400}>
                    <TooltipTrigger asChild>
                      <div className="relative shrink-0" {...hoverProps}>
                        {tile}
                      </div>
                    </TooltipTrigger>
                    <TooltipContent side="top">
                      {meta.label}
                      <span className="block text-[10px] text-stone-400">Click to open</span>
                    </TooltipContent>
                  </Tooltip>
                ) : (
                  <div className="relative shrink-0" {...hoverProps}>
                    {tile}
                  </div>
                )}
              </Magnify>
            );
          })}
          </div>
        </div>

        <span className="mx-0.5 h-8 w-px shrink-0 bg-white/60" aria-hidden />

        {/* tray: workspaces · taskview · bell · status · media · control · fullscreen · chat · clock · show-desktop
            Reflow (usable at 768, everything by 1280): 768–1023 core
            controls only (all 9 launchers still fit unscrolled) · 1024 (lg)
            + workspace chips + media mini · 1280 (xl) + network/battery
            status pill — the FULL tray, nav widens to 1000px for it.
            The launcher row is the pressure valve (scrolls) below that. */}
        <div className="flex shrink-0 items-center gap-0.5">
          <div className="hidden lg:flex items-center gap-0.5 rounded-xl bg-white/50 px-0.5 py-1" role="group" aria-label="Workspaces">
            {Array.from({ length: WORKSPACES }, (_, i) => {
              const wsCount = (windows ?? []).filter((w) => (w.workspace ?? 0) === i && !w.minimized).length;
              return (
                <button
                  key={i}
                  type="button"
                  aria-label={`Workspace ${i + 1}${wsCount ? `, ${wsCount} windows` : ""}`}
                  aria-pressed={activeWs === i}
                  title={`Workspace ${i + 1}${wsCount ? ` · ${wsCount} windows` : ""}`}
                  onClick={() => dispatch({ t: "sys", patch: { workspace: i } })}
                  className={`relative grid size-5 place-items-center rounded-md text-[10px] font-semibold tabular-nums transition-colors ${
                    activeWs === i ? "text-white shadow-sm" : "text-stone-500 hover:bg-white/80"
                  }`}
                  style={activeWs === i ? { background: "linear-gradient(135deg, var(--gd-accent), var(--gd-accent-2))" } : undefined}
                >
                  {i + 1}
                  {wsCount > 0 && activeWs !== i && (
                    <span className="absolute right-0.5 top-0.5 size-1 rounded-full" style={{ background: "var(--gd-accent)" }} aria-hidden />
                  )}
                </button>
              );
            })}
          </div>

          {/* task view — all workspaces at a glance */}
          <Tooltip>
            <TooltipTrigger asChild>
              <motion.button
                type="button"
                aria-label="Task view (F3)"
                aria-pressed={overlay === "taskview"}
                whileTap={{ scale: 0.92 }}
                transition={{ type: "spring", stiffness: 420, damping: 30 }}
                onClick={() => toggleOverlay("taskview")}
                className={`grid size-9 place-items-center rounded-xl transition-colors ${
                  overlay === "taskview" ? "bg-white/90 text-stone-800 shadow-sm" : "text-stone-600 hover:bg-white/80"
                }`}
              >
                <LayoutGrid size={17} />
              </motion.button>
            </TooltipTrigger>
            <TooltipContent side="top">Task view · all workspaces (F3)</TooltipContent>
          </Tooltip>

          {/* notification bell — unread dot from the toast store */}
          <Tooltip>
            <TooltipTrigger asChild>
              <motion.button
                type="button"
                aria-label={unread > 0 ? `Notifications (${unread} unread)` : "Notifications"}
                aria-pressed={overlay === "notifs"}
                whileTap={{ scale: 0.92 }}
                transition={{ type: "spring", stiffness: 420, damping: 30 }}
                onClick={() => toggleOverlay("notifs")}
                className={`relative grid size-9 place-items-center rounded-xl transition-colors ${
                  overlay === "notifs" ? "bg-white/90 text-stone-800 shadow-sm" : "text-stone-600 hover:bg-white/80"
                }`}
              >
                <Bell size={17} />
                {unread > 0 && (
                  <span
                    aria-hidden
                    className="absolute right-1.5 top-1.5 size-2 rounded-full bg-rose-500 ring-2 ring-white/90"
                  />
                )}
              </motion.button>
            </TooltipTrigger>
            <TooltipContent side="top">
              {unread > 0 ? `Notifications · ${unread} unread` : "Notifications"}
            </TooltipContent>
          </Tooltip>

          {/* system status — network + battery (static, title tooltips;
              icons-only pill, the numbers live in the tooltips) */}
          <div
            className="hidden xl:flex items-center gap-1.5 rounded-xl bg-white/50 px-1.5 py-2 text-stone-500"
            role="group"
            aria-label="System status"
          >
            <span role="img" title="glass-net · connected" aria-label="Network: glass-net, connected" className="grid place-items-center">
              <Wifi size={15} />
            </span>
            <span role="img" title="87% · glass-cell" aria-label="Battery: 87 percent" className="flex items-center">
              <BatteryMedium size={16} />
            </span>
          </div>

          {/* media mini — the shared synth radio */}
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                aria-label={mediaPlaying ? `Pause ${TRACK_TITLES[mediaTrack] ?? "radio"}` : "Play synth radio"}
                onClick={toggleMedia}
                className="hidden lg:flex h-10 max-w-28 items-center gap-2 rounded-xl bg-white/50 px-2 text-stone-600 hover:bg-white/80 transition-colors"
              >
                <span className="grid size-6 shrink-0 place-items-center rounded-full text-white shadow-sm" style={{ background: "linear-gradient(135deg, var(--gd-accent), var(--gd-accent-2))" }}>
                  {mediaPlaying ? <Pause size={11} className="fill-white" /> : <Play size={11} className="translate-x-[1px] fill-white" />}
                </span>
                <span className="truncate text-[11px] font-medium">{TRACK_TITLES[mediaTrack] ?? "Radio"}</span>
                {mediaPlaying && <Equalizer />}
              </button>
            </TooltipTrigger>
            <TooltipContent side="top">Shared synth radio — audible on both seats</TooltipContent>
          </Tooltip>

          {/* session pill (12-d) — the menubar's essentials, relocated:
              peer avatars (host-first, max 2) · session code (click to
              copy) · connection dot. lg+ only, compact h-10 — the
              launcher row stays the tray's pressure valve. */}
          <div
            className="hidden lg:flex h-10 shrink-0 items-center gap-2 rounded-xl bg-white/50 pl-1.5 pr-2.5"
            role="group"
            aria-label="Session"
          >
            {/* peer avatar stack — host = accent gradient + crown,
                guest = amber→rose (ex-MenuBar pattern) */}
            <div className="flex items-center -space-x-1.5">
              {peerList.slice(0, 2).map((p: PeerInfo) => (
                <Tooltip key={p.id}>
                  <TooltipTrigger asChild>
                    <div className="relative rounded-full ring-2 ring-white/70">
                      <div
                        className={`grid size-6 place-items-center rounded-full text-[9px] font-semibold text-white shadow-sm ${
                          p.host
                            ? "bg-gradient-to-br from-teal-400 to-emerald-400"
                            : "bg-gradient-to-br from-amber-400 to-rose-400"
                        }`}
                      >
                        {initialsOf(p.name)}
                      </div>
                      {p.host && (
                        <Crown
                          size={10}
                          className="absolute -top-1 -left-0.5 text-amber-500 fill-amber-400 drop-shadow-sm"
                        />
                      )}
                    </div>
                  </TooltipTrigger>
                  <TooltipContent side="top">
                    {p.name} · {p.seat}
                  </TooltipContent>
                </Tooltip>
              ))}
            </div>

            {/* session code — tap to copy (ex-MenuBar helper) */}
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  onClick={() => void copyCode()}
                  aria-label="Copy session code"
                  className="gd-mono flex items-center gap-1.5 rounded-lg px-1.5 py-1 text-xs tabular-nums tracking-[0.12em] text-stone-700 transition-colors hover:bg-white/80"
                >
                  <span>{code || "······"}</span>
                  <Copy size={11} className="text-stone-400" />
                </button>
              </TooltipTrigger>
              <TooltipContent side="top">Copy session code</TooltipContent>
            </Tooltip>

            {/* connection dot — emerald = live, amber pulse = syncing */}
            <span
              role="img"
              title={connected ? "live" : "syncing…"}
              aria-label={connected ? "Connection live" : "Reconnecting"}
              className={`size-1.5 shrink-0 rounded-full ${
                connected ? "bg-emerald-400" : "bg-amber-400 animate-pulse"
              }`}
            />
          </div>

          <Tooltip>
            <TooltipTrigger asChild>
              <motion.button
                type="button"
                aria-label="Control center"
                aria-pressed={overlay === "control"}
                whileTap={{ scale: 0.92 }}
                onClick={() => toggleOverlay("control")}
                className="grid size-10 place-items-center rounded-xl text-stone-600 hover:bg-white/80 transition-colors"
              >
                <SlidersHorizontal size={16} />
              </motion.button>
            </TooltipTrigger>
            <TooltipContent side="top">Control center</TooltipContent>
          </Tooltip>

          {/* fullscreen — prefer fullscreen: zero chrome, max window
              space (12-d). F11 is the keyboard twin; the state lives
              in uiStore and is kept truthful by SessionView's
              "fullscreenchange" listener. */}
          <Tooltip>
            <TooltipTrigger asChild>
              <motion.button
                type="button"
                aria-label="Toggle fullscreen (F11)"
                aria-pressed={fullscreen}
                whileTap={{ scale: 0.92 }}
                transition={{ type: "spring", stiffness: 420, damping: 30 }}
                onClick={() => toggleFullscreen()}
                className="grid size-10 place-items-center rounded-xl text-stone-600 hover:bg-white/80 transition-colors"
              >
                {fullscreen ? <Minimize size={16} /> : <Maximize size={16} />}
              </motion.button>
            </TooltipTrigger>
            <TooltipContent side="top">
              {fullscreen ? "Exit fullscreen (F11)" : "Fullscreen — max view (F11)"}
            </TooltipContent>
          </Tooltip>

          {/* chat (12-e) — the standalone chat panel's tray twin.
              Works with or without a live call; rose unread dot uses
              the bell's badge pattern (chat unread from the store). */}
          <Tooltip>
            <TooltipTrigger asChild>
              <motion.button
                type="button"
                aria-label={chatUnread > 0 ? `Chat (${chatUnread} unread)` : "Chat"}
                aria-pressed={chatOpen}
                whileTap={{ scale: 0.92 }}
                transition={{ type: "spring", stiffness: 420, damping: 30 }}
                onClick={toggleChat}
                className={`relative grid size-10 place-items-center rounded-xl transition-colors ${
                  chatOpen ? "bg-white/90 text-stone-800 shadow-sm" : "text-stone-600 hover:bg-white/80"
                }`}
              >
                <MessageCircle size={16} />
                {chatUnread > 0 && (
                  <span
                    aria-hidden
                    className="absolute right-1.5 top-1.5 size-2 rounded-full bg-rose-500 ring-2 ring-white/90"
                  />
                )}
              </motion.button>
            </TooltipTrigger>
            <TooltipContent side="top">
              {chatUnread > 0 ? `Chat · ${chatUnread} unread (Ctrl+Shift+C)` : "Chat (Ctrl+Shift+C)"}
            </TooltipContent>
          </Tooltip>

          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                aria-label="Clock and calendar"
                aria-pressed={overlay === "calendar"}
                onClick={() => toggleOverlay("calendar")}
                className="gd-mono h-10 rounded-xl bg-white/50 px-1.5 text-xs tabular-nums text-stone-600 hover:bg-white/80 transition-colors leading-tight"
              >
                <span className="block">{pad2(now.getHours())}:{pad2(now.getMinutes())}</span>
              </button>
            </TooltipTrigger>
            <TooltipContent side="top">
              {now.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" })}
            </TooltipContent>
          </Tooltip>

          {/* show-desktop sliver (Windows) */}
          <button
            type="button"
            aria-label="Show desktop"
            title="Show desktop"
            onClick={showDesktop}
            className="h-9 w-2 rounded-full bg-white/50 hover:bg-white/90 transition-colors"
          />
        </div>
      </nav>

      {/* hover preview popover — portal-rendered above the launcher,
          alive only while the pointer is over launcher or popover */}
      <AnimatePresence>
        {preview && previewWins.length > 0 && (
          <PreviewPop
            key={preview.app}
            app={preview.app}
            meta={APP_META[preview.app]}
            wins={previewWins}
            activeWs={activeWs ?? 0}
            focusedId={focusedId}
            anchor={preview.anchor}
            onActivate={(w) => {
              pullAndFocus(w);
              closePreviewNow();
            }}
            onCloseWin={(id) => dispatch({ t: "win:close", id })}
            onEnter={() => clearCloseT()}
            onLeave={() => schedulePreviewClose(120)}
          />
        )}
      </AnimatePresence>
    </div>
  );
}

/** 4-bar dancing equalizer for the media mini. */
function Equalizer() {
  return (
    <span className="flex h-3.5 items-end gap-[2px]" aria-hidden>
      {[0, 1, 2, 3].map((i) => (
        <motion.span
          key={i}
          className="w-[3px] rounded-full"
          style={{ background: "linear-gradient(180deg, var(--gd-accent), var(--gd-accent-2))" }}
          animate={{ height: ["30%", "100%", "45%", "85%", "30%"] }}
          transition={{ duration: 1.1 + i * 0.13, repeat: Infinity, ease: "easeInOut" }}
        />
      ))}
    </span>
  );
}
