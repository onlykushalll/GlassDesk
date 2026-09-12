// ============================================================
// GlassDesk — core types + machine model + pure helpers.
// This file is the FROZEN CONTRACT shared by:
//   • the Next.js client (src/lib/vpc/store.ts, all components)
//   • the session-service (mini-services/session-service/index.ts, bun)
// It must stay directive-free ("use client" is FORBIDDEN here) and
// must never touch browser-only APIs.
// ============================================================

export type Seat = "host" | "guest";

// ---------------- apps ----------------

export type AppKind =
  | "files"
  | "textedit"
  | "terminal"
  | "whiteboard"
  | "browser"
  | "media"
  | "calculator"
  | "settings"
  | "taskmgr"
  | "photos"
  | "notes"
  | "calendar"
  | "clock"
  | "weather"
  | "paint"
  | "mines"
  | "snake"
  | "g2048"
  | "youtube"
  // wave 9 — full-OS parity pack
  | "ai"
  | "code"
  | "mail"
  | "camera"
  | "voice"
  | "maps"
  | "contacts"
  | "security"
  | "store";

export const APP_KINDS: AppKind[] = [
  "files",
  "textedit",
  "terminal",
  "whiteboard",
  "browser",
  "media",
  "calculator",
  "settings",
  "taskmgr",
  "photos",
  "notes",
  "calendar",
  "clock",
  "weather",
  "paint",
  "mines",
  "snake",
  "g2048",
  "youtube",
  "ai",
  "code",
  "mail",
  "camera",
  "voice",
  "maps",
  "contacts",
  "security",
  "store",
];

// MB of RAM each open window costs — powers live RAM telemetry.
export const APP_RAM: Record<AppKind, number> = {
  files: 26,
  textedit: 18,
  terminal: 22,
  whiteboard: 46,
  browser: 118,
  media: 64,
  calculator: 8,
  settings: 12,
  taskmgr: 14,
  photos: 38,
  notes: 16,
  calendar: 20,
  clock: 10,
  weather: 18,
  paint: 44,
  mines: 12,
  snake: 14,
  g2048: 12,
  youtube: 86,
  ai: 38,
  code: 72,
  mail: 42,
  camera: 56,
  voice: 34,
  maps: 62,
  contacts: 24,
  security: 18,
  store: 36,
};

// ---------------- machine (the software-defined PC) ----------------

export const RAM_TIERS = [
  { mb: 512, label: "512 MB", hint: "Light — notes & chat" },
  { mb: 1024, label: "1 GB", hint: "Balanced — most apps" },
  { mb: 2048, label: "2 GB", hint: "Roomy — browser + media" },
  { mb: 4096, label: "4 GB", hint: "Power — everything at once" },
] as const;

export type RamMB = 512 | 1024 | 2048 | 4096;

export const DISK_GB = 16;
export const CORES = 2;
export const NODE = "local-1";

export interface MachineSpecs {
  hostname: string; // glass-XXXX — deterministic from session code
  node: string; // "local-1"
  ramMB: RamMB;
  diskGB: number;
  cores: number;
  createdAt: number; // epoch ms — uptime anchor
}

// The 5 daemons that are "always running" on a GlassDesk PC.
export const SYSTEM_PROCS: { pid: number; name: string; mem: number; desc: string }[] = [
  { pid: 101, name: "gd-kernel", mem: 64, desc: "session kernel" },
  { pid: 112, name: "windowd", mem: 42, desc: "window compositor" },
  { pid: 127, name: "fsd", mem: 38, desc: "GlassDesk HD volume" },
  { pid: 133, name: "netd", mem: 14, desc: "live-sync transport" },
  { pid: 148, name: "snapd", mem: 10, desc: "preservance snapshots" },
];

export const BASE_RAM_MB = SYSTEM_PROCS.reduce((a, p) => a + p.mem, 0); // 168

