"use client";

// ============================================================
// GlassDesk — Code. A VS Code-lite JavaScript editor that edits
// the shared GlassDesk HD volume LIVE and RUNS code with a
// console. Payload: { fileId, path, value, lang, out } —
//   • value  : the shared buffer. Local keystrokes patch it
//              DEBOUNCED 300ms (co-editing without flooding);
//              blur/switch/save/run flush immediately.
//   • out    : console transcript with a 4-char style marker
//              ("log:"/"err:"/"warn:"/"ret:") — both seats see
//              run results.
//   • fileId : null = unsaved buffer (welcome demo on a fresh
//              window — seeded ONCE, never re-seeded on mount).
// Co-editing model: the textarea is controlled by the payload
// value; while an unflushed local draft exists the draft wins
// (peer edits can't clobber active typing). Losing focus flushes
// the draft, so remote edits are adopted whenever the editor is
// not focused OR the local doc is clean.
//
// Rendering: classic overlay technique — a transparent-text
// textarea sits above a MEMOIZED tokenized <pre>; both share
// exact font metrics (gd-mono 13px/1.6, same padding). Line
// numbers + the pre translate with the textarea's scrollTop via
// direct style writes in onScroll (no re-renders on scroll).
// ============================================================

import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type UIEvent,
} from "react";
import { AnimatePresence, motion } from "framer-motion";
import {
  ChevronRight,
  FileCode2,
  FilePlus2,
  FileText,
  Folder,
  HardDrive,
  Play,
  Save,
  Terminal,
  Trash2,
  type LucideIcon,
} from "lucide-react";
import { useGlassDesk } from "@/lib/vpc/store";
import { pushToast } from "@/lib/vpc/toast";
import { SPRING, riseIn, stagger } from "@/lib/vpc/motion";
import { TRASH_ID } from "@/lib/vpc/trash";
import { fsChildren, fsPathOf, uid, type FSMap, type FSNode, type WindowState } from "@/lib/vpc/types";

// ---------------- payload contract ----------------

interface P {
  fileId: string | null;
  path: string;
  value: string;
  lang: string;
  out: string[];
}

/** The unsaved welcome buffer (never written to the FS until saved). */
const WELCOME = `// 👋 Welcome to Code — a live, SHARED JavaScript editor.
// Both seats edit this buffer at the same time.
//
// Press the ▶ Run button (top right) to execute me —
// the output lands in the console below, on BOTH seats.

console.log("Hello from GlassDesk at", new Date().toLocaleTimeString());

// a small loop:
for (let i = 1; i <= 5; i++) {
  console.log(\`\${i} squared is \${i * i}\`);
}

// a tiny function…
const greet = (name) => \`hi \${name}, enjoy the demo\`;

// the value of the LAST expression is printed with "→" — try it:
greet("friend");
`;

// ---------------- syntax highlighting (regex tokenizer) ----------------

const KEYWORDS = new Set([
  "const", "let", "var", "function", "return", "if", "else", "for", "while", "do",
  "class", "new", "import", "export", "from", "async", "await", "try", "catch",
  "finally", "throw", "typeof", "of", "in", "switch", "case", "break", "continue",
  "default", "extends", "super", "this", "delete", "instanceof", "void", "yield",
  "static", "get", "set",
]);
const CONSTANTS = new Set(["true", "false", "null", "undefined", "NaN", "Infinity"]);

/** teal/emerald/amber/rose palette — NO blue/indigo (house rule). */
const CLS_COMMENT = "text-stone-500 italic";
const CLS_STRING = "text-amber-200";
const CLS_NUMBER = "text-rose-300";
const CLS_KEYWORD = "text-teal-300";
const CLS_BOOL = "text-amber-300";
const CLS_FN = "text-emerald-300";

/** One combined pass — alternation order = priority. Groups:
 *  1 line comment · 2 block comment · 3 'str' · 4 "str" · 5 `tpl`
 *  6 number · 7 word( (call) · 8 bare word. */
