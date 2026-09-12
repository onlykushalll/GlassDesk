"use client";

// ============================================================
// GlassDesk — Terminal 2.0 (a real, Linux-flexible shell).
// Payload: { lines: string[], cwd: string, history: string[] }
// (cwd === "/" means the volume root "~"). SHARED terminal:
// both seats type into the same window; the input box is
// local-only until Enter, which commits the echo line + output
// via app:patch so the peer sees the same transcript. cwd rides
// the SAME app:patch, so both shells share one working
// directory. Filesystem mutations are dispatched BEFORE the
// lines patch so both seats converge on identical state.
//
// Styled output protocol (payload stays string[] for compat):
// a line starting with \u0001 is "tagged" — one or more segments
// joined by \u0002, each segment = <style-char>\u0003<text>.
// Styles: n stone-200 · r rose (error) · a amber (folder/sass) ·
// g emerald (executable) · d dim stone-400. renderLine decodes
// them — both seats run the same code, so colors match.
// ============================================================

import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import {
  fmtBytes,
  fmtUptime,
  fsBytes,
  fsChildren,
  fsFindByPath,
  fsPathOf,
  processList,
  ramUsage,
  uid,
  type AppKind,
  type DesktopState,
  type FSMap,
  type FSNode,
  type Op,
  type WindowState,
} from "@/lib/vpc/types";
import { parseYouTubeId } from "@/lib/vpc/youtube";
import { openApp } from "@/components/vpc/desktop/Dock";
import { useGlassDesk } from "@/lib/vpc/store";
import { pushToast, type ToastKind } from "@/lib/vpc/toast";

// ---------------- app launch targets for `open` ----------------

const OPEN_TARGETS: Record<string, { app: AppKind; label: string }> = {
  files: { app: "files", label: "Files" },
  textedit: { app: "textedit", label: "TextEdit" },
  terminal: { app: "terminal", label: "Terminal" },
  whiteboard: { app: "whiteboard", label: "Whiteboard" },
  browser: { app: "browser", label: "Nova" },
  nova: { app: "browser", label: "Nova" },
  media: { app: "media", label: "Media" },
  calculator: { app: "calculator", label: "Calculator" },
  settings: { app: "settings", label: "Settings" },
  taskmgr: { app: "taskmgr", label: "Task Manager" },
};

const HELP_LINES: string[] = [
  "commands:",
  "  help              show this list",
  "  ls [path]         list folder contents",
  "  cd <path>         change folder (no argument goes to /)",
  "  cat <file>        print a file",
  "  touch <name>      create an empty file",
  "  mkdir <name>      create a folder",
  "  rm <name>         delete a file or folder",
  "  echo <text>       print text",
  "  open <app|file>   launch an app or open a file",
  "  history           show command history",
  "  free              memory usage",
  "  ps                running processes",
  "  uptime            how long the PC has been up",
  "  host              what this machine actually is",
  "  neofetch          system summary",
  "  yt <link|id>      open a YouTube watch-party",
  "  clear             clear the screen",
  "  pwd               print working directory",
  "  tree              folder tree, 2 levels",
  "  whoami            who's at the keyboard",
  "  date              current date & time",
  "  df                disk usage",
];

/** Everything Tab-completion knows about (sorted). */
const COMMANDS: string[] = [
  "cat",
  "cd",
  "clear",
  "date",
  "df",
  "echo",
  "free",
  "help",
  "history",
  "host",
  "ls",
  "mkdir",
  "nano",
  "neofetch",
  "open",
  "ps",
  "pwd",
  "rm",
  "sudo",
  "touch",
  "tree",
  "uptime",
  "vim",
  "whoami",
  "yt",
];

const NEOFETCH_ART: string[] = [
  "  .------------------. ",
  "  |  .------------.  | ",
  "  |  |            |  | ",
  "  |  |  ~ glass ~ |  | ",
  "  |  |            |  | ",
  "  |  '------------'  | ",
  "  '------------------' ",
  "       GlassDesk       ",
];

// ---------------- styled output lines ----------------

const TAG = "\u0001"; // marks a styled line
const SEP = "\u0002"; // joins segments
const UNIT = "\u0003"; // separates style char from text

type SegStyle = "n" | "r" | "a" | "g" | "d";