// ---------------- workspaces (Linux-style virtual desktops) ----------------

export const WORKSPACES = 4; // 0..3 — per-workspace windows, one active
export const DESKTOP_NODE_ID = "f-desk"; // the ~/Desktop folder node

// ---------------- virtual filesystem ("GlassDesk HD") ----------------

export interface FSNode {
  id: string;
  name: string;
  /** "app" = a desktop/launcher shortcut; content holds the AppKind */
  kind: "file" | "folder" | "app";
  parent: string | null; // null = volume root ("GlassDesk HD")
  content: string; // files only
  updatedAt: number;
}

export type FSMap = Record<string, FSNode>;

export function uid(): string {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
}

/** Desktop icon positions live in the Desktop folder's (unused) content field
 *  as JSON {"pos":{"<name>":[col,row]}} — syncs for free via fs:upsert. */
export function iconPositionsOf(desk: FSNode | undefined): Record<string, [number, number]> {
  if (!desk) return {};
  try {
    const parsed = JSON.parse(desk.content || "{}") as { pos?: Record<string, [number, number]> };
    return parsed.pos ?? {};
  } catch {
    return {};
  }
}

export function iconPositionsContent(pos: Record<string, [number, number]>): string {
  return JSON.stringify({ pos });
}

export function seedFS(): FSMap {
  const now = Date.now();
  const desk: FSNode = {
    id: DESKTOP_NODE_ID,
    name: "Desktop",
    kind: "folder",
    parent: null,
    content: iconPositionsContent({
      "Welcome.txt": [0, 0],
      "Notes.txt": [0, 1],
    }),
    updatedAt: now,
  };
  const welcome: FSNode = {
    id: "f-welcome",
    name: "Welcome.txt",
    kind: "file",
    parent: DESKTOP_NODE_ID,
    content:
      "Welcome to GlassDesk 👋\n\nThis whole PC is software — it lives in the session service's memory,\nnot on anyone's real machine.\n\n• Both seats share full control: every window, file and app is synced live.\n• Everything you see is snapshotted to the GlassDesk HD volume about every\n  1.5 seconds — reload the page and rejoin this code, everything comes back.\n• Try the Terminal: type `help`, then `neofetch`, `free`, `ps`, `host`.\n• Drag windows to screen edges to snap them · hover ⬛ for snap layouts.\n• Ctrl+K opens Search · Alt+Q quick-switches windows · Ctrl+Alt+←/→ changes workspace.\n• Paste a YouTube link in Nova (the browser) or run `yt <link>`.\n• Media is a real synth radio — audible, synced on both seats.\n\n— the GlassDesk team",
    updatedAt: now,
  };
  const notes: FSNode = {
    id: "f-notes",
    name: "Notes.txt",
    kind: "file",
    parent: DESKTOP_NODE_ID,
    content: "Shared notes — both people type here at the same time.\n\nideas:\n- \n- \n",
    updatedAt: now,
  };
  return { [desk.id]: desk, [welcome.id]: welcome, [notes.id]: notes };
}

export function fsChildren(fs: FSMap, parent: string | null): FSNode[] {
  return Object.values(fs)
    .filter((n) => n.parent === parent)
    .sort((a, b) =>
      a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === "folder" ? -1 : 1,
    );
}

export function fsPathOf(fs: FSMap, id: string | null): string {
  if (!id) return "/";
  const parts: string[] = [];
  let cur: FSNode | undefined = id ? fs[id] : undefined;
  while (cur) {
    parts.unshift(cur.name);
    cur = cur.parent ? fs[cur.parent] : undefined;
  }
  return "/" + parts.join("/");
}

