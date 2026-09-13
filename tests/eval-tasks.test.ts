import { describe, it, expect } from "bun:test";
import { applyOp, freshDesktop, type DesktopState } from "../src/lib/vpc/types";

/**
 * GlassDesk SWE Evaluation Task Benchmark Suite
 * Verifies autonomous coding agent problem-solving capabilities
 * against real-world distributed systems challenges.
 */
describe("GlassDesk SWE Agent Evaluation Tasks", () => {
  // Task 1: Recursive VFS Cleanup on Workspace Reset
  it("Task 1 (SWE-EVAL-01): Should recursively delete deep nested directory hierarchies without leaving orphaned inodes", () => {
    let state = freshDesktop({ code: "556677", ramMB: 2048 });

    // Build 3-level deep directory tree
    state = applyOp(state, {
      t: "fs:upsert",
      node: { id: "root-dir", name: "workspace", kind: "folder", parent: null, content: "", updatedAt: 1 },
    });
    state = applyOp(state, {
      t: "fs:upsert",
      node: { id: "sub-dir", name: "src", kind: "folder", parent: "root-dir", content: "", updatedAt: 2 },
    });
    state = applyOp(state, {
      t: "fs:upsert",
      node: { id: "file-leaf", name: "index.ts", kind: "file", parent: "sub-dir", content: "console.log('hi')", updatedAt: 3 },
    });

    expect(state.fs["root-dir"]).toBeDefined();
    expect(state.fs["sub-dir"]).toBeDefined();
    expect(state.fs["file-leaf"]).toBeDefined();

    // Agent Action: Delete root directory
    state = applyOp(state, { t: "fs:delete", id: "root-dir" });

    // Verifier Assertion: All descendants must be recursively purged
    expect(state.fs["root-dir"]).toBeUndefined();
    expect(state.fs["sub-dir"]).toBeUndefined();
    expect(state.fs["file-leaf"]).toBeUndefined();
  });

  // Task 2: State Immutability & Defensiveness
  it("Task 2 (SWE-EVAL-02): Reducer must return exact reference on invalid/unknown ops to avoid redundant React re-renders", () => {
    const state = freshDesktop({ code: "889900", ramMB: 2048 });

    // Dispatch invalid operation
    const nextState = applyOp(state, { t: "unknown_op" } as any);

    // Verifier Assertion: Reference identity must be preserved
    expect(nextState).toBe(state);
  });

  // Task 3: Multi-Workspace Boundary Enforcement
  it("Task 3 (SWE-EVAL-03): Window workspace migration must be clamped within WORKSPACES bounds (0..3)", () => {
    let state = freshDesktop({ code: "445566", ramMB: 2048 });

    state = applyOp(state, {
      t: "win:open",
      win: { id: "w-ws", kind: "terminal", title: "Shell", x: 0, y: 0, w: 200, h: 200, z: 1, minimized: false, maximized: false, workspace: 0, payload: {} },
    });

    // Attempt to set out-of-bounds workspace (> 3)
    state = applyOp(state, { t: "win:ws", id: "w-ws", ws: 99 });
    expect(state.windows.find((w) => w.id === "w-ws")?.workspace).toBe(3);

    // Attempt to set negative workspace (< 0)
    state = applyOp(state, { t: "win:ws", id: "w-ws", ws: -10 });
    expect(state.windows.find((w) => w.id === "w-ws")?.workspace).toBe(0);
  });
});