const TOKEN_RE =
  /(\/\/[^\n]*)|(\/\*[\s\S]*?\*\/)|('(?:[^'\\\n]|\\[\s\S])*'?)|("(?:[^"\\\n]|\\[\s\S])*"?)|(`(?:[^`\\]|\\[\s\S])*`?)|\b(\d+(?:\.\d+)?)\b|([A-Za-z_$][\w$]*)(?=\s*\()|([A-Za-z_$][\w$]*)/g;

interface Tok {
  t: string;
  c: string;
}

function tokenize(src: string): Tok[] {
  const out: Tok[] = [];
  let last = 0;
  TOKEN_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = TOKEN_RE.exec(src)) !== null) {
    if (m.index > last) out.push({ t: src.slice(last, m.index), c: "" });
    const text = m[0];
    let c = "";
    if (m[1] !== undefined || m[2] !== undefined) c = CLS_COMMENT;
    else if (m[3] !== undefined || m[4] !== undefined || m[5] !== undefined) c = CLS_STRING;
    else if (m[6] !== undefined) c = CLS_NUMBER;
    else if (m[7] !== undefined)
      c = KEYWORDS.has(text) ? CLS_KEYWORD : CONSTANTS.has(text) ? CLS_BOOL : CLS_FN;
    else if (m[8] !== undefined)
      c = KEYWORDS.has(text) ? CLS_KEYWORD : CONSTANTS.has(text) ? CLS_BOOL : "";
    out.push({ t: text, c });
    last = m.index + text.length;
  }
  if (last < src.length) out.push({ t: src.slice(last), c: "" });
  return out;
}

// ---------------- run sandbox helpers ----------------

const LINE_CAP = 200;
const ARG_CAP = 400;

/** Depth-safe stringify for console arguments. */
function fmtArg(v: unknown): string {
  const t = typeof v;
  if (t === "string") return v as string;
  if (t === "number" || t === "boolean" || t === "bigint" || t === "undefined") return String(v);
  if (v === null) return "null";
  if (t === "function") return `ƒ ${(v as { name?: string }).name || "anonymous"}`;
  if (t === "symbol") return String(v);
  try {
    const s = JSON.stringify(v) ?? String(v);
    return s;
  } catch {
    return String(v);
  }
}

function trunc(s: string): string {
  return s.length > ARG_CAP ? s.slice(0, ARG_CAP) + " …" : s;
}

/** Auto-numbered script names: script.js, script-2.js, … */
function nextScriptName(fs: FSMap): string {
  const taken = new Set(fsChildren(fs, null).map((n) => n.name.toLowerCase()));
  if (!taken.has("script.js")) return "script.js";
  let i = 2;
  while (taken.has(`script-${i}.js`)) i += 1;
  return `script-${i}.js`;
}

const EMPTY_FS: FSMap = {};

/** is this name a "code" file (FileCode icon) vs plain text (FileText)? */
function isCodeName(name: string): boolean {
  return /\.(js|ts|jsx|tsx|mjs|cjs|json|html|css|py|sh|md|ya?ml|rs|go)$/i.test(name);
}

// ---------------- tree ----------------

interface TreeRowProps {
  node: FSNode;
  fs: FSMap;
  depth: number;
  fileId: string | null;
  collapsed: ReadonlySet<string>;
  onToggle: (id: string) => void;
  onOpen: (node: FSNode) => void;
}

const ROW_VARIANTS = {
  hidden: { opacity: 0, x: -6 },
  show: { opacity: 1, x: 0, transition: SPRING.snappy },
} as const;