export function fsResolve(fs: FSMap, cwd: string, path: string): string | null {
  // Resolve a shell-style path against cwd. Returns node id or null.
  const absolute = path.startsWith("/");
  const parts = path.split("/").filter((p) => p.length > 0 && p !== ".");
  let nodeId: string | null = absolute ? null : cwd === "/" ? null : (fs[cwd]?.id ?? null);
  for (const p of parts) {
    if (p === "..") {
      nodeId = nodeId ? (fs[nodeId]?.parent ?? null) : null;
      continue;
    }
    const child = fsChildren(fs, nodeId).find((n) => n.name === p);
    if (!child) return null;
    nodeId = child.id;
  }
  return nodeId;
}

export function fsFindByPath(fs: FSMap, cwd: string, name: string): FSNode | null {
  const id = fsResolve(fs, cwd, name);
  return id ? (fs[id] ?? null) : null;
}

// Bytes "used" on the volume — JSON-size based, feels real.
export function fsBytes(fs: FSMap): number {
  return Object.values(fs).reduce((a, n) => a + n.name.length + n.content.length + 96, 0);
}

// ---------------- wallpapers & accents ----------------

export type WallpaperId =
  | "aurora"
  | "mint"
  | "peach"
  | "graphite"
  | "wp-aurora"
  | "wp-dunes"
  | "wp-glass"
  | "wp-sakura"
  | "wp-mint"
  | "wp-alpine";
export type AccentId = "teal" | "emerald" | "amber" | "rose" | "violet";

export const WALLPAPERS: { id: WallpaperId; label: string; css: string; swatch: string }[] = [
  {
    id: "aurora",
    label: "Aurora",
    swatch: "linear-gradient(135deg,#ccfbf1,#d1fae5,#fef3c7)",
    css: "radial-gradient(1200px 700px at 18% 12%, rgba(20,184,166,0.20), transparent 60%), radial-gradient(1000px 600px at 82% 28%, rgba(16,185,129,0.18), transparent 55%), radial-gradient(900px 700px at 60% 92%, rgba(245,158,11,0.12), transparent 60%), linear-gradient(160deg,#f8fffd 0%,#f0fdf9 45%,#f7fdf5 100%)",
  },
  {
    id: "mint",
    label: "Mint",
    swatch: "linear-gradient(135deg,#d1fae5,#ecfdf5)",
    css: "radial-gradient(1000px 640px at 30% 20%, rgba(16,185,129,0.16), transparent 60%), linear-gradient(165deg,#f4fdf9 0%,#ecfdf5 50%,#f0fdfa 100%)",
  },
  {
    id: "peach",
    label: "Peach",
    swatch: "linear-gradient(135deg,#ffedd5,#ffe4e6)",
    css: "radial-gradient(1100px 640px at 72% 18%, rgba(251,146,60,0.16), transparent 60%), radial-gradient(900px 600px at 20% 85%, rgba(244,63,94,0.10), transparent 55%), linear-gradient(160deg,#fffaf3 0%,#fff5eb 55%,#fff1f2 100%)",
  },
  {
    id: "graphite",
    label: "Graphite",
    swatch: "linear-gradient(135deg,#e7e5e4,#f5f5f4)",
    css: "radial-gradient(1200px 700px at 50% 10%, rgba(87,83,78,0.10), transparent 60%), linear-gradient(165deg,#fafaf9 0%,#f5f5f4 60%,#eeefec 100%)",
  },
  {
    id: "wp-aurora",
    label: "Aurora Peak",
    swatch: "url(/wallpapers/aurora-peak.png) center/cover",
    css: "url(/wallpapers/aurora-peak.png) center/cover no-repeat, linear-gradient(160deg,#f0fdf9,#f7fdf5)",
  },
  {
    id: "wp-dunes",
    label: "Dawn Dunes",
    swatch: "url(/wallpapers/dawn-dunes.png) center/cover",
    css: "url(/wallpapers/dawn-dunes.png) center/cover no-repeat, linear-gradient(160deg,#fff7ed,#ffedd5)",
  },
  {
    id: "wp-glass",
    label: "Liquid Glass",
    swatch: "url(/wallpapers/liquid-glass.png) center/cover",
    css: "url(/wallpapers/liquid-glass.png) center/cover no-repeat, linear-gradient(160deg,#ecfdf5,#f0fdfa)",
  },
  {
    id: "wp-sakura",
    label: "Sakura",
    swatch: "url(/wallpapers/sakura.png) center/cover",
    css: "url(/wallpapers/sakura.png) center/cover no-repeat, linear-gradient(160deg,#fff1f2,#fdf2f8)",
  },
  {
    id: "wp-mint",
    label: "Mint Terrazzo",
    swatch: "url(/wallpapers/mint-terra.png) center/cover",
    css: "url(/wallpapers/mint-terra.png) center/cover no-repeat, linear-gradient(160deg,#ecfdf5,#f0fdfa)",
  },
  {
    id: "wp-alpine",
    label: "Alpine Glow",
    swatch: "url(/wallpapers/alpine-glow.png) center/cover",
    css: "url(/wallpapers/alpine-glow.png) center/cover no-repeat, linear-gradient(160deg,#fff7ed,#ffe4e6)",
  },
];