const SEG_CLASSES: Record<SegStyle, string> = {
  n: "text-stone-200",
  r: "text-rose-400",
  a: "text-amber-400",
  g: "text-emerald-400",
  d: "text-stone-400",
};

function st(style: SegStyle, text: string): string {
  return TAG + style + UNIT + text;
}

function stSegs(segs: [SegStyle, string][]): string {
  return TAG + segs.map(([s, t]) => s + UNIT + t).join(SEP);
}

function segClass(styleChar: string): string {
  return SEG_CLASSES[styleChar as SegStyle] ?? SEG_CLASSES.n;
}

// ---------------- path helpers ----------------

function cwdToId(cwd: string): string | null {
  return cwd === "/" ? null : cwd;
}

/**
 * Resolve a shell-style path against cwd. Returns null when the path does not
 * exist, or { node: null } for the volume root. Understands ~ (= /), /, ., ..
 * and multi-segment relative + absolute paths (fsChildren-based, like
 * fsResolve, but distinguishes "reached the root" from "not found").
 */
function resolvePath(fs: FSMap, cwd: string, path: string): { node: FSNode | null } | null {
  let p = path;
  if (p === "~") p = "/";
  else if (p.startsWith("~/")) p = "/" + p.slice(2);
  if (p === "/") return { node: null };
  const absolute = p.startsWith("/");
  const parts = p.split("/").filter((x) => x.length > 0 && x !== ".");
  let nodeId: string | null = absolute ? null : cwdToId(cwd);
  for (const part of parts) {
    if (part === "..") {
      nodeId = nodeId ? (fs[nodeId]?.parent ?? null) : null;
      continue;
    }
    const child = fsChildren(fs, nodeId).find((n) => n.name === part);
    if (!child) return null;
    nodeId = child.id;
  }
  if (nodeId === null) return { node: null };
  return { node: fs[nodeId] ?? null };
}

/** Split `dir/name` into the target folder id + the bare name. */
function targetDir(
  fs: FSMap,
  cwd: string,
  arg: string,
): { dir: string | null; name: string; error: string | null } {
  const slash = arg.lastIndexOf("/");
  const name = slash === -1 ? arg : arg.slice(slash + 1);
  if (!name) return { dir: null, name, error: `no such directory: ${arg}` };
  const dirPart = slash === -1 ? "" : arg.slice(0, slash);
  if (dirPart === "" || dirPart === ".") return { dir: cwdToId(cwd), name, error: null };
  if (dirPart === "/" || dirPart === "~" || dirPart === "~/") return { dir: null, name, error: null };
  const resolved = resolvePath(fs, cwd, dirPart);
  if (!resolved || (resolved.node !== null && resolved.node.kind !== "folder")) {
    return { dir: null, name, error: `no such directory: ${dirPart}` };
  }
  return { dir: resolved.node ? resolved.node.id : null, name, error: null };
}

/** "~"-abbreviated prompt path from a cwd payload value. */
function promptFor(fs: FSMap, cwd: string, hostname: string): string {
  const path = fsPathOf(fs, cwdToId(cwd));
  return `guest@${hostname}:${path === "/" ? "~" : `~${path}`}$`;
}

/** Executable-looking files get the emerald "binary" tint, like a real ls. */
const EXEC_RE = /\.(sh|exe|command|bin|run|app)$/i;

