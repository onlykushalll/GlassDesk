"use client";

// ============================================================
// GlassDesk — Files 2.0 (a real file manager + Trash).
// Payload: { cwd: string | null } — null = volume root
// ("GlassDesk HD"). Navigation patches the shared payload so both
// seats browse the same folder; every mutation goes through
// fs:upsert / fs:delete ops and converges on both seats.
//
//  • sidebar: Home / Desktop / Documents / Trash (live count)
//  • toolbar: back / forward / up + breadcrumbs + New Folder/File
//    + live name search + Grid/List toggle + sort menu
//  • grid tiles (amber folders, teal files) or detail list rows
//  • right-click: Open / Rename / Delete (→ Trash) / Properties
//  • special Trash view: banner, per-item Restore + Delete forever,
//    2-step "Really empty?" confirm
//  • every mutation toasts (created / renamed / trashed / restored /
//    emptied / deleted forever)
// ============================================================

import { useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import { AnimatePresence, motion } from "framer-motion";
import {
  ArrowUp,
  ArrowDownWideNarrow,
  Check,
  ChevronLeft,
  ChevronRight,
  FilePlus2,
  FileText,
  Folder,
  FolderOpen,
  FolderPlus,
  HardDrive,
  Home,
  Info,
  LayoutGrid,
  List,
  Monitor,
  Pencil,
  RotateCcw,
  Search,
  SearchX,
  Trash2,
  X,
  type LucideIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { openApp } from "@/components/vpc/desktop/Dock";
import { openContextMenu } from "@/components/vpc/desktop/ContextMenu";
import { useGlassDesk } from "@/lib/vpc/store";
import { pushToast } from "@/lib/vpc/toast";
import {
  emptyTrash,
  ensureDocuments,
  ensureTrash,
  moveToTrash,
  restoreFromTrash,
  TRASH_ID,
  trashNodes,
} from "@/lib/vpc/trash";
import {
  DESKTOP_NODE_ID,
  fsChildren,
  fsPathOf,
  uid,
  type FSMap,
  type FSNode,
  type WindowState,
} from "@/lib/vpc/types";

type ViewMode = "grid" | "list";
type SortKey = "name" | "kind" | "modified";

const SORT_LABEL: Record<SortKey, string> = { name: "Name", kind: "Kind", modified: "Modified" };
const SPRING = { type: "spring", stiffness: 420, damping: 30 } as const;

function tileFor(node: FSNode): string {
  return node.kind === "folder" ? "from-amber-400 to-orange-400" : "from-teal-400 to-emerald-400";
}

function fmtWhen(ts: number): string {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return "now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 604800) return `${Math.floor(s / 86400)}d ago`;
  return new Date(ts).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/** createOnDesktop-style auto-numbered names ("New Folder (2)"). */
function uniqueName(fs: FSMap, parent: string | null, kind: "file" | "folder"): string {
  const taken = fsChildren(fs, parent).map((n) => n.name.toLowerCase());
  const base = kind === "folder" ? "New Folder" : "Untitled.txt";
  let name = base;
  let n = 2;
  while (taken.includes(name.toLowerCase())) {
    name = kind === "folder" ? `New Folder (${n})` : `Untitled ${n}.txt`;
    n += 1;
  }
  return name;
}

// ---- small stable sub-components (module level → no remount churn) ----

function SidebarButton({
  active,
  onClick,
  icon: Icon,
  label,
  badge,
}: {
  active: boolean;
  onClick: () => void;
  icon: LucideIcon;
  label: string;
  badge?: number;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={active ? "true" : undefined}
      className={`flex min-h-9 items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-[13px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--gd-accent)] ${
        active ? "bg-white/75 text-stone-800" : "text-stone-600 hover:bg-white/50 hover:text-stone-800"
      }`}
      style={active ? { boxShadow: "inset 0 0 0 1.5px var(--gd-accent)" } : undefined}
    >
      <Icon className="size-4 shrink-0" style={active ? { color: "var(--gd-accent)" } : undefined} />
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {badge ? (
        <span
          className="grid min-w-5 shrink-0 place-items-center rounded-full px-1 py-0.5 text-[10px] font-semibold leading-none text-white"
          style={{ background: "var(--gd-accent)" }}
        >
          {badge > 99 ? "99+" : badge}
        </span>
      ) : null}
    </button>
  );
}

function RenameBox({
  value,
  onChange,
  onCommit,
  onCancel,
  center,
}: {
  value: string;
  onChange: (v: string) => void;
  onCommit: () => void;
  onCancel: () => void;
  center?: boolean;
}) {
  return (
    <input
      autoFocus
      value={value}
      spellCheck={false}
      aria-label="Rename item"
      onFocus={(e) => e.currentTarget.select()}
      onChange={(e) => onChange(e.target.value)}
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onBlur={onCommit}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          onCommit();
        } else if (e.key === "Escape") {
          e.preventDefault();
          onCancel();
        }
      }}
      className={
        center
          ? "w-full rounded-md border border-white/80 bg-white/90 px-1 py-0.5 text-center text-xs text-stone-700 focus:outline-none focus:ring-2 focus:ring-[var(--gd-accent)]"
          : "h-7 w-full rounded-md border border-white/80 bg-white/90 px-2 text-sm text-stone-700 focus:outline-none focus:ring-2 focus:ring-[var(--gd-accent)]"
      }
    />
  );
}