export const ACCENTS: { id: AccentId; label: string; hex: string; hex2: string }[] = [
  { id: "teal", label: "Teal", hex: "#14b8a6", hex2: "#10b981" },
  { id: "emerald", label: "Emerald", hex: "#10b981", hex2: "#34d399" },
  { id: "amber", label: "Amber", hex: "#f59e0b", hex2: "#fb923c" },
  { id: "rose", label: "Rose", hex: "#f43f5e", hex2: "#fb7185" },
  { id: "violet", label: "Violet", hex: "#8b5cf6", hex2: "#a78bfa" },
];

export function accentOf(id: AccentId): { hex: string; hex2: string } {
  return ACCENTS.find((a) => a.id === id) ?? ACCENTS[0];
}

// ---------------- chat ----------------

export interface ChatMessage {
  id: string;
  fromId: string; // socket id of sender
  from: string; // display name
  text: string;
  at: number; // epoch ms
}

export const CHAT_CAP = 200;
export const STROKE_POINTS_CAP = 400;

// ---------------- windows & per-app payloads ----------------

export interface Stroke {
  id: string;
  color: string;
  width: number;
  tool: "pen" | "eraser";
  points: number[]; // flattened [x0,y0,x1,y1,...] normalized 0..1
}

export interface WindowState {
  id: string;
  app: AppKind;
  title: string;
  x: number;
  y: number;
  w: number;
  h: number;
  z: number;
  minimized: boolean;
  maximized: boolean;
  workspace?: number; // 0..WORKSPACES-1 (missing → 0)
  payload: Record<string, unknown>;
}

export interface DesktopState {
  v: 1;
  machine: MachineSpecs;
  windows: WindowState[];
  fs: FSMap;
  wallpaper: WallpaperId;
  accent: AccentId;
  chat: ChatMessage[];
  booted: boolean;
  workspace: number; // active virtual desktop (0..WORKSPACES-1)
}

// ---------------- ops (the sync primitives) ----------------

export type Op =
  | { t: "win:open"; win: WindowState }
  | { t: "win:close"; id: string }
  | { t: "win:geom"; id: string; x: number; y: number; w: number; h: number }
  | { t: "win:z"; id: string; z: number }
  | { t: "win:min"; id: string; minimized: boolean }
  | { t: "win:max"; id: string; maximized: boolean }
  | { t: "win:title"; id: string; title: string }
  | { t: "win:ws"; id: string; ws: number } // move window to another workspace
  | { t: "app:patch"; id: string; patch: Record<string, unknown> } // shallow merge into payload
  | { t: "app:set"; id: string; payload: Record<string, unknown> } // replace payload
  | { t: "fs:upsert"; node: FSNode }
  | { t: "fs:delete"; id: string } // node + descendants
  | { t: "chat"; msg: ChatMessage }
  | { t: "sys"; patch: SysPatch };

