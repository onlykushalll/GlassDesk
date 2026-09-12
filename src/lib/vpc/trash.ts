"use client";

// ============================================================
// GlassDesk — Trash. A real folder node ("f-trash") living at the
// volume root, so trashing/restore/empty ride the EXISTING ops
// (fs:upsert / fs:delete) and sync to both seats + snapshots with
// zero schema changes. The Trash folder is hidden from the root
// listing by FilesApp (Finder-style) and is never deleted itself —
// only its children are.
//
// All helpers read state synchronously from useGlassDesk.getState()
// so they are safe to call from event handlers, context-menu
// callbacks and other modules (DesktopIcons, Desktop, …).
// ============================================================

import { useGlassDesk } from "./store";
import { fsChildren, type FSMap, type FSNode } from "./types";

/** The Trash folder node id (deterministic — both seats converge). */
export const TRASH_ID = "f-trash";

/** The seeded-style Documents folder id (deterministic, same idea). */
export const DOCS_ID = "f-docs";

/** Create the Trash folder if it doesn't exist yet; returns the node
 *  (a detached stub when no session is live — dispatch is skipped). */
export function ensureTrash(): FSNode {
  const s = useGlassDesk.getState();
  const existing = s.state?.fs[TRASH_ID];
  if (existing) return existing;
  const node: FSNode = {
    id: TRASH_ID,
    name: "Trash",
    kind: "folder",
    parent: null,
    content: "",
    updatedAt: Date.now(),
  };
  if (s.state) s.dispatch({ t: "fs:upsert", node });
  return node;
}

/** Move a node (with all its descendants) into the Trash — name kept. */
export function moveToTrash(node: FSNode): void {
  if (node.id === TRASH_ID) return; // never trash the Trash itself
  const s = useGlassDesk.getState();
  if (!s.state) return;
  ensureTrash();
  if (node.parent === TRASH_ID) return; // already in the Trash
  s.dispatch({ t: "fs:upsert", node: { ...node, parent: TRASH_ID, updatedAt: Date.now() } });
}

/** Children of the Trash folder (folders first, then alphabetical). */
export function trashNodes(fs: FSMap): FSNode[] {
  return fsChildren(fs, TRASH_ID);
}

/** Restore a node out of the Trash under `targetParent`. Name conflicts
 *  are resolved by appending " (restored)" (repeatedly if needed).
 *  Returns the restored node (name may differ from the input). */
export function restoreFromTrash(node: FSNode, targetParent: string | null): FSNode {
  const s = useGlassDesk.getState();
  const fs = s.state?.fs;
  let parent = targetParent;
  if (parent === TRASH_ID) parent = null; // restoring into Trash is a no-op shape
  if (parent && (!fs || !fs[parent] || fs[parent].kind !== "folder")) parent = null; // vanished target → root
  let name = node.name;
  if (fs) {
    const taken = new Set(
      fsChildren(fs, parent)
        .filter((n) => n.id !== node.id)
        .map((n) => n.name.toLowerCase()),
    );
    while (taken.has(name.toLowerCase())) name = `${name} (restored)`;
  }
  const restored: FSNode = { ...node, name, parent, updatedAt: Date.now() };
  if (s.state) s.dispatch({ t: "fs:upsert", node: restored });
  return restored;
}

/** Delete every Trash child (with descendants) forever.
 *  Returns how many top-level items were removed. */
export function emptyTrash(): number {
  const s = useGlassDesk.getState();
  const fs = s.state?.fs;
  if (!fs) return 0;
  const kids = fsChildren(fs, TRASH_ID);
  for (const kid of kids) s.dispatch({ t: "fs:delete", id: kid.id });
  return kids.length;
}

/** Find (or create once, deterministically) the ~/Documents folder.
 *  seedFS currently has no Documents node, so FilesApp's sidebar calls
 *  this on click; the fixed id means both seats converge on one folder. */
export function ensureDocuments(): string {
  const s = useGlassDesk.getState();
  const fs = s.state?.fs;
  if (fs) {
    const existing = Object.values(fs).find(
      (n) => n.parent === null && n.name === "Documents" && n.kind === "folder" && n.id !== TRASH_ID,
    );
    if (existing) return existing.id;
    if (fs[DOCS_ID]) return DOCS_ID;
  }
  const node: FSNode = {
    id: DOCS_ID,
    name: "Documents",
    kind: "folder",
    parent: null,
    content: "",
    updatedAt: Date.now(),
  };
  if (s.state) s.dispatch({ t: "fs:upsert", node });
  return node.id;
}