function TreeRowInner({ node, fs, depth, fileId, collapsed, onToggle, onOpen }: TreeRowProps) {
  const open = !collapsed.has(node.id);

  if (node.kind === "folder") {
    const kids = fsChildren(fs, node.id).filter((k) => k.kind !== "app");
    return (
      <div>
        <motion.button
          type="button"
          variants={ROW_VARIANTS}
          onClick={() => onToggle(node.id)}
          aria-expanded={open}
          className="relative flex w-full items-center gap-1 rounded-md py-[5px] pr-2 text-left transition-colors hover:bg-white/5"
          style={{ paddingLeft: 6 + depth * 12 }}
        >
          <motion.span
            animate={{ rotate: open ? 90 : 0 }}
            transition={SPRING.snappy}
            className="grid shrink-0 place-items-center text-stone-600"
          >
            <ChevronRight className="size-3.5" />
          </motion.span>
          <Folder className={`size-3.5 shrink-0 ${open ? "text-amber-300/80" : "text-stone-500"}`} />
          <span className="min-w-0 flex-1 truncate text-[12px] text-stone-300">{node.name}</span>
        </motion.button>
        {open &&
          kids.map((kid) => (
            <TreeRow
              key={kid.id}
              node={kid}
              fs={fs}
              depth={depth + 1}
              fileId={fileId}
              collapsed={collapsed}
              onToggle={onToggle}
              onOpen={onOpen}
            />
          ))}
      </div>
    );
  }

  // file row
  const active = node.id === fileId;
  const Icon: LucideIcon = isCodeName(node.name) ? FileCode2 : FileText;
  return (
    <motion.button
      type="button"
      variants={ROW_VARIANTS}
      onClick={() => onOpen(node)}
      className="group relative flex w-full items-center gap-1 rounded-md py-[5px] pr-2 text-left transition-colors hover:bg-white/5"
      style={{
        paddingLeft: 6 + depth * 12,
        background: active ? "color-mix(in srgb, var(--gd-accent) 16%, transparent)" : undefined,
      }}
    >
      {active && (
        <span
          aria-hidden
          className="absolute inset-y-1 left-0 w-0.5 rounded-full"
          style={{ background: "var(--gd-accent)" }}
        />
      )}
      {/* chevron-column spacer keeps file icons aligned with folder icons */}
      <span className="w-3.5 shrink-0" />
      <Icon className={`size-3.5 shrink-0 ${active ? "text-emerald-300" : "text-stone-500"}`} />
      <span
        className={`min-w-0 flex-1 truncate text-[12px] ${
          active ? "font-medium text-stone-100" : "text-stone-400 group-hover:text-stone-200"
        }`}
      >
        {node.name}
      </span>
    </motion.button>
  );
}

const TreeRow = memo(TreeRowInner);

// ---------------- scroll sync (pure DOM, zero re-renders) ----------------

function syncScroll(
  ta: HTMLTextAreaElement | null,
  gutter: HTMLElement | null,
  code: HTMLElement | null,
): void {
  if (!ta) return;
  const y = -ta.scrollTop;
  const x = -ta.scrollLeft;
  if (gutter) gutter.style.transform = `translate3d(0px, ${y}px, 0px)`;
  if (code) code.style.transform = `translate3d(${x}px, ${y}px, 0px)`;
}

// ============================================================
// CodeApp
// ============================================================