export interface SysPatch {
  wallpaper?: WallpaperId;
  accent?: AccentId;
  booted?: boolean;
  ramMB?: RamMB; // only applied pre-boot (tier chosen at creation)
  workspace?: number; // switch the active virtual desktop
}

// ---------------- construction & migration ----------------

export function hostnameFor(code: string): string {
  const digits = code.replace(/\D/g, "").slice(-4).padStart(4, "0");
  return `glass-${digits}`;
}

export function defaultMachine(code: string, ramMB: RamMB): MachineSpecs {
  return {
    hostname: hostnameFor(code),
    node: NODE,
    ramMB,
    diskGB: DISK_GB,
    cores: CORES,
    createdAt: Date.now(),
  };
}

export function freshDesktop(opts: { code: string; ramMB: RamMB }): DesktopState {
  return {
    v: 1,
    machine: defaultMachine(opts.code, opts.ramMB),
    windows: [],
    fs: seedFS(),
    wallpaper: "aurora",
    accent: "teal",
    chat: [],
    booted: false,
    workspace: 0,
  };
}

// Migrate older/foreign snapshots to current shape (defensive).
export function ensureMachine(d: DesktopState | null, opts: { code: string }): DesktopState {
  if (!d) return freshDesktop({ code: opts.code, ramMB: 2048 });
  if (!d.machine) d.machine = defaultMachine(opts.code, 2048);
  if (!d.machine.hostname) d.machine.hostname = hostnameFor(opts.code);
  if (!d.machine.node) d.machine.node = NODE;
  if (!d.machine.diskGB) d.machine.diskGB = DISK_GB;
  if (!d.machine.cores) d.machine.cores = CORES;
  if (!d.machine.createdAt) d.machine.createdAt = Date.now();
  if (!d.windows) d.windows = [];
  if (!d.fs) d.fs = seedFS();
  // old snapshots: root-level Welcome/Notes + no Desktop folder. We add the
  // Desktop folder (icon positions ride along); existing files stay where
  // they are — we never move user files during migration.
  if (!d.fs[DESKTOP_NODE_ID]) {
    d.fs = {
      ...d.fs,
      [DESKTOP_NODE_ID]: {
        id: DESKTOP_NODE_ID,
        name: "Desktop",
        kind: "folder",
        parent: null,
        content: iconPositionsContent({}),
        updatedAt: Date.now(),
      },
    };
  }
  if (!d.wallpaper) d.wallpaper = "aurora";
  if (!d.accent) d.accent = "teal";
  if (!d.chat) d.chat = [];
  if (typeof d.booted !== "boolean") d.booted = false;
  if (typeof d.workspace !== "number" || d.workspace < 0 || d.workspace >= WORKSPACES) {
    d.workspace = 0;
  }
  d.windows = d.windows.map((w) =>
    typeof w.workspace === "number" && w.workspace >= 0 && w.workspace < WORKSPACES
      ? w
      : { ...w, workspace: 0 },
  );
  return d;
}

// ---------------- telemetry helpers ----------------

export function ramUsage(d: DesktopState): { used: number; total: number; pct: number } {
  const appMem = d.windows.reduce((a, w) => a + (APP_RAM[w.app] ?? 20), 0);
  const used = BASE_RAM_MB + appMem;
  const total = d.machine.ramMB;
  return { used, total, pct: Math.min(100, Math.round((used / total) * 100)) };
}

export function pidOf(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return 1000 + (h % 9000);
}

export interface ProcRow {
  pid: number;
  name: string;
  mem: number;
  sys: boolean;
  winId?: string;
}

export function processList(d: DesktopState): ProcRow[] {
  const sys: ProcRow[] = SYSTEM_PROCS.map((p) => ({ ...p, sys: true }));
  const apps: ProcRow[] = d.windows.map((w) => ({
    pid: pidOf(w.id),
    name: `gd-${w.app}`,
    mem: APP_RAM[w.app] ?? 20,
    sys: false,
    winId: w.id,
  }));
  return [...sys, ...apps];
}

