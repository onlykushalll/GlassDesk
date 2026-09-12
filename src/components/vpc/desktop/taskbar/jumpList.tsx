"use client";

// ============================================================
// GlassDesk taskbar — JUMP LISTS (Windows 11 grade).
// buildAppJumpList() returns MenuItem[] for the singleton
// ContextMenuHost (openContextMenu at the pointer — viewport-
// clamped, spring-animated, Escape-dismissed for free).
//
// Called at right-click time with LIVE state via ctx, so entries
// are always fresh. The registry meta + actions arrive through
// ctx (AppMeta is a type-only import) — zero runtime imports
// from Dock.tsx → no import cycles.
//
// Layout:  [header: app icon + name + open count]
//          [recent items] (textedit: 4 recent files by updatedAt,
//                         files: 4 recent folders) + separator
//          New window · separator · Close all windows (danger)
// ============================================================

import { Plus, X } from "lucide-react";
import { AppIcon } from "@/components/vpc/icons/AppIcon";
import type { MenuItem } from "../ContextMenu";
import { TRASH_ID } from "@/lib/vpc/trash";
import type { AppKind, FSMap, FSNode, WindowState } from "@/lib/vpc/types";
import type { AppMeta } from "../Dock";

const RECENT_CAP = 4;

export interface JumpListCtx {
  meta: AppMeta;
  /** the app's live windows (for the header count + close-all) */
  wins: WindowState[];
  /** live filesystem — recents are derived from updatedAt */
  fs: FSMap;
  /** always spawns a FRESH instance (openApp would reuse) */
  openNew: (app: AppKind) => void;
  /** opens a recent fs node in this app (already specialized) */
  openRecent: (node: FSNode) => void;
  /** closes every window of this app (win:close each) */
  closeAll: () => void;
}

export function buildAppJumpList(app: AppKind, ctx: JumpListCtx): MenuItem[] {
  const items: MenuItem[] = [
    {
      id: "hdr",
      icon: <AppIcon id={app} size={18} />,
      label: `${ctx.meta.label}${ctx.wins.length ? ` · ${ctx.wins.length} open` : ""}`,
      onSelect: () => {}, // header row — presentational
    },
    { id: "sep-hdr", separator: true },
  ];

  // app-specific recents — textedit: files, files: folders
  if (app === "textedit" || app === "files") {
    const kind: "file" | "folder" = app === "textedit" ? "file" : "folder";
    const recents = Object.values(ctx.fs)
      .filter((n) => n.kind === kind && n.parent !== TRASH_ID && n.id !== TRASH_ID)
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, RECENT_CAP);
    for (const n of recents) {
      items.push({
        id: `recent-${n.id}`,
        icon: <AppIcon id={kind === "file" ? "text" : "folder"} size={18} />,
        label: n.name,
        onSelect: () => ctx.openRecent(n),
      });
    }
    if (recents.length > 0) items.push({ id: "sep-recent", separator: true });
  }

  items.push(
    {
      id: "new-window",
      icon: <Plus size={14} />,
      label: "New window",
      onSelect: () => ctx.openNew(app),
    },
    { id: "sep-tail", separator: true },
    {
      id: "close-all",
      icon: <X size={14} />,
      label: "Close all windows",
      danger: true,
      disabled: ctx.wins.length === 0,
      onSelect: () => ctx.closeAll(),
    },
  );

  return items;
}
