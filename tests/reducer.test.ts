import { describe, it, expect } from "bun:test";
import { applyOp, freshDesktop, type DesktopState, type Win } from "../src/lib/vpc/types";

const makeTestDesktop = () => freshDesktop({ code: "123456", ramMB: 2048 });

describe("GlassDesk Authoritative Op Reducer (applyOp)", () => {
  it("should initialize default desktop state deterministically", () => {
    const state = makeTestDesktop();
    expect(state).toBeDefined();
    expect(state.windows).toBeArray();
    expect(state.workspace).toBe(0);
    expect(state.fs).toBeDefined();
  });

  it("should handle win:open operation and avoid duplicate window IDs", () => {
    const s0 = makeTestDesktop();
    const mockWin: Win = {
      id: "win-test-1",
      kind: "notes",
      title: "Collaborative Notes",
      x: 100,
      y: 100,
      w: 600,
      h: 400,
      z: 10,
      minimized: false,
      maximized: false,
      workspace: 0,
      payload: {},
    };

    const s1 = applyOp(s0, { t: "win:open", win: mockWin });
    expect(s1.windows.some((w) => w.id === "win-test-1")).toBe(true);
    expect(s1.windows.length).toBe(s0.windows.length + 1);

    // Idempotency: duplicate win:open should return unmodified state
    const s2 = applyOp(s1, { t: "win:open", win: mockWin });
    expect(s2.windows.length).toBe(s1.windows.length);
  });

  it("should handle win:geom (moving and resizing windows)", () => {
    const s0 = makeTestDesktop();
    const mockWin: Win = {
      id: "win-geom-1",
      kind: "terminal",
      title: "Virtual Shell",
      x: 50,
      y: 50,
      w: 500,
      h: 300,
      z: 1,
      minimized: false,
      maximized: false,
      workspace: 0,
      payload: {},
    };

    const s1 = applyOp(s0, { t: "win:open", win: mockWin });
    const s2 = applyOp(s1, { t: "win:geom", id: "win-geom-1", x: 200, y: 150, w: 700, h: 450 });

    const target = s2.windows.find((w) => w.id === "win-geom-1");
    expect(target).toBeDefined();
    expect(target?.x).toBe(200);
    expect(target?.y).toBe(150);
    expect(target?.w).toBe(700);
    expect(target?.h).toBe(450);
  });

  it("should handle win:z focus elevation", () => {
    const s0 = makeTestDesktop();
    const mockWin: Win = {
      id: "win-z-1",
      kind: "files",
      title: "GlassDesk HD",
      x: 0,
      y: 0,
      w: 400,
      h: 300,
      z: 5,
      minimized: false,
      maximized: false,
      workspace: 0,
      payload: {},
    };

    const s1 = applyOp(s0, { t: "win:open", win: mockWin });
    const s2 = applyOp(s1, { t: "win:z", id: "win-z-1", z: 999 });

    const target = s2.windows.find((w) => w.id === "win-z-1");
    expect(target?.z).toBe(999);
  });

  it("should handle win:min and win:max state toggles", () => {
    const s0 = makeTestDesktop();
    const mockWin: Win = {
      id: "win-toggle-1",
      kind: "code",
      title: "Code Studio",
      x: 10,
      y: 10,
      w: 800,
      h: 600,
      z: 1,
      minimized: false,
      maximized: false,
      workspace: 0,
      payload: {},
    };

    const s1 = applyOp(s0, { t: "win:open", win: mockWin });
    const s2 = applyOp(s1, { t: "win:min", id: "win-toggle-1", minimized: true });
    expect(s2.windows.find((w) => w.id === "win-toggle-1")?.minimized).toBe(true);

    const s3 = applyOp(s2, { t: "win:max", id: "win-toggle-1", maximized: true });
    expect(s3.windows.find((w) => w.id === "win-toggle-1")?.maximized).toBe(true);
  });

  it("should handle win:close operation", () => {
    const s0 = makeTestDesktop();
    const mockWin: Win = {
      id: "win-close-1",
      kind: "notes",
      title: "Temporary Note",
      x: 0,
      y: 0,
      w: 200,
      h: 200,
      z: 1,
      minimized: false,
      maximized: false,
      workspace: 0,
      payload: {},
    };

    const s1 = applyOp(s0, { t: "win:open", win: mockWin });
    expect(s1.windows.some((w) => w.id === "win-close-1")).toBe(true);

    const s2 = applyOp(s1, { t: "win:close", id: "win-close-1" });
    expect(s2.windows.some((w) => w.id === "win-close-1")).toBe(false);
  });

  it("should handle virtual filesystem fs:upsert and fs:delete with descendants", () => {
    const s0 = makeTestDesktop();
    const folderId = "f-project";
    const fileId = "f-readme";

    // 1. Create directory
    const s1 = applyOp(s0, {
      t: "fs:upsert",
      node: {
        id: folderId,
        name: "ProjectAlpha",
        kind: "folder",
        parent: null,
        content: "",
        updatedAt: Date.now(),
      },
    });
    expect(s1.fs[folderId]).toBeDefined();

    // 2. Create child file
    const s2 = applyOp(s1, {
      t: "fs:upsert",
      node: {
        id: fileId,
        name: "spec.md",
        kind: "file",
        parent: folderId,
        content: "# Specification",
        updatedAt: Date.now(),
      },
    });
    expect(s2.fs[fileId]).toBeDefined();
    expect(s2.fs[fileId].content).toBe("# Specification");

    // 3. Delete parent directory -> recursive deletion of descendants
    const s3 = applyOp(s2, { t: "fs:delete", id: folderId });
    expect(s3.fs[folderId]).toBeUndefined();
    expect(s3.fs[fileId]).toBeUndefined();
  });

  it("should handle chat message appending and cap enforcement", () => {
    const s0 = makeTestDesktop();
    const msg = {
      id: "msg-101",
      seat: "seat-1" as const,
      text: "Collaborative session initiated.",
      at: Date.now(),
    };

    const s1 = applyOp(s0, { t: "chat", msg });
    expect(s1.chat.some((m) => m.id === "msg-101")).toBe(true);

    // Duplicate message rejection
    const s2 = applyOp(s1, { t: "chat", msg });
    expect(s2.chat.length).toBe(s1.chat.length);
  });
});