export function fmtUptime(ms: number): string {
  if (ms < 0) ms = 0;
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}h ${m.toString().padStart(2, "0")}m`;
  if (m > 0) return `${m}m ${sec.toString().padStart(2, "0")}s`;
  return `${sec}s`;
}

export function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

// ---------------- pure op reducer (single source of truth) ----------------

function deleteWithDescendants(fs: FSMap, id: string): FSMap {
  const next = { ...fs };
  const stack = [id];
  while (stack.length) {
    const cur = stack.pop()!;
    for (const n of Object.values(next)) {
      if (n.parent === cur) stack.push(n.id);
    }
    delete next[cur];
  }
  return next;
}

export function applyOp(d: DesktopState, op: Op): DesktopState {
  switch (op.t) {
    case "win:open": {
      if (d.windows.some((w) => w.id === op.win.id)) return d;
      const win =
        typeof op.win.workspace === "number" && op.win.workspace >= 0 && op.win.workspace < WORKSPACES
          ? op.win
          : { ...op.win, workspace: 0 };
      return { ...d, windows: [...d.windows, win] };
    }
    case "win:close":
      return { ...d, windows: d.windows.filter((w) => w.id !== op.id) };
    case "win:geom":
      return {
        ...d,
        windows: d.windows.map((w) =>
          w.id === op.id ? { ...w, x: op.x, y: op.y, w: op.w, h: op.h } : w,
        ),
      };
    case "win:z":
      return {
        ...d,
        windows: d.windows.map((w) => (w.id === op.id ? { ...w, z: op.z } : w)),
      };
    case "win:min":
      return {
        ...d,
        windows: d.windows.map((w) => (w.id === op.id ? { ...w, minimized: op.minimized } : w)),
      };
    case "win:max":
      return {
        ...d,
        windows: d.windows.map((w) => (w.id === op.id ? { ...w, maximized: op.maximized } : w)),
      };
    case "win:title":
      return {
        ...d,
        windows: d.windows.map((w) => (w.id === op.id ? { ...w, title: op.title } : w)),
      };
    case "win:ws":
      return {
        ...d,
        windows: d.windows.map((w) =>
          w.id === op.id ? { ...w, workspace: Math.max(0, Math.min(WORKSPACES - 1, op.ws)) } : w,
        ),
      };
    case "app:patch":
      return {
        ...d,
        windows: d.windows.map((w) =>
          w.id === op.id ? { ...w, payload: { ...w.payload, ...op.patch } } : w,
        ),
      };
    case "app:set":
      return {
        ...d,
        windows: d.windows.map((w) => (w.id === op.id ? { ...w, payload: op.payload } : w)),
      };
    case "fs:upsert":
      return { ...d, fs: { ...d.fs, [op.node.id]: op.node } };
    case "fs:delete":
      return { ...d, fs: deleteWithDescendants(d.fs, op.id) };
    case "chat": {
      if (d.chat.some((m) => m.id === op.msg.id)) return d;
      const chat = [...d.chat, op.msg].slice(-CHAT_CAP);
      return { ...d, chat };
    }
    case "sys": {
      const next: DesktopState = {
        ...d,
        wallpaper: op.patch.wallpaper ?? d.wallpaper,
        accent: op.patch.accent ?? d.accent,
        booted: op.patch.booted ?? d.booted,
        workspace:
          typeof op.patch.workspace === "number" && op.patch.workspace >= 0 && op.patch.workspace < WORKSPACES
            ? op.patch.workspace
            : d.workspace,
      };
      if (op.patch.ramMB && !d.booted) {
        next.machine = { ...d.machine, ramMB: op.patch.ramMB };
      }
      return next;
    }
    default:
      return d;
  }
}
