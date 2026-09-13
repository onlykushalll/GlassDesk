import { describe, it, expect } from "bun:test";
import { applyOp, freshDesktop, type Op } from "../src/lib/vpc/types";

describe("GlassDesk Multi-Seat Concurrency & State Convergence", () => {
  it("should converge to identical state regardless of message interleaving", () => {
    const base = freshDesktop({ code: "778899", ramMB: 2048 });

    const seat1Ops: Op[] = [
      {
        t: "win:open",
        win: {
          id: "win-terminal",
          kind: "terminal",
          title: "Shared Terminal",
          x: 50,
          y: 50,
          w: 600,
          h: 400,
          z: 1,
          minimized: false,
          maximized: false,
          workspace: 0,
          payload: {},
        },
      },
      { t: "chat", msg: { id: "c1", seat: "seat-1", text: "Opening terminal...", at: 100 } },
    ];

    const seat2Ops: Op[] = [
      {
        t: "win:open",
        win: {
          id: "win-taskmgr",
          kind: "taskmgr",
          title: "Task Manager",
          x: 100,
          y: 100,
          w: 500,
          h: 350,
          z: 2,
          minimized: false,
          maximized: false,
          workspace: 0,
          payload: {},
        },
      },
      { t: "chat", msg: { id: "c2", seat: "seat-2", text: "Opening task manager.", at: 105 } },
    ];

    // Sequence A: Seat 1 then Seat 2
    let stateA = base;
    for (const op of [...seat1Ops, ...seat2Ops]) stateA = applyOp(stateA, op);

    // Sequence B: Interleaved (Seat 1 -> Seat 2 -> Seat 1 -> Seat 2)
    let stateB = base;
    const interleaved = [seat1Ops[0], seat2Ops[0], seat1Ops[1], seat2Ops[1]];
    for (const op of interleaved) stateB = applyOp(stateB, op);

    // Verify both sequences contain the same windows and chat messages
    expect(stateA.windows.length).toBe(stateB.windows.length);
    expect(stateA.windows.map((w) => w.id).sort()).toEqual(stateB.windows.map((w) => w.id).sort());
    expect(stateA.chat.length).toBe(stateB.chat.length);
  });

  it("should handle simultaneous window focus requests with monotonic z-index ordering", () => {
    let state = freshDesktop({ code: "334455", ramMB: 2048 });

    // Open two windows
    state = applyOp(state, {
      t: "win:open",
      win: { id: "w1", kind: "code", title: "Code", x: 0, y: 0, w: 400, h: 300, z: 1, minimized: false, maximized: false, workspace: 0, payload: {} },
    });
    state = applyOp(state, {
      t: "win:open",
      win: { id: "w2", kind: "whiteboard", title: "Board", x: 50, y: 50, w: 400, h: 300, z: 2, minimized: false, maximized: false, workspace: 0, payload: {} },
    });

    // Seat 1 focuses w1, Seat 2 immediately focuses w2
    state = applyOp(state, { t: "win:z", id: "w1", z: 10 });
    state = applyOp(state, { t: "win:z", id: "w2", z: 11 });

    const w1 = state.windows.find((w) => w.id === "w1");
    const w2 = state.windows.find((w) => w.id === "w2");

    expect(w1?.z).toBe(10);
    expect(w2?.z).toBe(11);
    expect(w2!.z).toBeGreaterThan(w1!.z);
  });
});