function EmptyState({ icon: Icon, title, hint }: { icon: LucideIcon; title: string; hint?: string }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2.5 p-6 text-center">
      <Icon className="size-10 text-stone-300" />
      <p className="text-sm font-medium text-stone-500">{title}</p>
      {hint ? <p className="max-w-56 text-xs text-stone-400">{hint}</p> : null}
    </div>
  );
}

// ============================================================

export default function FilesApp({ win }: { win: WindowState }) {
  // the LIVE window — payload arrives fresh from the store on every sync op
  const liveWin = useGlassDesk((s) => s.state?.windows.find((w) => w.id === win.id));
  const fs = useGlassDesk((s) => s.state?.fs);
  const dispatch = useGlassDesk((s) => s.dispatch);
  const w = liveWin ?? win;

  const rawCwd = typeof w.payload.cwd === "string" ? w.payload.cwd : null;
  // if the folder we are inside vanished, fall back to the volume root
  const cwd = rawCwd && fs && fs[rawCwd]?.kind === "folder" ? rawCwd : null;
  const isTrashView = cwd === TRASH_ID;

  // local (per-seat, never synced) UI state
  const [selected, setSelected] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [query, setQuery] = useState("");
  const [view, setView] = useState<ViewMode>("grid");
  const [sortBy, setSortBy] = useState<SortKey>("name");
  const [nav, setNav] = useState<{ stack: (string | null)[]; i: number }>({ stack: [], i: -1 });
  const [propsNode, setPropsNode] = useState<FSNode | null>(null);
  const [emptyArmed, setEmptyArmed] = useState(false);
  const emptyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const ancestors = useMemo(() => {
    const chain: FSNode[] = [];
    let cur: FSNode | undefined = cwd && fs ? fs[cwd] : undefined;
    while (cur) {
      chain.unshift(cur);
      cur = cur.parent && fs ? fs[cur.parent] : undefined;
    }
    return chain;
  }, [fs, cwd]);

  const docsNode = useMemo(
    () =>
      fs
        ? Object.values(fs).find(
            (n) => n.parent === null && n.name === "Documents" && n.kind === "folder" && n.id !== TRASH_ID,
          )
        : undefined,
    [fs],
  );

  const trashCount = useMemo(() => (fs ? trashNodes(fs).length : 0), [fs]);

  // direct child count per folder (O(n) — powers list "N items" column)
  const childCounts = useMemo(() => {
    const m: Record<string, number> = {};
    if (fs) for (const n of Object.values(fs)) if (n.parent) m[n.parent] = (m[n.parent] ?? 0) + 1;
    return m;
  }, [fs]);

  const baseItems = useMemo(() => {
    if (!fs) return [];
    if (isTrashView) return trashNodes(fs);
    const kids = fsChildren(fs, cwd);
    return cwd === null ? kids.filter((n) => n.id !== TRASH_ID) : kids; // hide Trash at root
  }, [fs, cwd, isTrashView]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = q ? baseItems.filter((n) => n.name.toLowerCase().includes(q)) : baseItems;
    const out = [...list];
    if (sortBy === "name") out.sort((a, b) => a.name.localeCompare(b.name));
    else if (sortBy === "kind")
      out.sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === "folder" ? -1 : 1));
    else out.sort((a, b) => b.updatedAt - a.updatedAt);
    return out;
  }, [baseItems, query, sortBy]);

  // ---- navigation (payload is shared, history is per-seat) ----

  const go = (id: string | null) => {
    dispatch({ t: "app:patch", id: win.id, patch: { cwd: id } });
    setSelected(null);
    setRenaming(null);
    setPropsNode(null);
    setEmptyArmed(false);
  };

  const navigate = (id: string | null) => {
    if (id === cwd) return;
    setNav((n) => {
      // seed history with where we are now, then push
      const base = n.i === -1 ? [cwd] : n.stack.slice(0, n.i + 1);
      return { stack: [...base, id], i: base.length };
    });
    setQuery("");
    go(id);
  };

  const canBack = nav.i > 0;
  const canForward = nav.i >= 0 && nav.i < nav.stack.length - 1;
  const back = () => {
    if (nav.i <= 0) return;
    const target = nav.stack[nav.i - 1];
    if (target === undefined) return;
    setNav((n) => ({ ...n, i: n.i - 1 }));
    go(target);
  };
  const forward = () => {
    const target = nav.stack[nav.i + 1];
    if (target === undefined) return;
    setNav((n) => ({ ...n, i: n.i + 1 }));
    go(target);
  };
  const upOne = () => {
    if (cwd === null || !fs) return;
    navigate(fs[cwd]?.parent ?? null);
  };

  // ---- mutations (all via ops → synced; all toasted) ----

  const openNode = (node: FSNode) => {
    if (node.kind === "folder") navigate(node.id);
    else openApp("textedit", { fileId: node.id, value: node.content });
  };

  const create = (kind: "file" | "folder") => {
    if (!fs || isTrashView) return;
    const node: FSNode = {
      id: uid(),
      name: uniqueName(fs, cwd, kind),
      kind,
      parent: cwd,
      content: "",
      updatedAt: Date.now(),
    };
    dispatch({ t: "fs:upsert", node });
    pushToast({ title: `Created "${node.name}"`, kind: "success" });
    setSelected(node.id);
    setRenaming(node.id);
    setDraft(node.name);
  };

  const deleteNode = (node: FSNode) => {
    moveToTrash(node);
    pushToast({ title: `"${node.name}" moved to Trash`, body: "Restore it from Trash any time.", kind: "info" });
    if (selected === node.id) setSelected(null);
    if (renaming === node.id) setRenaming(null);
  };

  const startRename = (node: FSNode) => {
    setSelected(node.id);
    setRenaming(node.id);
    setDraft(node.name);
  };

  const commitRename = () => {
    const id = renaming;
    const name = draft.trim();
    setRenaming(null);
    if (!id || !fs) return;
    const node = fs[id];
    if (!node || !name || name === node.name) return;
    if (fsChildren(fs, node.parent).some((n) => n.id !== node.id && n.name === name)) {
      pushToast({ title: `"${name}" is already in use here`, kind: "warn" });
      return;
    }
    dispatch({ t: "fs:upsert", node: { ...node, name, updatedAt: Date.now() } });
    pushToast({ title: `Renamed to "${name}"`, kind: "success" });
  };

  // ---- trash view actions ----

  const restoreNode = (node: FSNode) => {
    const restored = restoreFromTrash(node, DESKTOP_NODE_ID);
    pushToast({ title: `"${restored.name}" restored to Desktop`, kind: "success" });
  };

  const deleteForever = (node: FSNode) => {
    dispatch({ t: "fs:delete", id: node.id });
    pushToast({ title: `"${node.name}" deleted forever`, kind: "danger" });
  };

  const onEmptyClick = () => {
    if (!emptyArmed) {
      setEmptyArmed(true);
      if (emptyTimer.current) clearTimeout(emptyTimer.current);
      emptyTimer.current = setTimeout(() => setEmptyArmed(false), 3000);
      return;
    }
    if (emptyTimer.current) {
      clearTimeout(emptyTimer.current);
      emptyTimer.current = null;
    }
    setEmptyArmed(false);
    const n = emptyTrash();
    pushToast({
      title: "Trash emptied",
      body: n > 0 ? `${n} item${n === 1 ? "" : "s"} deleted forever.` : undefined,
      kind: "danger",
    });
  };

  // arm-timer + Escape cleanup (listener/timeout callbacks with cleanup)
  useEffect(() => {
    return () => {
      if (emptyTimer.current) clearTimeout(emptyTimer.current);
    };
  }, []);
  useEffect(() => {
    if (!propsNode) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setPropsNode(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [propsNode]);

  // ---- context menus ----

  const onItemContextMenu = (e: ReactMouseEvent<HTMLElement>, node: FSNode) => {
    e.preventDefault();
    e.stopPropagation();
    setSelected(node.id);
    openContextMenu(e.clientX, e.clientY, [
      {
        id: "open",
        label: "Open",
        icon: node.kind === "folder" ? <Folder size={13} /> : <FileText size={13} />,
        onSelect: () => openNode(node),
      },
      {
        id: "rename",
        label: "Rename",
        icon: <Pencil size={13} />,
        onSelect: () => startRename(node),
      },
      { id: "sep", separator: true },
      {
        id: "delete",
        label: "Delete",
        icon: <Trash2 size={13} />,
        danger: true,
        onSelect: () => deleteNode(node),
      },
      {
        id: "props",
        label: "Properties",
        icon: <Info size={13} />,
        onSelect: () => setPropsNode(node),
      },
    ]);
  };

  const onTrashItemContextMenu = (e: ReactMouseEvent<HTMLElement>, node: FSNode) => {
    e.preventDefault();
    e.stopPropagation();
    openContextMenu(e.clientX, e.clientY, [
      {
        id: "restore",
        label: "Restore to Desktop",
        icon: <RotateCcw size={13} />,
        onSelect: () => restoreNode(node),
      },
      { id: "sep", separator: true },
      {
        id: "forever",
        label: "Delete forever",
        icon: <Trash2 size={13} />,
        danger: true,
        onSelect: () => deleteForever(node),
      },
    ]);
  };

  const openSortMenu = (e: ReactMouseEvent<HTMLButtonElement>) => {
    const rect = e.currentTarget.getBoundingClientRect(); // captured synchronously
    openContextMenu(
      rect.left,
      rect.bottom + 6,
      (["name", "kind", "modified"] as SortKey[]).map((key) => ({
        id: key,
        label: SORT_LABEL[key],
        icon: sortBy === key ? <Check size={13} /> : undefined,
        onSelect: () => setSortBy(key),
      })),
    );
  };

  if (!fs) return <div className="h-full" />;

  const clearBackground = (e: ReactMouseEvent<HTMLElement>) => {
    if (e.target === e.currentTarget) {
      setSelected(null);
      setRenaming(null);
    }
  };

  const emptyState = isTrashView ? (
    <EmptyState icon={Trash2} title="Trash is empty" hint="Deleted items land here first — nothing is lost until you empty it." />
  ) : query.trim() ? (
    <EmptyState icon={SearchX} title={`No results for "${query.trim()}"`} hint="Try a different name — search filters this folder live." />
  ) : (
    <EmptyState icon={FolderOpen} title="This folder is empty" hint="Create a folder or file — both seats see it instantly." />
  );

  return (
    <div className="flex h-full flex-col">
      <div className="flex min-h-0 flex-1">
        {/* ---------- sidebar ---------- */}
        <aside className="flex w-[164px] shrink-0 flex-col gap-1 border-r border-white/50 bg-white/30 p-2" aria-label="Places">
          <p className="px-2.5 pb-0.5 pt-1 text-[10px] font-semibold uppercase tracking-[0.08em] text-stone-400">Places</p>
          <SidebarButton active={cwd === null} onClick={() => navigate(null)} icon={Home} label="Home" />
          <SidebarButton active={cwd === DESKTOP_NODE_ID} onClick={() => navigate(DESKTOP_NODE_ID)} icon={Monitor} label="Desktop" />
          <SidebarButton
            active={!!docsNode && cwd === docsNode.id}
            onClick={() => navigate(ensureDocuments())}
            icon={FileText}
            label="Documents"
          />
          <SidebarButton active={isTrashView} onClick={() => navigate(ensureTrash().id)} icon={Trash2} label="Trash" badge={trashCount} />
        </aside>

        {/* ---------- main column ---------- */}
        <div className="relative flex min-w-0 flex-1 flex-col">
          <TooltipProvider delayDuration={250}>
            {/* nav row: back / forward / up + breadcrumbs + search */}
            <div className="flex items-center gap-1 border-b border-white/50 bg-white/30 px-3 py-2">
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={back}
                    disabled={!canBack}
                    className="size-9 shrink-0 rounded-xl text-stone-600"
                    aria-label="Go back"
                  >
                    <ChevronLeft className="size-5" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Back</TooltipContent>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={forward}
                    disabled={!canForward}
                    className="size-9 shrink-0 rounded-xl text-stone-600"
                    aria-label="Go forward"
                  >
                    <ChevronRight className="size-5" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Forward</TooltipContent>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={upOne}
                    disabled={cwd === null}
                    className="size-9 shrink-0 rounded-xl text-stone-600"
                    aria-label="Go to parent folder"
                  >
                    <ArrowUp className="size-5" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Up one level</TooltipContent>
              </Tooltip>

              <nav className="gd-mono min-w-0 flex-1 overflow-hidden px-1 text-xs" aria-label="Location">
                <div className="flex items-center gap-0.5">
                  <button
                    type="button"
                    onClick={() => navigate(null)}
                    title="GlassDesk HD"
                    className={`flex shrink-0 items-center gap-1.5 rounded-md px-1.5 py-1.5 transition-colors hover:bg-white/60 hover:text-stone-900 ${
                      cwd === null ? "font-semibold text-stone-700" : "text-stone-600"
                    }`}
                  >
                    <HardDrive className="size-3.5 shrink-0" style={{ color: "var(--gd-accent)" }} />
                    <span>GlassDesk HD</span>
                  </button>
                  {ancestors.map((node, idx) => {
                    const isCurrent = idx === ancestors.length - 1;
                    return (
                      <span key={node.id} className="flex min-w-0 items-center gap-0.5">
                        <ChevronRight className="size-3 shrink-0 text-stone-300" />
                        <button
                          type="button"
                          onClick={() => navigate(node.id)}
                          title={node.name}
                          className={`min-w-0 truncate rounded-md px-1.5 py-1.5 transition-colors hover:bg-white/60 hover:text-stone-900 ${
                            isCurrent ? "font-semibold text-stone-700" : "text-stone-500"
                          }`}
                        >
                          {node.name}
                        </button>
                      </span>
                    );
                  })}
                </div>
              </nav>

              <div className="relative shrink-0">
                <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-stone-400" />
                <Input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Search"
                  aria-label="Filter items by name"
                  className="h-8 w-36 border-white/60 bg-white/60 pl-8 pr-7 text-xs"
                />
                {query ? (
                  <button
                    type="button"
                    onClick={() => setQuery("")}
                    aria-label="Clear search"
                    className="absolute right-1 top-1/2 grid size-6 -translate-y-1/2 place-items-center rounded-md text-stone-400 transition-colors hover:bg-white/70 hover:text-stone-600"
                  >
                    <X className="size-3" />
                  </button>
                ) : null}
              </div>
            </div>

            {/* actions row: new folder / new file · view toggle · sort */}
            <div className="flex items-center gap-1.5 border-b border-white/50 bg-white/20 px-3 py-1.5">
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => create("folder")}
                    disabled={isTrashView}
                    className="h-8 gap-1.5 rounded-lg px-2 text-stone-600"
                    aria-label="New folder"
                  >
                    <FolderPlus className="size-4" />
                    <span className="hidden md:inline">New Folder</span>
                  </Button>
                </TooltipTrigger>
                <TooltipContent>New folder</TooltipContent>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => create("file")}
                    disabled={isTrashView}
                    className="h-8 gap-1.5 rounded-lg px-2 text-stone-600"
                    aria-label="New file"
                  >
                    <FilePlus2 className="size-4" />
                    <span className="hidden md:inline">New File</span>
                  </Button>
                </TooltipTrigger>
                <TooltipContent>New text file</TooltipContent>
              </Tooltip>

              <div className="ml-auto flex items-center gap-1.5">
                <div className="flex items-center rounded-xl bg-white/40 p-0.5" role="group" aria-label="View mode">
                  <button
                    type="button"
                    onClick={() => setView("grid")}
                    aria-label="Grid view"
                    aria-pressed={view === "grid"}
                    className={`grid size-7 place-items-center rounded-lg transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--gd-accent)] ${
                      view === "grid" ? "bg-white/85 shadow-sm" : "text-stone-500 hover:bg-white/60"
                    }`}
                    style={view === "grid" ? { color: "var(--gd-accent)" } : undefined}
                  >
                    <LayoutGrid className="size-4" />
                  </button>
                  <button
                    type="button"
                    onClick={() => setView("list")}
                    aria-label="List view"
                    aria-pressed={view === "list"}
                    className={`grid size-7 place-items-center rounded-lg transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--gd-accent)] ${
                      view === "list" ? "bg-white/85 shadow-sm" : "text-stone-500 hover:bg-white/60"
                    }`}
                    style={view === "list" ? { color: "var(--gd-accent)" } : undefined}
                  >
                    <List className="size-4" />
                  </button>
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={openSortMenu}
                  className="h-8 gap-1.5 rounded-lg px-2 text-stone-600"
                  aria-label={`Sort items by ${SORT_LABEL[sortBy]}`}
                >
                  <ArrowDownWideNarrow className="size-4" />
                  <span className="hidden md:inline">{SORT_LABEL[sortBy]}</span>
                </Button>
              </div>
            </div>
          </TooltipProvider>

          {/* ---------- content ---------- */}
          {isTrashView ? (
            <div className="flex min-h-0 flex-1 flex-col">
              <div className="flex items-center gap-2.5 border-b border-white/50 bg-white/30 px-3 py-2">
                <Info className="size-4 shrink-0 text-stone-400" />
                <p className="min-w-0 flex-1 truncate text-xs text-stone-500">
                  Items in Trash stay until emptied — restore anything you still need.
                </p>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={onEmptyClick}
                  disabled={trashCount === 0}
                  className={`h-8 shrink-0 gap-1.5 rounded-lg px-2.5 ${
                    emptyArmed
                      ? "bg-rose-500/15 font-semibold text-rose-600 hover:bg-rose-500/25"
                      : "text-rose-500 hover:bg-rose-500/10 hover:text-rose-600"
                  }`}
                  aria-label={emptyArmed ? "Really empty the Trash" : "Empty the Trash"}
                >
                  <Trash2 className="size-4" />
                  {emptyArmed ? "Really empty?" : "Empty Trash"}
                </Button>
              </div>
              <div className="gd-scroll min-h-0 flex-1 overflow-y-auto">
                {visible.length === 0 ? (
                  emptyState
                ) : (
                  <div className="space-y-1 p-3">
                    {visible.map((node) => (
                      <motion.div
                        key={node.id}
                        initial={{ opacity: 0, y: 4 }}
                        animate={{ opacity: 1, y: 0 }}
                        transition={SPRING}
                        onContextMenu={(e) => onTrashItemContextMenu(e, node)}
                        className="group flex min-h-12 cursor-default select-none items-center gap-3 rounded-lg px-3 py-2 transition-colors hover:bg-white/60"
                      >
                        <span className={`grid size-8 shrink-0 place-items-center rounded-lg bg-gradient-to-br ${tileFor(node)} text-white shadow-sm`}>
                          {node.kind === "folder" ? <Folder size={16} strokeWidth={2} /> : <FileText size={15} strokeWidth={2} />}
                        </span>
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-sm text-stone-700">{node.name}</div>
                          <div className="gd-mono text-[11px] text-stone-400">
                            {node.kind === "folder" ? `${childCounts[node.id] ?? 0} item${(childCounts[node.id] ?? 0) === 1 ? "" : "s"}` : `${node.content.length} B`}
                            {" · "}
                            {fmtWhen(node.updatedAt)}
                          </div>
                        </div>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => restoreNode(node)}
                          className="h-8 shrink-0 gap-1.5 rounded-lg px-2.5 text-stone-600 opacity-70 transition-opacity hover:bg-white/70 hover:opacity-100"
                          aria-label={`Restore ${node.name} to Desktop`}
                        >
                          <RotateCcw className="size-4" />
                          <span className="hidden sm:inline">Restore</span>
                        </Button>
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <Button
                              variant="ghost"
                              size="icon"
                              onClick={() => deleteForever(node)}
                              className="size-8 shrink-0 rounded-lg text-rose-500 opacity-70 transition-opacity hover:bg-rose-500/10 hover:text-rose-600 hover:opacity-100"
                              aria-label={`Delete ${node.name} forever`}
                            >
                              <Trash2 className="size-4" />
                            </Button>
                          </TooltipTrigger>
                          <TooltipContent>Delete forever</TooltipContent>
                        </Tooltip>
                      </motion.div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          ) : (
            <div className="gd-scroll min-h-0 flex-1 overflow-y-auto">
              {visible.length === 0 ? (
                emptyState
              ) : view === "grid" ? (
                <div
                  className="grid grid-cols-[repeat(auto-fill,minmax(104px,1fr))] gap-2 p-3"
                  onClick={clearBackground}
                >
                  {visible.map((node) => (
                    <motion.div
                      key={node.id}
                      role="button"
                      tabIndex={0}
                      aria-label={`${node.name}, ${node.kind}`}
                      initial={{ opacity: 0, y: 6, scale: 0.96 }}
                      animate={{ opacity: 1, y: 0, scale: 1 }}
                      transition={SPRING}
                      onClick={() => {
                        setSelected(node.id);
                        if (renaming !== node.id) setRenaming(null);
                      }}
                      onDoubleClick={() => {
                        if (renaming !== node.id) openNode(node);
                      }}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          if (renaming !== node.id) openNode(node);
                        }
                      }}
                      onContextMenu={(e) => onItemContextMenu(e, node)}
                      className={`flex min-h-24 cursor-pointer select-none flex-col items-center gap-2 rounded-xl p-2.5 text-center transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--gd-accent)] ${
                        selected === node.id ? "bg-white/75 ring-2 ring-[var(--gd-accent)]" : "hover:bg-white/55"
                      }`}
                    >
                      <span className={`grid size-12 shrink-0 place-items-center rounded-2xl bg-gradient-to-br ${tileFor(node)} text-white shadow-md`}>
                        {node.kind === "folder" ? <Folder size={24} strokeWidth={2} /> : <FileText size={22} strokeWidth={2} />}
                      </span>
                      {renaming === node.id ? (
                        <RenameBox value={draft} onChange={setDraft} onCommit={commitRename} onCancel={() => setRenaming(null)} center />
                      ) : (
                        <span className="line-clamp-2 w-full min-w-0 break-words rounded-md px-0.5 text-xs font-medium leading-tight text-stone-700">
                          {node.name}
                        </span>
                      )}
                    </motion.div>
                  ))}
                </div>
              ) : (
                <div className="space-y-1 p-3" onClick={clearBackground}>
                  {visible.map((node) => (
                    <motion.div
                      key={node.id}
                      role="button"
                      tabIndex={0}
                      aria-label={`${node.name}, ${node.kind}`}
                      initial={{ opacity: 0, y: 3 }}
                      animate={{ opacity: 1, y: 0 }}
                      transition={SPRING}
                      onClick={() => {
                        setSelected(node.id);
                        if (renaming !== node.id) setRenaming(null);
                      }}
                      onDoubleClick={() => {
                        if (renaming !== node.id) openNode(node);
                      }}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          if (renaming !== node.id) openNode(node);
                        }
                      }}
                      onContextMenu={(e) => onItemContextMenu(e, node)}
                      className={`group flex min-h-11 cursor-pointer select-none items-center gap-3 rounded-lg px-3 py-2 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--gd-accent)] ${
                        selected === node.id ? "bg-white/75" : "hover:bg-white/60"
                      }`}
                      style={selected === node.id ? { boxShadow: "inset 0 0 0 1.5px var(--gd-accent)" } : undefined}
                    >
                      {node.kind === "folder" ? (
                        <Folder className="size-5 shrink-0 text-amber-400" />
                      ) : (
                        <FileText className="size-5 shrink-0 text-teal-500" />
                      )}
                      <div className="min-w-0 flex-1">
                        {renaming === node.id ? (
                          <RenameBox value={draft} onChange={setDraft} onCommit={commitRename} onCancel={() => setRenaming(null)} />
                        ) : (
                          <div className="truncate text-sm text-stone-700">{node.name}</div>
                        )}
                      </div>
                      <span className="gd-mono w-20 shrink-0 text-right text-xs text-stone-400">
                        {node.kind === "folder" ? `${childCounts[node.id] ?? 0} items` : `${node.content.length} B`}
                      </span>
                      <span className="gd-mono hidden w-16 shrink-0 text-right text-xs text-stone-400 sm:block">
                        {fmtWhen(node.updatedAt)}
                      </span>
                      <div className="flex w-9 shrink-0 items-center justify-center">
                        {renaming !== node.id && (
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              startRename(node);
                            }}
                            className="grid size-9 place-items-center rounded-lg text-stone-400 opacity-0 transition-opacity hover:bg-white/70 hover:text-stone-600 focus-visible:opacity-100 group-hover:opacity-100"
                            aria-label={`Rename ${node.name}`}
                          >
                            <Pencil className="size-4" />
                          </button>
                        )}
                      </div>
                    </motion.div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* ---------- properties popover ---------- */}
          <AnimatePresence>
            {propsNode ? (
              <motion.div
                key="props-overlay"
                className="absolute inset-0 z-30 flex items-center justify-center bg-stone-900/15 p-6"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                onPointerDown={(e) => {
                  if (e.target === e.currentTarget) setPropsNode(null);
                }}
              >
                <motion.div
                  role="dialog"
                  aria-label={`Properties of ${propsNode.name}`}
                  initial={{ scale: 0.92, y: 10, opacity: 0 }}
                  animate={{ scale: 1, y: 0, opacity: 1 }}
                  exit={{ scale: 0.95, y: 6, opacity: 0 }}
                  transition={SPRING}
                  className="glass-strong w-72 max-w-full rounded-2xl p-4"
                >
                  <div className="flex items-start gap-3">
                    <span className={`grid size-10 shrink-0 place-items-center rounded-xl bg-gradient-to-br ${tileFor(propsNode)} text-white shadow-md`}>
                      {propsNode.kind === "folder" ? <Folder size={20} /> : <FileText size={18} />}
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-semibold text-stone-700">{propsNode.name}</p>
                      <p className="text-xs text-stone-400">{propsNode.kind === "folder" ? "Folder" : "File"}</p>
                    </div>
                    <button
                      type="button"
                      onClick={() => setPropsNode(null)}
                      aria-label="Close properties"
                      className="grid size-7 shrink-0 place-items-center rounded-lg text-stone-400 transition-colors hover:bg-white/70 hover:text-stone-600"
                    >
                      <X className="size-4" />
                    </button>
                  </div>
                  <dl className="mt-3 space-y-1.5 border-t border-white/60 pt-3 text-xs">
                    <div className="flex gap-2">
                      <dt className="w-16 shrink-0 text-stone-400">Path</dt>
                      <dd className="gd-mono min-w-0 flex-1 break-all text-stone-600">{fsPathOf(fs, propsNode.id)}</dd>
                    </div>
                    <div className="flex gap-2">
                      <dt className="w-16 shrink-0 text-stone-400">Kind</dt>
                      <dd className="min-w-0 flex-1 text-stone-600">{propsNode.kind === "folder" ? "Folder" : "Plain text file"}</dd>
                    </div>
                    <div className="flex gap-2">
                      <dt className="w-16 shrink-0 text-stone-400">Size</dt>
                      <dd className="gd-mono min-w-0 flex-1 text-stone-600">
                        {propsNode.kind === "folder"
                          ? `${childCounts[propsNode.id] ?? 0} item${(childCounts[propsNode.id] ?? 0) === 1 ? "" : "s"}`
                          : `${propsNode.content.length} B`}
                      </dd>
                    </div>
                    <div className="flex gap-2">
                      <dt className="w-16 shrink-0 text-stone-400">Modified</dt>
                      <dd className="min-w-0 flex-1 text-stone-600">
                        {new Date(propsNode.updatedAt).toLocaleString()}{" "}
                        <span className="text-stone-400">({fmtWhen(propsNode.updatedAt)})</span>
                      </dd>
                    </div>
                  </dl>
                </motion.div>
              </motion.div>
            ) : null}
          </AnimatePresence>
        </div>
      </div>
    </div>
  );
}