function lsStyleOf(n: FSNode): SegStyle {
  if (n.kind === "folder") return "a";
  if (EXEC_RE.test(n.name)) return "g";
  return "n";
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "Jan 15 14:03" — stable across seats (no locale drift). */
function fmtStamp(ms: number): string {
  const d = new Date(ms);
  const hh = d.getHours().toString().padStart(2, "0");
  const mm = d.getMinutes().toString().padStart(2, "0");
  return `${MONTHS[d.getMonth()]} ${d.getDate().toString().padStart(2, "0")} ${hh}:${mm}`;
}

function fmtGB(n: number): string {
  return n >= 1024 ** 3 ? `${Math.round(n / 1024 ** 3)} GB` : fmtBytes(n);
}

function strArr(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

function commonPrefix(names: string[]): string {
  if (names.length === 0) return "";
  let prefix = names[0];
  for (const n of names) {
    let i = 0;
    while (i < prefix.length && i < n.length && prefix[i] === n[i]) i++;
    prefix = prefix.slice(0, i);
  }
  return prefix;
}

// ---------------- command engine ----------------

interface ExecCtx {
  fs: FSMap;
  cwd: string;
  desktop: DesktopState;
  peerNames: string[];
  code: string;
  user: string; // seat display name (whoami)
  history: string[];
  open: (app: AppKind, payload?: Record<string, unknown>) => void;
}

interface ExecToast {
  title: string;
  body?: string;
  kind: ToastKind;
}

interface ExecResult {
  out: string[];
  cwd: string;
  ops: Op[];
  toasts: ExecToast[];
}

function exec(raw: string, ctx: ExecCtx): ExecResult {
  const { fs, desktop, history, open } = ctx;
  const machine = desktop.machine;
  const ram = ramUsage(desktop);
  const out: string[] = [];
  const ops: Op[] = [];
  const toasts: ExecToast[] = [];
  let cwd = ctx.cwd === "/" || fs[ctx.cwd]?.kind === "folder" ? ctx.cwd : "/";

  const listLong = (dirId: string | null) => {
    const kids = fsChildren(fs, dirId);
    if (kids.length === 0) {
      out.push(st("d", "(empty)"));
      return;
    }
    for (const k of kids) {
      const kind = k.kind === "folder" ? "dir" : "file";
      const size = k.kind === "folder" ? "-" : fmtBytes(k.content.length);
      const name = k.kind === "folder" ? `${k.name}/` : k.name;
      out.push(stSegs([[lsStyleOf(k), `${kind.padEnd(5)}${size.padStart(9)}  ${fmtStamp(k.updatedAt)}  ${name}`]]));
    }
  };

  const listShort = (dirId: string | null) => {
    const kids = fsChildren(fs, dirId);
    if (kids.length === 0) {
      out.push(st("d", "(empty)"));
      return;
    }
    out.push(stSegs(kids.map((k) => [lsStyleOf(k), k.kind === "folder" ? `${k.name}/` : k.name] as [SegStyle, string])));
  };

  const parts = raw.trim().split(/\s+/).filter((p) => p.length > 0);
  const cmd = parts[0] ?? "";
  const args = parts.slice(1);

  switch (cmd) {
    case "":
      break;

    case "help":
      out.push(...HELP_LINES);
      out.push(st("d", "tab completes commands & paths · ↑/↓ walks history · ~ = /"));
      break;

    case "ls": {
      const flags = args.filter((a) => a.startsWith("-") && a.length > 1);
      const long = flags.some((f) => f.slice(1).includes("l"));
      const rest = args.filter((a) => !(a.startsWith("-") && a.length > 1));
      const arg = rest[0];
      if (!arg || arg === "." || arg === "~") {
        if (long) listLong(cwdToId(cwd));
        else listShort(cwdToId(cwd));
      } else {
        const resolved = resolvePath(fs, cwd, arg);
        if (!resolved) out.push(st("r", `ls: no such directory: ${arg}`));
        else if (resolved.node === null) {
          if (long) listLong(null);
          else listShort(null);
        } else if (resolved.node.kind !== "folder") out.push(st("r", `ls: not a directory: ${arg}`));
        else if (long) listLong(resolved.node.id);
        else listShort(resolved.node.id);
      }
      break;
    }

    case "cd": {
      const arg = args[0];
      if (!arg || arg === "~") {
        cwd = "/";
        break;
      }
      const resolved = resolvePath(fs, cwd, arg);
      if (!resolved || (resolved.node !== null && resolved.node.kind !== "folder")) {
        out.push(st("r", `cd: no such directory: ${arg}`));
      } else {
        cwd = resolved.node ? resolved.node.id : "/";
      }
      break;
    }

    case "pwd":
      out.push(fsPathOf(fs, cwdToId(cwd)));
      break;

    case "cat": {
      const arg = args[0];
      if (!arg) {
        out.push(st("d", "usage: cat <file>"));
        break;
      }
      const resolved = resolvePath(fs, cwd, arg);
      if (!resolved) out.push(st("r", `cat: ${arg}: no such file`));
      else if (resolved.node === null || resolved.node.kind === "folder")
        out.push(st("r", `cat: ${arg}: is a directory`));
      else {
        const content = resolved.node.content;
        if (content.length === 0) out.push("");
        else out.push(...content.split("\n"));
      }
      break;
    }

    case "echo": {
      // `echo <text>` · `echo <text> > <file>` (overwrite) · `>> <file>` (append)
      let redirIdx = -1;
      let appendMode = false;
      for (let i = 0; i < args.length; i++) {
        if (args[i] === ">" || args[i] === ">>") {
          redirIdx = i;
          appendMode = args[i] === ">>";
          break;
        }
      }
      if (redirIdx === -1) {
        out.push(args.join(" "));
        break;
      }
      const text = args.slice(0, redirIdx).join(" ");
      const fileArg = args[redirIdx + 1];
      if (!fileArg) {
        out.push(st("d", "usage: echo <text> > <file>"));
        break;
      }
      const target = targetDir(fs, cwd, fileArg);
      if (target.error) {
        out.push(st("r", `echo: ${target.error}`));
        break;
      }
      const existing = fsChildren(fs, target.dir).find((n) => n.name === target.name);
      if (existing && existing.kind === "folder") {
        out.push(st("r", `echo: ${fileArg}: is a directory`));
        break;
      }
      const content = existing
        ? appendMode
          ? existing.content.length === 0
            ? text
            : existing.content + (existing.content.endsWith("\n") ? "" : "\n") + text
          : text
        : text;
      ops.push({
        t: "fs:upsert",
        node: existing
          ? { ...existing, content, updatedAt: Date.now() }
          : {
              id: uid(),
              name: target.name,
              kind: "file",
              parent: target.dir,
              content,
              updatedAt: Date.now(),
            },
      });
      break;
    }

    case "mkdir": {
      const arg = args[0];
      if (!arg) {
        out.push(st("d", "usage: mkdir <name>"));
        break;
      }
      const target = targetDir(fs, cwd, arg);
      if (target.error) {
        out.push(st("r", `mkdir: ${target.error}`));
        break;
      }
      const exists = fsChildren(fs, target.dir).some((n) => n.name === target.name);
      if (exists) out.push(st("r", `mkdir: folder exists: ${target.name}`));
      else
        ops.push({
          t: "fs:upsert",
          node: {
            id: uid(),
            name: target.name,
            kind: "folder",
            parent: target.dir,
            content: "",
            updatedAt: Date.now(),
          },
        });
      break;
    }

    case "touch": {
      const arg = args[0];
      if (!arg) {
        out.push(st("d", "usage: touch <name>"));
        break;
      }
      const target = targetDir(fs, cwd, arg);
      if (target.error) {
        out.push(st("r", `touch: ${target.error}`));
        break;
      }
      const existing = fsChildren(fs, target.dir).find((n) => n.name === target.name);
      if (existing) ops.push({ t: "fs:upsert", node: { ...existing, updatedAt: Date.now() } });
      else
        ops.push({
          t: "fs:upsert",
          node: {
            id: uid(),
            name: target.name,
            kind: "file",
            parent: target.dir,
            content: "",
            updatedAt: Date.now(),
          },
        });
      break;
    }

    case "rm": {
      // rm [-r] <name> — files always; folders need -r; the volume
      // root (~) is NEVER removable: it holds the whole PC.
      let hasR = false;
      const rest: string[] = [];
      for (const a of args) {
        if (a.startsWith("-") && a.length > 1) {
          if (a.slice(1).includes("r")) hasR = true;
        } else rest.push(a);
      }
      const arg = rest[0];
      if (!arg) {
        out.push(st("d", "usage: rm [-r] <name>"));
        break;
      }
      const resolved = resolvePath(fs, cwd, arg);
      if (!resolved) {
        out.push(st("r", `rm: no such file or folder: ${arg}`));
        break;
      }
      if (resolved.node === null) {
        out.push(
          st(
            "r",
            "rm: nice try — '/' holds the entire PC: every file, every window, this very terminal. It stays.",
          ),
        );
        break;
      }
      const node = resolved.node;
      if (node.kind === "folder" && !hasR) {
        out.push(st("r", `rm: ${arg}: is a directory`));
        break;
      }
      ops.push({ t: "fs:delete", id: node.id });
      toasts.push({ title: `Deleted ${node.name}`, body: "rm is forever — there is no undo", kind: "danger" });
      break;
    }

    case "tree": {
      let dirId = cwdToId(cwd);
      const arg = args[0];
      if (arg && arg !== "." && arg !== "~") {
        const resolved = resolvePath(fs, cwd, arg);
        if (!resolved || (resolved.node !== null && resolved.node.kind !== "folder")) {
          out.push(st("r", `tree: no such directory: ${arg}`));
          break;
        }
        dirId = resolved.node ? resolved.node.id : null;
      }
      out.push(st("d", "."));
      let entries = 0;
      let folders = 0;
      let files = 0;
      const kids = fsChildren(fs, dirId);
      kids.forEach((k, i) => {
        entries++;
        if (k.kind === "folder") folders++;
        else files++;
        const last = i === kids.length - 1;
        const branch = last ? "└── " : "├── ";
        out.push(stSegs([[lsStyleOf(k), `${branch}${k.name}${k.kind === "folder" ? "/" : ""}`]]));
        if (k.kind === "folder") {
          const inner = last ? "    " : "│   ";
          const grand = fsChildren(fs, k.id);
          grand.forEach((g, j) => {
            entries++;
            if (g.kind === "folder") folders++;
            else files++;
            const gBranch = j === grand.length - 1 ? "└── " : "├── ";
            out.push(stSegs([[lsStyleOf(g), `${inner}${gBranch}${g.name}${g.kind === "folder" ? "/" : ""}`]]));
          });
        }
      });
      const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
      out.push(st("d", `${plural(entries, "entry")} · ${plural(folders, "folder")} · ${plural(files, "file")}`));
      break;
    }

    case "whoami":
      out.push(ctx.user || "guest");
      break;

    case "date":
      out.push(new Date().toLocaleString());
      break;

    case "df": {
      const total = machine.diskGB * 1024 ** 3;
      const used = fsBytes(fs);
      const avail = Math.max(0, total - used);
      const pct = used === 0 ? 0 : Math.max(1, Math.ceil((used / total) * 100));
      out.push(
        `${"Filesystem".padEnd(14)}${"Size".padStart(6)}${"Used".padStart(8)}${"Avail".padStart(8)}${"Use%".padStart(5)}  Mounted on`,
        `${"/dev/gdhd0".padEnd(14)}${`${machine.diskGB} GB`.padStart(6)}${fmtBytes(used).padStart(8)}${fmtGB(avail).padStart(8)}${`${pct}%`.padStart(5)}  /`,
      );
      break;
    }

    case "open": {
      const arg = args[0];
      if (!arg) {
        out.push("usage: open <app|file>");
        break;
      }
      const target = OPEN_TARGETS[arg.toLowerCase()];
      if (target) {
        open(target.app);
        out.push(`opening ${target.label}…`);
        break;
      }
      const node = fsFindByPath(fs, cwd, arg);
      if (!node) {
        out.push(`open: unknown app or file: ${arg}`);
        break;
      }
      if (node.kind === "folder") {
        out.push(`open: ${node.name} is a directory`);
        break;
      }
      open("textedit", { fileId: node.id, value: node.content });
      out.push(`opening ${node.name}…`);
      break;
    }

    case "history":
      out.push(...history.map((h, i) => `${String(i + 1).padStart(3)}  ${h}`));
      break;

    case "free":
      out.push(
        `Mem: ${machine.ramMB} ${ram.used} ${ram.total - ram.used} · reserved on node ${machine.node}`,
      );
      break;

    case "ps": {
      out.push(`${"PID".padStart(5)}  ${"MEM".padStart(4)}  NAME`);
      for (const proc of processList(desktop)) {
        out.push(`${String(proc.pid).padStart(5)}  ${String(proc.mem).padStart(4)}  ${proc.name}`);
      }
      break;
    }

    case "uptime":
      out.push(
        `up ${fmtUptime(Date.now() - machine.createdAt)} · ${machine.cores} vCores · node ${machine.node}`,
      );
      break;

    case "host":
      out.push(
        "This PC is software — a machine-shaped slice of the GlassDesk",
        "session service's memory. It was created when you made session",
        `${ctx.code}, and lives on node ${machine.node}.`,
        `RAM: ${machine.ramMB} MB reserved · ${machine.cores} vCores · disk is a ${machine.diskGB} GB SQLite`,
        "volume (GlassDesk HD) snapshotted every ~1.5 s by snapd.",
        "Both seats drive the same machine — there is no 'real' computer here.",
      );
      break;

    case "neofetch": {
      const info: string[] = [
        `host: ${machine.hostname}`,
        `node: ${machine.node}`,
        `vcores: ${machine.cores}`,
        `ram: ${ram.used} MB / ${machine.ramMB} MB`,
        `disk: ${fmtBytes(fsBytes(fs))} / ${machine.diskGB} GB`,
        `uptime: ${fmtUptime(Date.now() - machine.createdAt)}`,
        `seats: ${Math.min(2, ctx.peerNames.length)}/2 · ${ctx.peerNames.join(", ")}`,
        `accent: ${desktop.accent}`,
      ];
      for (let i = 0; i < NEOFETCH_ART.length; i++) {
        out.push(`${NEOFETCH_ART[i].padEnd(24)}${info[i] ?? ""}`.trimEnd());
      }
      break;
    }

    case "yt": {
      const id = args[0] ? parseYouTubeId(args[0]) : null;
      if (!id) {
        out.push("yt: give me a YouTube link or video id");
      } else {
        open("browser", { page: `yt:${id}` });
        out.push("opening YouTube theater for everyone…");
      }
      break;
    }

    case "sudo":
      out.push(st("a", "guest is not in the sudoers file. This incident will be reported."));
      break;

    case "vim":
    case "nano":
      out.push(st("a", "opening editors is so 2000s — try TextEdit 🙂"));
      break;

    default:
      out.push(st("r", `command not found: ${cmd} — try \`help\``));
      break;
  }

  return { out, cwd, ops, toasts };
}

// ---------------- tab completion ----------------

function tabComplete(raw: string, fs: FSMap, cwd: string): { next: string | null; candidates: [SegStyle, string][] } {
  if (raw.length === 0) return { next: null, candidates: [] };
  const lastSpace = raw.lastIndexOf(" ");
  const head = lastSpace === -1 ? "" : raw.slice(0, lastSpace + 1);
  const token = lastSpace === -1 ? raw : raw.slice(lastSpace + 1);
  if (token === "") return { next: null, candidates: [] };

  // first word → complete a command name
  if (lastSpace === -1) {
    const cands = COMMANDS.filter((c) => c.startsWith(token));
    if (cands.length === 0) return { next: null, candidates: [] };
    if (cands.length === 1) return { next: `${head}${cands[0]} `, candidates: [] };
    const common = commonPrefix(cands);
    if (common.length > token.length) return { next: head + common, candidates: [] };
    return { next: null, candidates: cands.map((c) => ["n", c] as [SegStyle, string]) };
  }

  // later word → complete a path segment against its base folder
  const slash = token.lastIndexOf("/");
  const dirPart = slash === -1 ? "" : token.slice(0, slash + 1);
  const seg = slash === -1 ? token : token.slice(slash + 1);
  const resolved = dirPart === "" ? resolvePath(fs, cwd, ".") : resolvePath(fs, cwd, dirPart);
  if (!resolved || (resolved.node !== null && resolved.node.kind !== "folder")) {
    return { next: null, candidates: [] };
  }
  const baseId = resolved.node ? resolved.node.id : null;
  const matches = fsChildren(fs, baseId).filter((k) => k.name.startsWith(seg));
  if (matches.length === 0) return { next: null, candidates: [] };
  if (matches.length === 1) {
    const m = matches[0];
    return { next: `${head}${dirPart}${m.name}${m.kind === "folder" ? "/" : " "}`, candidates: [] };
  }
  const common = commonPrefix(matches.map((m) => m.name));
  if (common.length > seg.length) return { next: head + dirPart + common, candidates: [] };
  return {
    next: null,
    candidates: matches.map((m) => [lsStyleOf(m), m.kind === "folder" ? `${m.name}/` : m.name] as [SegStyle, string]),
  };
}

// ---------------- component ----------------

/** Render a stored line; tagged lines decode styles, echoed prompts get the
 *  accent color, empties become nbsp. */
function renderLine(line: string, hostname: string): ReactNode {
  if (line.startsWith(TAG)) {
    const segs = line.slice(TAG.length).split(SEP);
    if (segs.length === 1) {
      const text = segs[0].slice(2);
      if (text.length === 0) return "\u00A0";
      return <span className={segClass(segs[0].charAt(0))}>{text}</span>;
    }
    return segs.map((seg, i) => (
      <span key={i} className={segClass(seg.charAt(0))}>
        {i > 0 ? "  " : undefined}
        {seg.slice(2)}
      </span>
    ));
  }
  const prefix = `guest@${hostname}:`;
  if (line.startsWith(prefix)) {
    const rest = line.slice(prefix.length);
    const dollar = rest.indexOf("$");
    if (dollar !== -1) {
      return (
        <>
          <span style={{ color: "var(--gd-accent)" }}>
            {prefix}
            {rest.slice(0, dollar)}$
          </span>
          {rest.slice(dollar + 1) || "\u00A0"}
        </>
      );
    }
  }
  return line.length === 0 ? "\u00A0" : line;
}

export default function TerminalApp({ win }: { win: WindowState }) {
  // the LIVE window — lines/cwd/history arrive fresh from the store
  const liveWin = useGlassDesk((s) => s.state?.windows.find((w) => w.id === win.id));
  const fs = useGlassDesk((s) => s.state?.fs);
  const machine = useGlassDesk((s) => s.state?.machine);
  const dispatch = useGlassDesk((s) => s.dispatch);
  const w = liveWin ?? win;

  const lines: string[] = strArr(w.payload.lines);
  const payloadCwd = typeof w.payload.cwd === "string" ? w.payload.cwd : "/";
  const history: string[] = strArr(w.payload.history);

  const cwd = payloadCwd === "" ? "/" : payloadCwd;
  const safeCwd = cwd === "/" || fs?.[cwd]?.kind === "folder" ? cwd : "/";
  const hostname = machine?.hostname ?? "glass-0000";
  const prompt = fs ? promptFor(fs, safeCwd, hostname) : `guest@${hostname}:~$`;

  const [input, setInput] = useState("");
  const [histIdx, setHistIdx] = useState<number | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const nearBottomRef = useRef(true);
  // keystroke mirroring (0-latency typing parity): every edit to the
  // input line streams to the peer seat as an ephemeral event — they
  // watch the command appear live, exactly like AnyDesk's remote input
  const sendInputEvt = useGlassDesk((s) => s.sendInput);
  const remoteDraft = useGlassDesk((s) => s.inputs[win.id]);

  /** set local input AND mirror it to the peer seat. */
  const typeInput = (next: string) => {
    setInput(next);
    sendInputEvt(win.id, next);
  };

  // auto-scroll on new output ONLY when already near the bottom —
  // never yank the viewport while the user scrolls up to read.
  useEffect(() => {
    const el = scrollRef.current;
    if (el && nearBottomRef.current) el.scrollTop = el.scrollHeight;
  }, [lines.length]);

  /** Read the LIVE payload at dispatch time (peer-safe: concurrent terminal
   *  use on the other seat can never be clobbered by a stale render copy). */
  const readLive = () => {
    const store = useGlassDesk.getState();
    const desktop = store.state;
    if (!desktop) return null;
    const live = desktop.windows.find((x) => x.id === win.id) ?? win;
    const rawCwd = typeof live.payload.cwd === "string" ? live.payload.cwd : "/";
    const liveCwd = rawCwd === "" ? "/" : rawCwd;
    const liveSafe = liveCwd === "/" || desktop.fs[liveCwd]?.kind === "folder" ? liveCwd : "/";
    return {
      store,
      desktop,
      lines: strArr(live.payload.lines),
      history: strArr(live.payload.history),
      cwd: liveSafe,
      prompt: promptFor(desktop.fs, liveSafe, desktop.machine.hostname),
    };
  };

  const run = (raw: string) => {
    const live = readLive();
    if (!live) return;
    const { store, desktop, lines: liveLines, history: liveHistory, cwd: liveCwd, prompt: livePrompt } = live;
    const echo = `${livePrompt} ${raw}`;
    const first = raw.trim().split(/\s+/)[0] ?? "";
    if (first === "clear") {
      dispatch({ t: "app:set", id: win.id, payload: { lines: [], cwd: liveCwd, history: liveHistory } });
      return;
    }
    const result = exec(raw, {
      fs: desktop.fs,
      cwd: liveCwd,
      desktop,
      peerNames: Object.values(store.peers).map((p) => p.name),
      code: store.code,
      history: liveHistory,
      user: store.name,
      open: openApp,
    });
    // fs mutations first, so both seats converge before the lines patch lands
    for (const op of result.ops) dispatch(op);
    for (const t of result.toasts) pushToast(t);
    const nextLines = [...liveLines, echo, ...result.out].slice(-400);
    const nextHistory = raw.trim() === "" ? liveHistory : [...liveHistory, raw].slice(-100);
    dispatch({
      t: "app:patch",
      id: win.id,
      patch: { lines: nextLines, cwd: result.cwd, history: nextHistory },
    });
  };

  const onTab = () => {
    if (input.length === 0) return;
    const live = readLive();
    if (!live) return;
    const { desktop, lines: liveLines, cwd: liveCwd, prompt: livePrompt } = live;
    const { next, candidates } = tabComplete(input, desktop.fs, liveCwd);
    if (next !== null && next !== input) typeInput(next);
    if (candidates.length === 0) return;
    // bash-style: ambiguity lists candidates in the (shared) transcript
    const echo = `${livePrompt} ${input}`;
    dispatch({
      t: "app:patch",
      id: win.id,
      patch: { lines: [...liveLines, echo, stSegs(candidates)].slice(-400) },
    });
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      run(input);
      typeInput("");
      setHistIdx(null);
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      if (history.length === 0) return;
      const idx = histIdx === null ? history.length - 1 : Math.max(0, histIdx - 1);
      setHistIdx(idx);
      typeInput(history[idx] ?? "");
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (histIdx === null) return;
      const idx = histIdx + 1;
      if (idx >= history.length) {
        setHistIdx(null);
        typeInput("");
      } else {
        setHistIdx(idx);
        typeInput(history[idx] ?? "");
      }
      return;
    }
    if (e.key === "Tab") {
      e.preventDefault(); // keep focus in the input — the editor owns Tab
      onTab();
    }
  };

  return (
    <div
      className="flex h-full flex-col bg-stone-900/85 backdrop-blur-md"
      onClick={() => inputRef.current?.focus()}
    >
      <div
        ref={scrollRef}
        role="log"
        aria-label="Terminal output"
        onScroll={(e) => {
          // captured synchronously — a ref write, never a deferred read
          const el = e.currentTarget;
          nearBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
        }}
        className="gd-scroll gd-mono min-h-0 flex-1 overflow-y-auto px-4 py-3 text-[13px] leading-relaxed text-stone-200 selection:bg-white/20"
      >
        {lines.length === 0 ? (
          <p className="select-none text-stone-400">
            shared terminal — both seats share this window. type{" "}
            <span className="text-stone-200">help</span> and press Enter.
          </p>
        ) : (
          lines.map((line, i) => (
            <div key={i} className="whitespace-pre-wrap break-words">
              {renderLine(line, hostname)}
            </div>
          ))
        )}
      </div>
      {/* peer keystroke ghost — the other seat's in-progress command,
          streamed live (ephemeral, never persisted) */}
      {remoteDraft && remoteDraft.text.length > 0 && (
        <div className="gd-mono flex min-h-[24px] items-center gap-2 px-4 text-[12px] text-stone-500" aria-live="polite">
          <span className="shrink-0 select-none rounded bg-white/10 px-1.5 py-0.5 text-[10px] uppercase tracking-wide">
            {remoteDraft.name}
          </span>
          <span className="min-w-0 flex-1 truncate whitespace-pre">{remoteDraft.text}</span>
          <span className="gd-caret shrink-0" aria-hidden />
        </div>
      )}
      <div className="gd-mono flex min-h-[44px] items-center gap-2 px-4 pb-3 pt-1 text-[13px]">
        <span className="shrink-0 select-none font-medium" style={{ color: "var(--gd-accent)" }}>
          {prompt}{"\u00A0"}
        </span>
        <input
          ref={inputRef}
          value={input}
          onChange={(e) => typeInput(e.target.value)}
          onKeyDown={onKeyDown}
          className="min-w-0 flex-1 bg-transparent text-stone-200 outline-none"
          style={{ caretColor: "var(--gd-accent)" }}
          autoFocus
          spellCheck={false}
          autoComplete="off"
          autoCapitalize="off"
          aria-label="terminal input"
        />
      </div>
    </div>
  );
}