export default function CodeApp({ win }: { win: WindowState }) {
  // live window — payload arrives fresh on every sync op
  const liveWin = useGlassDesk((s) => s.state?.windows.find((w) => w.id === win.id));
  const fs = useGlassDesk((s) => s.state?.fs);
  const dispatch = useGlassDesk((s) => s.dispatch);
  const w = liveWin ?? win;

  // ---- payload (defensively narrowed) ----
  const fileId =
    typeof w.payload.fileId === "string" && w.payload.fileId.length > 0 ? w.payload.fileId : null;
  const value = typeof w.payload.value === "string" ? w.payload.value : "";
  const payloadPath = typeof w.payload.path === "string" ? w.payload.path : "";
  const out = useMemo(
    () => (Array.isArray(w.payload.out) ? w.payload.out.map((x) => String(x)) : []),
    [w.payload.out],
  );

  // top-z focus guard — ⌘S only fires when this window is raised
  const active = useGlassDesk((s) => {
    const d = s.state;
    if (!d) return false;
    let topZ = -1;
    let topId: string | null = null;
    for (const wnd of d.windows) {
      if (wnd.minimized) continue;
      if ((wnd.workspace ?? 0) !== d.workspace) continue;
      if (wnd.z > topZ) {
        topZ = wnd.z;
        topId = wnd.id;
      }
    }
    return topId === win.id;
  });

  // ---- local (per-seat, never synced) UI state ----
  const [draft, setDraft] = useState<string | null>(null); // unflushed local buffer
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set());
  const [consoleOpen, setConsoleOpen] = useState(true);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [sheetName, setSheetName] = useState("");

  // ---- refs ----
  const taRef = useRef<HTMLTextAreaElement | null>(null);
  const gutterRef = useRef<HTMLDivElement | null>(null);
  const codeRef = useRef<HTMLDivElement | null>(null);
  const consoleRef = useRef<HTMLDivElement | null>(null);
  const draftRef = useRef<string | null>(null); // mirrors `draft` for stable callbacks
  const seededRef = useRef(false);

  // ---- what the editor shows: local draft wins over payload ----
  const shown = draft !== null ? draft : value;
  const lineCount = useMemo(() => shown.split("\n").length, [shown]);
  const lineNumbers = useMemo(
    () => Array.from({ length: lineCount }, (_, i) => i + 1),
    [lineCount],
  );
  const tokens = useMemo(() => tokenize(shown), [shown]);

  const onDisk = fileId && fs ? fs[fileId]?.content : undefined;
  const dirty = fileId === null ? shown.length > 0 : shown !== onDisk;
  const path =
    fileId && fs?.[fileId]
      ? fsPathOf(fs, fileId)
      : fileId === null
        ? "welcome.js"
        : payloadPath || "untitled";
  const fileLabel = fileId && fs?.[fileId] ? fs[fileId].name : "welcome.js";

  // ---- stable ops (callbacks read live truth from refs + the store,
  //      so even long-lived closures never go stale) ----

  const patch = useCallback(
    (o: Partial<P>) => dispatch({ t: "app:patch", id: win.id, patch: o as Record<string, unknown> }),
    [dispatch, win.id],
  );

  /** flush the pending local draft into the shared payload */
  const flushPending = useCallback(() => {
    const d = draftRef.current;
    if (d === null) return;
    draftRef.current = null;
    setDraft(null);
    patch({ value: d });
  }, [patch]);

  /** read the CURRENT payload straight from the store (post-dispatch truth) */
  const livePayload = useCallback((): Partial<P> => {
    const s = useGlassDesk.getState().state;
    const p = s?.windows.find((x) => x.id === win.id)?.payload;
    return (p ?? {}) as Partial<P>;
  }, [win.id]);

  /** flush + persist unsaved edits before the buffer points anywhere else */
  const commitBeforeSwitch = useCallback(() => {
    flushPending();
    const s = useGlassDesk.getState().state;
    const p = livePayload();
    const val = typeof p.value === "string" ? p.value : "";
    const prevId = typeof p.fileId === "string" ? p.fileId : null;
    const prevNode = prevId ? s?.fs[prevId] : undefined;
    if (prevNode && prevNode.kind === "file" && val !== prevNode.content) {
      dispatch({
        t: "fs:upsert",
        node: { ...prevNode, content: val, updatedAt: Date.now() },
      });
    }
  }, [dispatch, win.id, flushPending, livePayload]);

  const openFile = useCallback(
    (node: FSNode) => {
      if (node.kind !== "file" || node.id === fileId) return;
      commitBeforeSwitch();
      const s = useGlassDesk.getState().state;
      dispatch({
        t: "app:patch",
        id: win.id,
        patch: { fileId: node.id, path: fsPathOf(s?.fs ?? EMPTY_FS, node.id), value: node.content },
      });
      dispatch({ t: "win:title", id: win.id, title: node.name });
    },
    [fileId, dispatch, win.id, commitBeforeSwitch],
  );

  const newFile = useCallback(() => {
    const s = useGlassDesk.getState().state;
    if (!s) return;
    commitBeforeSwitch();
    const name = nextScriptName(s.fs);
    const id = uid();
    dispatch({
      t: "fs:upsert",
      node: { id, name, kind: "file", parent: null, content: "", updatedAt: Date.now() },
    });
    dispatch({ t: "app:patch", id: win.id, patch: { fileId: id, path: `/${name}`, value: "" } });
    dispatch({ t: "win:title", id: win.id, title: name });
    pushToast({
      title: `Created ${name}`,
      body: "in GlassDesk HD · / — ⌘S saves it",
      kind: "success",
    });
    requestAnimationFrame(() => taRef.current?.focus());
  }, [dispatch, win.id, commitBeforeSwitch]);

  const save = useCallback(() => {
    flushPending();
    const s = useGlassDesk.getState().state;
    const p = livePayload();
    const val = typeof p.value === "string" ? p.value : "";
    const fid = typeof p.fileId === "string" ? p.fileId : null;
    if (fid) {
      const node = s?.fs[fid];
      if (node && node.kind === "file" && node.content === val) return; // clean
      const name = node?.name ?? "script.js";
      dispatch({
        t: "fs:upsert",
        node: {
          id: fid,
          name,
          kind: "file",
          parent: node?.parent ?? null,
          content: val,
          updatedAt: Date.now(),
        },
      });
      pushToast({
        title: `Saved ${name}`,
        body: `GlassDesk HD · ${fsPathOf(s?.fs ?? EMPTY_FS, fid)}`,
        kind: "success",
      });
    } else {
      // unsaved buffer → name sheet (created in the volume root)
      const fresh = useGlassDesk.getState().state;
      setSheetName(nextScriptName(fresh?.fs ?? EMPTY_FS));
      setSheetOpen(true);
    }
  }, [dispatch, win.id, flushPending, livePayload]);

  const createInRoot = useCallback(() => {
    flushPending();
    const s = useGlassDesk.getState().state;
    if (!s) return;
    const p = livePayload();
    const val = typeof p.value === "string" ? p.value : "";
    const raw = sheetName.trim();
    const name = raw.length > 0 ? raw : nextScriptName(s.fs);
    const id = uid();
    dispatch({
      t: "fs:upsert",
      node: { id, name, kind: "file", parent: null, content: val, updatedAt: Date.now() },
    });
    dispatch({ t: "app:patch", id: win.id, patch: { fileId: id, path: `/${name}`, value: val } });
    dispatch({ t: "win:title", id: win.id, title: name });
    setSheetOpen(false);
    pushToast({ title: `Saved ${name}`, body: "created in GlassDesk HD · /", kind: "success" });
    requestAnimationFrame(() => taRef.current?.focus());
  }, [sheetName, dispatch, win.id, flushPending, livePayload]);

  const run = useCallback(() => {
    flushPending();
    const s = useGlassDesk.getState().state;
    const p = livePayload();
    const src = typeof p.value === "string" ? p.value : "";
    const name = p.fileId && s?.fs[p.fileId] ? s.fs[p.fileId].name : "welcome.js";

    const lines: string[] = [];
    const push = (k: "log" | "warn" | "err" | "ret", args: unknown[]) => {
      lines.push(`${k}:${trunc(args.map(fmtArg).join(" "))}`);
    };
    const fake = {
      log: (...a: unknown[]) => push("log", a),
      warn: (...a: unknown[]) => push("warn", a),
      error: (...a: unknown[]) => push("err", a),
    };
    try {
      // Direct eval INSIDE the function body: (a) the eval'd script sees the
      // injected `console` param, (b) strict mode propagates, (c) eval —
      // unlike a plain function body — returns the completion value of the
      // last statement, so REPL-style "→ result" lines work.
      const fn = new Function("console", `"use strict";\nreturn eval(${JSON.stringify(src)});`);
      const r = fn(fake);
      if (r !== undefined) push("ret", [r]);
    } catch (e) {
      push("err", [e instanceof Error ? `${e.name}: ${e.message}` : String(e)]);
    }
    const capped = lines.slice(0, LINE_CAP);
    if (lines.length > LINE_CAP) capped.push(`log:… output capped at ${LINE_CAP} lines`);
    patch({ out: capped });
    setConsoleOpen(true);
    const errs = capped.filter((l) => l.startsWith("err:")).length;
    pushToast({
      title: `Ran ${name}`,
      body: `${capped.length} line${capped.length === 1 ? "" : "s"} out — both seats see it`,
      kind: errs > 0 ? "danger" : "success",
    });
  }, [patch, win.id, flushPending, livePayload]);

  // ---- effects ----

  // welcome buffer: seed ONCE if the payload is still pristine
  useEffect(() => {
    if (seededRef.current) return;
    seededRef.current = true;
    const p = livePayload();
    if (p.fileId == null && (p.value === "" || p.value === undefined)) {
      patch({ value: WELCOME });
    }
  }, [livePayload, patch]);

  // debounced live sync — 300ms after the last keystroke
  useEffect(() => {
    if (draft === null) return;
    const timer = setTimeout(flushPending, 300);
    return () => clearTimeout(timer);
  }, [draft, flushPending]);

  // ⌘S / Ctrl+S when this window is raised
  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey) return;
      if (e.code !== "KeyS" && e.key.toLowerCase() !== "s") return;
      e.preventDefault();
      save();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active, save]);

  // file switch → reset the viewport + re-sync the overlays
  useEffect(() => {
    const ta = taRef.current;
    if (ta) {
      ta.scrollTop = 0;
      ta.scrollLeft = 0;
    }
    syncScroll(taRef.current, gutterRef.current, codeRef.current);
  }, [fileId]);

  // console sticks to the bottom on new output / expand
  useEffect(() => {
    const el = consoleRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [out, consoleOpen]);

  // ---- editor event handlers ----

  const onChange = (e: ChangeEvent<HTMLTextAreaElement>) => {
    const v = e.target.value;
    draftRef.current = v;
    setDraft(v);
  };

  const onKeyDown = (e: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key !== "Tab") return;
    e.preventDefault(); // the editor owns Tab — insert 2 spaces
    const ta = e.currentTarget;
    const start = ta.selectionStart;
    const end = ta.selectionEnd;
    const v = ta.value;
    const next = v.slice(0, start) + "  " + v.slice(Math.max(start, end));
    const caret = start + 2;
    draftRef.current = next;
    setDraft(next);
    requestAnimationFrame(() => ta.setSelectionRange(caret, caret));
  };

  const onScroll = (e: UIEvent<HTMLTextAreaElement>) => {
    syncScroll(e.currentTarget, gutterRef.current, codeRef.current);
  };

  const toggleFolder = (id: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const rootRows = useMemo(
    () =>
      fs
        ? fsChildren(fs, null).filter((n) => n.kind !== "app" && n.id !== TRASH_ID)
        : ([] as FSNode[]),
    [fs],
  );

  // ---- render ----

  return (
    <div className="flex h-full w-full flex-col overflow-hidden bg-gradient-to-b from-stone-900 via-stone-900 to-stone-950 text-stone-100">
      <div className="flex min-h-0 flex-1">
        {/* ---------------- sidebar: volume tree ---------------- */}
        <aside className="flex w-[180px] shrink-0 flex-col border-r border-stone-800 bg-stone-950/60">
          <div className="flex h-9 shrink-0 items-center gap-1.5 border-b border-stone-800/70 px-3 text-stone-500">
            <HardDrive className="size-3 shrink-0" />
            <span className="truncate text-[10px] font-semibold tracking-[0.12em]">GLASSDESK HD</span>
          </div>
          <div className="gd-scroll min-h-0 flex-1 overflow-y-auto px-1.5 py-1.5">
            <motion.div
              variants={stagger(0.02, 0.02)}
              initial="hidden"
              animate="show"
            >
              {rootRows.map((n) => (
                <TreeRow
                  key={n.id}
                  node={n}
                  fs={fs ?? EMPTY_FS}
                  depth={0}
                  fileId={fileId}
                  collapsed={collapsed}
                  onToggle={toggleFolder}
                  onOpen={openFile}
                />
              ))}
            </motion.div>
          </div>
          <button
            type="button"
            onClick={newFile}
            className="m-2 flex h-8 shrink-0 items-center justify-center gap-1.5 rounded-lg border border-dashed border-stone-700 text-[11px] font-medium text-stone-400 transition-[border-color,color,transform] hover:border-stone-500 hover:text-stone-200 active:scale-[0.98]"
          >
            <FilePlus2 className="size-3.5" />
            New file
          </button>
        </aside>

        {/* ---------------- main column ---------------- */}
        <div className="relative flex min-w-0 flex-1 flex-col">
          {/* top bar */}
          <div className="flex h-11 shrink-0 items-center gap-2 border-b border-stone-800 px-3">
            <span className="gd-mono min-w-0 flex-1 truncate text-[12px] text-stone-400">
              {path}
              {fileId === null && (
                <span className="ml-2 text-[10px] italic text-stone-600">not on disk</span>
              )}
            </span>
            {dirty && (
              <motion.span
                aria-label="unsaved changes"
                animate={{ scale: [1, 1.35, 1], opacity: [0.65, 1, 0.65] }}
                transition={{ repeat: Infinity, duration: 1.6, ease: "easeInOut" }}
                className="size-1.5 shrink-0 rounded-full bg-amber-400"
              />
            )}
            <button
              type="button"
              onClick={save}
              className="flex h-7 shrink-0 items-center gap-1.5 rounded-lg border border-stone-700 bg-stone-800/70 px-2.5 text-[12px] text-stone-300 transition-[background-color,color,transform] hover:bg-stone-700/70 hover:text-stone-100 active:scale-[0.97]"
            >
              <Save className="size-3.5" />
              Save
              <kbd className="rounded border border-stone-700 bg-stone-900 px-1 py-px text-[9px] font-medium text-stone-500">
                ⌘S
              </kbd>
            </button>
            <motion.button
              type="button"
              onClick={run}
              whileHover={{ scale: 1.03 }}
              whileTap={{ scale: 0.97 }}
              transition={SPRING.snappy}
              className="gd-accent-gradient flex h-7 shrink-0 items-center gap-1.5 rounded-lg px-3 text-[12px] font-semibold text-white shadow-lg shadow-black/40"
            >
              <Play className="size-3.5" />
              Run
            </motion.button>
          </div>

          {/* editor: line-number gutter + highlight overlay + textarea */}
          <div className="relative flex min-h-0 flex-1 overflow-hidden">
            <div
              aria-hidden
              className="relative w-12 shrink-0 select-none overflow-hidden border-r border-stone-800/70 bg-stone-950/40"
            >
              <div
                ref={gutterRef}
                className="gd-mono px-2 py-3 text-right text-[13px] leading-[1.6] text-stone-600"
              >
                {lineNumbers.map((n) => (
                  <div key={n} className="tabular-nums">
                    {n}
                  </div>
                ))}
              </div>
            </div>
            <div className="relative min-w-0 flex-1 overflow-hidden">
              {/* highlighted layer — memoized tokens, metrics MUST match the textarea */}
              <pre aria-hidden className="pointer-events-none absolute inset-0 m-0 overflow-hidden">
                <div
                  ref={codeRef}
                  className="gd-mono w-max whitespace-pre p-3 text-[13px] leading-[1.6] text-stone-200"
                >
                  {tokens.map((tk, i) =>
                    tk.c ? (
                      <span key={i} className={tk.c}>
                        {tk.t}
                      </span>
                    ) : (
                      tk.t
                    ),
                  )}
                </div>
              </pre>
              {/* input layer — transparent text, accent caret, on top */}
              <textarea
                ref={taRef}
                value={shown}
                onChange={onChange}
                onKeyDown={onKeyDown}
                onBlur={flushPending}
                onScroll={onScroll}
                wrap="off"
                spellCheck={false}
                autoComplete="off"
                autoCapitalize="off"
                autoCorrect="off"
                aria-label={`${fileLabel} — code editor`}
                className="gd-scroll gd-mono absolute inset-0 resize-none overflow-auto whitespace-pre bg-transparent p-3 text-[13px] leading-[1.6] text-transparent outline-none selection:bg-white/15"
                style={{ caretColor: "var(--gd-accent)" }}
                autoFocus
              />
            </div>
          </div>

          {/* console — shared transcript, marker-prefixed lines */}
          <div
            className={`relative flex shrink-0 flex-col overflow-hidden border-t border-stone-800 bg-stone-950/70 ${
              consoleOpen ? "h-[35%]" : "h-9"
            }`}
          >
            <div className="flex h-9 shrink-0 items-center gap-1.5 px-3">
              <button
                type="button"
                onClick={() => setConsoleOpen((o) => !o)}
                aria-expanded={consoleOpen}
                className="flex items-center gap-1.5 text-[11px] font-medium tracking-wide text-stone-400 transition-colors hover:text-stone-200"
              >
                <Terminal className="size-3.5 text-stone-500" />
                Console
                {out.length > 0 && (
                  <span className="rounded-full bg-stone-800 px-1.5 text-[9px] text-stone-400">
                    {out.length}
                  </span>
                )}
                <motion.span
                  animate={{ rotate: consoleOpen ? 90 : -90 }}
                  transition={SPRING.snappy}
                  className="grid place-items-center text-stone-500"
                >
                  <ChevronRight className="size-3.5" />
                </motion.span>
              </button>
              <div className="ml-auto flex items-center gap-1">
                {out.length > 0 && (
                  <button
                    type="button"
                    onClick={() => dispatch({ t: "app:patch", id: win.id, patch: { out: [] } })}
                    className="flex items-center gap-1 rounded-md px-1.5 py-1 text-[10px] text-stone-500 transition-colors hover:bg-white/5 hover:text-stone-300"
                  >
                    <Trash2 className="size-3" />
                    Clear
                  </button>
                )}
              </div>
            </div>
            <div
              ref={consoleRef}
              role="log"
              aria-label="Console output"
              className="gd-scroll gd-mono absolute inset-x-0 bottom-0 top-9 overflow-y-auto px-3 pb-2 text-[12px] leading-[1.55]"
            >
              <motion.div
                animate={{ opacity: consoleOpen ? 1 : 0, y: consoleOpen ? 0 : 6 }}
                transition={SPRING.snappy}
              >
                {out.length === 0 ? (
                  <p className="select-none pt-2 text-stone-600">
                    Run ▶ to execute — output shows here, on both seats.
                  </p>
                ) : (
                  out.map((line, i) => {
                    const k = line.slice(0, 4);
                    const text = line.slice(4);
                    if (k === "err:")
                      return (
                        <div key={i} className="whitespace-pre-wrap break-words text-rose-400">
                          {text}
                        </div>
                      );
                    if (k === "warn:")
                      return (
                        <div key={i} className="whitespace-pre-wrap break-words text-amber-300">
                          {text}
                        </div>
                      );
                    if (k === "ret:")
                      return (
                        <div key={i} className="whitespace-pre-wrap break-words text-teal-300">
                          <span className="select-none text-stone-600">→ </span>
                          {text}
                        </div>
                      );
                    return (
                      <div key={i} className="whitespace-pre-wrap break-words text-stone-300">
                        {text}
                      </div>
                    );
                  })
                )}
              </motion.div>
            </div>
          </div>

          {/* save-as sheet (unsaved buffer → named file in the volume root) */}
          <AnimatePresence>
            {sheetOpen && (
              <motion.div
                key="sheet"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.15 }}
                className="absolute inset-0 z-20 grid place-items-center bg-stone-950/70 backdrop-blur-[2px]"
                onClick={() => setSheetOpen(false)}
              >
                <motion.div
                  variants={riseIn}
                  initial="hidden"
                  animate="show"
                  exit="exit"
                  onClick={(e) => e.stopPropagation()}
                  className="w-72 rounded-xl border border-stone-700 bg-stone-900 p-3 shadow-2xl shadow-black/50"
                  role="dialog"
                  aria-label="Save file to GlassDesk HD"
                >
                  <p className="text-[12px] font-semibold text-stone-100">Save to GlassDesk HD</p>
                  <p className="mt-0.5 text-[11px] text-stone-500">
                    The buffer becomes a real file at the volume root ( / )
                  </p>
                  <input
                    autoFocus
                    value={sheetName}
                    onChange={(e) => setSheetName(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") createInRoot();
                      if (e.key === "Escape") setSheetOpen(false);
                    }}
                    spellCheck={false}
                    aria-label="File name"
                    className="gd-mono mt-2.5 w-full rounded-lg border border-stone-700 bg-stone-950 px-2.5 py-1.5 text-[12px] text-stone-100 outline-none transition-colors focus:border-stone-500"
                  />
                  <div className="mt-2.5 flex justify-end gap-2">
                    <button
                      type="button"
                      onClick={() => setSheetOpen(false)}
                      className="h-7 rounded-lg px-2.5 text-[11px] text-stone-400 transition-colors hover:text-stone-200"
                    >
                      Cancel
                    </button>
                    <button
                      type="button"
                      onClick={createInRoot}
                      className="gd-accent-gradient h-7 rounded-lg px-3 text-[11px] font-semibold text-white"
                    >
                      Create file
                    </button>
                  </div>
                </motion.div>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </div>
    </div>
  );
}
