"use client";

// ============================================================
// GlassDesk — Minesweeper. The board is SYNCED across both
// seats: every discrete move (reveal / flag / chord / new
// game / difficulty) patches the payload, so the co-pilot
// watches the same minefield live.
//
// Payload (compact + JSON-safe, Hard board ≈ 300 bytes):
//   status: "new" | "playing" | "won" | "lost"
//   diff:   "easy" | "medium" | "hard"
//   board:  string[] | null   — one row per string, ONE char
//           per cell:
//             "." unrevealed safe     "m" unrevealed mine
//             "f" flagged safe        "F" flagged mine
//             "x" the FATAL mine      "0"-"8" revealed count
//           status "new" ⇒ board is null (mines are placed
//           only after the first reveal — first click safe).
// High-frequency data (the timer) stays LOCAL per seat.
// ============================================================

import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Bomb, Flag, RotateCcw, Timer, Trophy, X } from "lucide-react";
import { useGlassDesk } from "@/lib/vpc/store";
import { pushToast } from "@/lib/vpc/toast";
import type { WindowState } from "@/lib/vpc/types";

type Diff = "easy" | "medium" | "hard";
type Status = "new" | "playing" | "won" | "lost";
type Cell = [number, number];

const DIFFS: Record<Diff, { label: string; rows: number; cols: number; mines: number }> = {
  easy: { label: "Easy 9×9", rows: 9, cols: 9, mines: 10 },
  medium: { label: "Medium 12×12", rows: 12, cols: 12, mines: 24 },
  hard: { label: "Hard 16×16", rows: 16, cols: 16, mines: 46 },
};

const SPRING = { type: "spring", stiffness: 420, damping: 28 } as const;
const CONFETTI = ["#14b8a6", "#10b981", "#f59e0b", "#f43f5e", "#34d399"];

const NUM_COLOR: Record<string, string> = {
  "1": "text-teal-600",
  "2": "text-emerald-600",
  "3": "text-amber-600",
  "4": "text-rose-600",
  "5": "text-stone-700",
  "6": "text-stone-700",
  "7": "text-stone-700",
  "8": "text-stone-700",
};

// ---------------- board engine (pure, syncable) ----------------

function isRevealed(ch: string): boolean {
  return ch >= "0" && ch <= "8";
}

function neighborsOf(r: number, c: number, rows: number, cols: number): Cell[] {
  const out: Cell[] = [];
  for (let dr = -1; dr <= 1; dr++) {
    for (let dc = -1; dc <= 1; dc++) {
      if (dr === 0 && dc === 0) continue;
      const nr = r + dr;
      const nc = c + dc;
      if (nr < 0 || nr >= rows || nc < 0 || nc >= cols) continue;
      out.push([nr, nc]);
    }
  }
  return out;
}

/** Fresh pristine board — NO mines yet (first-click safety). */
function emptyBoard(rows: number, cols: number): string[] {
  return Array.from({ length: rows }, () => ".".repeat(cols));
}

/** Place mines after the first click, excluding the 3×3 around it. */
function makeBoard(rows: number, cols: number, mines: number, sr: number, sc: number): string[] {
  const excl = new Set<number>([sr * cols + sc]);
  for (const [r, c] of neighborsOf(sr, sc, rows, cols)) excl.add(r * cols + c);
  const pool: number[] = [];
  for (let i = 0; i < rows * cols; i++) if (!excl.has(i)) pool.push(i);
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const tmp = pool[i];
    pool[i] = pool[j];
    pool[j] = tmp;
  }
  const mineSet = new Set(pool.slice(0, Math.min(mines, pool.length)));
  const g: string[][] = Array.from({ length: rows }, () => Array<string>(cols).fill("."));
  mineSet.forEach((mi) => {
    g[Math.floor(mi / cols)][mi % cols] = "m";
  });
  return g.map((row) => row.join(""));
}

/** Reveal targets with zero-cell cascade. May hit a mine (fatal). */
function revealCells(
  board: string[],
  targets: Cell[],
  rows: number,
  cols: number,
): { board: string[]; fatal: Cell | null } {
  const g = board.map((row) => row.split(""));
  let fatal: Cell | null = null;
  for (const [r, c] of targets) {
    const ch = g[r][c];
    if (isRevealed(ch) || ch === "f" || ch === "F") continue;
    if (ch === "m") {
      if (!fatal) {
        fatal = [r, c];
        g[r][c] = "x"; // the fatal mine — rendered in rose
      }
      continue;
    }
    const stack: Cell[] = [[r, c]];
    while (stack.length) {
      const [cr, cc] = stack.pop()!;
      if (g[cr][cc] !== ".") continue;
      let n = 0;
      for (const [nr, nc] of neighborsOf(cr, cc, rows, cols)) {
        const nch = g[nr][nc];
        if (nch === "m" || nch === "F") n++;
      }
      g[cr][cc] = String(n);
      if (n === 0) {
        for (const [nr, nc] of neighborsOf(cr, cc, rows, cols)) {
          if (g[nr][nc] === ".") stack.push([nr, nc]);
        }
      }
    }
  }
  return { board: g.map((row) => row.join("")), fatal };
}

function flagsOf(board: string[]): number {
  let n = 0;
  for (const row of board) for (const ch of row) if (ch === "f" || ch === "F") n++;
  return n;
}

function checkWin(board: string[], rows: number, cols: number, mines: number): boolean {
  let safe = 0;
  for (const row of board) for (const ch of row) if (isRevealed(ch)) safe++;
  return safe >= rows * cols - mines;
}

/** On victory: auto-flag every remaining mine. */
function flagAllMines(board: string[]): string[] {
  return board.map((row) => row.replace(/m/g, "F"));
}

function validBoard(b: unknown, rows: number, cols: number): b is string[] {
  if (!Array.isArray(b) || b.length !== rows) return false;
  return b.every((row) => typeof row === "string" && row.length === cols && /^[.mfFx0-8]+$/.test(row));
}

function fmtTime(s: number): string {
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return `${m.toString().padStart(2, "0")}:${sec.toString().padStart(2, "0")}`;
}

/** mm:ss readout. While playing it counts from the synced start epoch
 *  (t0 — both seats agree, rejoins included); won/lost freeze at the
 *  synced duration. No reset effects needed — the data is the timer. */
function TimerReadout({ status, t0, dur }: { status: Status; t0: number; dur: number }) {
  const [, tick] = useState(0);
  useEffect(() => {
    if (status !== "playing" || t0 <= 0) return;
    const iv = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(iv);
  }, [status, t0]);
  const secs =
    status === "playing" && t0 > 0
      ? Math.max(0, Math.floor((Date.now() - t0) / 1000))
      : status === "won" || status === "lost"
        ? dur
        : 0;
  return <>{fmtTime(secs)}</>;
}

// ---------------- component ----------------

export default function MinesApp({ win }: { win: WindowState }) {
  // live window — the board arrives via synced payload patches
  const liveWin = useGlassDesk((s) => s.state?.windows.find((w) => w.id === win.id));
  const dispatch = useGlassDesk((s) => s.dispatch);
  const w = liveWin ?? win;
  const p = w.payload ?? {};

  const diff: Diff = p.diff === "medium" || p.diff === "hard" ? p.diff : "easy";
  const { rows, cols, mines } = DIFFS[diff];
  const rawBoard: unknown = p.board;
  const hasBoard = validBoard(rawBoard, rows, cols);
  const board = hasBoard ? rawBoard : emptyBoard(rows, cols);
  const status: Status =
    hasBoard && (p.status === "playing" || p.status === "won" || p.status === "lost") ? p.status : "new";

  // ---- timer: derived from the synced start epoch (t0) ----
  const t0 = typeof p.t0 === "number" && p.t0 > 0 ? p.t0 : 0;
  const dur = typeof p.dur === "number" && p.dur >= 0 ? Math.floor(p.dur) : 0;

  // ---- long-press / click bookkeeping ----
  const pressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const suppressClick = useRef(false);
  const lastPointerType = useRef("mouse");

  const clearPress = () => {
    if (pressTimer.current) clearTimeout(pressTimer.current);
    pressTimer.current = null;
  };

  const patch = (patchObj: Record<string, unknown>) =>
    dispatch({ t: "app:patch", id: win.id, patch: patchObj });

  const newGame = (d: Diff = diff) => patch({ status: "new", diff: d, board: null, t0: 0, dur: 0 });

  const flag = (r: number, c: number) => {
    if (status !== "new" && status !== "playing") return;
    const g = board.map((row) => row.split(""));
    const ch = g[r][c];
    if (isRevealed(ch)) return;
    // cycle flag → none
    const next: Record<string, string> = { ".": "f", m: "F", f: ".", F: "m" };
    g[r][c] = next[ch] ?? ch;
    patch({ board: g.map((row) => row.join("")), status: status === "new" ? "new" : status });
  };

  const commit = (b: string[], fatal: Cell | null, fresh = false) => {
    const secs = t0 > 0 ? Math.floor((Date.now() - t0) / 1000) : 0;
    if (fatal) {
      patch({ board: b, status: "lost", dur: secs });
      return;
    }
    if (checkWin(b, rows, cols, mines)) {
      patch({ board: flagAllMines(b), status: "won", dur: secs });
      pushToast({
        title: "Minefield cleared! 🏆",
        body: `${DIFFS[diff].label} swept in ${fmtTime(secs)}`,
        kind: "success",
      });
      return;
    }
    patch(fresh ? { board: b, status: "playing", t0: Date.now(), dur: 0 } : { board: b, status: "playing" });
  };

  const reveal = (r: number, c: number) => {
    if (status === "won" || status === "lost") return;
    const ch = board[r][c];
    if (ch === "f" || ch === "F" || isRevealed(ch)) return;
    if (status === "new" || !hasBoard) {
      let seeded = makeBoard(rows, cols, mines, r, c);
      // carry over any flags placed before the first reveal
      if (hasBoard) {
        const g = seeded.map((row) => row.split(""));
        for (let rr = 0; rr < rows; rr++) {
          for (let cc = 0; cc < cols; cc++) {
            const prev = board[rr][cc];
            if (prev === "f" || prev === "F") g[rr][cc] = g[rr][cc] === "m" ? "F" : "f";
          }
        }
        seeded = g.map((row) => row.join(""));
      }
      const res = revealCells(seeded, [[r, c]], rows, cols);
      commit(res.board, res.fatal, true);
      return;
    }
    const res = revealCells(board, [[r, c]], rows, cols);
    commit(res.board, res.fatal);
  };

  /** Chording: double-click a revealed number whose flags match. */
  const chord = (r: number, c: number) => {
    if (status !== "playing" || !hasBoard) return;
    const ch = board[r][c];
    if (!isRevealed(ch) || ch === "0") return;
    const nb = neighborsOf(r, c, rows, cols);
    let fl = 0;
    for (const [nr, nc] of nb) {
      const nch = board[nr][nc];
      if (nch === "f" || nch === "F") fl++;
    }
    if (fl !== Number(ch)) return;
    const res = revealCells(board, nb, rows, cols);
    commit(res.board, res.fatal);
  };

  // ---- rendering knobs ----
  const remaining = mines - flagsOf(board);
  const gapCls = cols >= 16 ? "gap-[2px]" : cols >= 12 ? "gap-[3px]" : "gap-1";
  const numCls = cols >= 16 ? "text-[10px]" : cols >= 12 ? "text-xs" : "text-sm";
  const iconCls = cols >= 16 ? "size-2.5" : cols >= 12 ? "size-3" : "size-3.5";
  const maxW = cols >= 16 ? 440 : cols >= 12 ? 400 : 340;

  const statusChip =
    status === "won"
      ? "bg-emerald-500/15 text-emerald-700"
      : status === "lost"
        ? "bg-rose-500/15 text-rose-600"
        : status === "playing"
          ? "bg-amber-500/15 text-amber-700"
          : "bg-teal-500/15 text-teal-700";
  const statusLabel =
    status === "won" ? "Cleared!" : status === "lost" ? "Boom" : status === "playing" ? "Sweeping…" : "Ready";

  return (
    <div className="flex h-full min-h-0 flex-col gap-2.5 p-3">
      {/* controls */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="glass flex items-center gap-1 rounded-xl p-1" role="group" aria-label="Difficulty">
          {(Object.keys(DIFFS) as Diff[]).map((d) => (
            <motion.button
              key={d}
              type="button"
              whileTap={{ scale: 0.94 }}
              transition={SPRING}
              onClick={() => newGame(d)}
              aria-pressed={d === diff}
              className={`rounded-lg px-2.5 py-1 text-xs font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-teal-400 ${
                d === diff ? "gd-accent-gradient text-white" : "text-stone-600 hover:bg-white/70"
              }`}
            >
              {DIFFS[d].label}
            </motion.button>
          ))}
        </div>
        <motion.button
          type="button"
          whileTap={{ scale: 0.94 }}
          transition={SPRING}
          onClick={() => newGame()}
          className="glass flex items-center gap-1.5 rounded-xl px-3 py-1.5 text-xs font-medium text-stone-700 outline-none transition-colors hover:bg-white/80 focus-visible:ring-2 focus-visible:ring-teal-400"
          aria-label="New game"
        >
          <RotateCcw className="size-3.5" /> New Game
        </motion.button>
      </div>

      {/* stats */}
      <div className="flex flex-wrap items-center gap-2" aria-live="polite">
        <div className="glass flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-sm font-semibold tabular-nums text-stone-700">
          <Bomb className="size-3.5 text-stone-500" aria-hidden />
          {remaining}
        </div>
        <div className="glass flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-sm font-semibold tabular-nums text-stone-700">
          <Timer className="size-3.5 text-stone-500" aria-hidden />
          <TimerReadout status={status} t0={t0} dur={dur} />
        </div>
        <div className={`rounded-lg px-2.5 py-1.5 text-xs font-semibold ${statusChip}`}>{statusLabel}</div>
        <span className="ml-auto hidden text-[11px] text-stone-400 sm:block">
          {mines} mines · {rows}×{cols}
        </span>
      </div>

      {/* board */}
      <div className="relative min-h-0 flex-1">
        <div className="gd-scroll absolute inset-0 grid place-items-center overflow-auto">
          <div
            className="grid w-full"
            style={{
              gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`,
              maxWidth: maxW,
              gap: cols >= 16 ? 2 : 3,
            }}
            role="grid"
            aria-label={`Minesweeper board, ${rows} by ${cols}, ${mines} mines`}
          >
            {board.map((row, r) =>
              row.split("").map((ch, c) => {
                const revealed = isRevealed(ch) || (status === "lost" && (ch === "m" || ch === "x"));
                const isFatal = ch === "x";
                const isFlag = ch === "f" || ch === "F";
                const wrongFlag = ch === "f" && status === "lost";

                let cellCls: string;
                if (isFatal) {
                  cellCls = "bg-rose-500/90 shadow-[inset_0_1px_2px_rgba(136,19,55,0.35)]";
                } else if (revealed) {
                  cellCls = isRevealed(ch)
                    ? "bg-white/25 shadow-[inset_0_1px_3px_rgba(31,41,55,0.14)]"
                    : "bg-rose-100/70 shadow-[inset_0_1px_3px_rgba(31,41,55,0.12)]";
                } else if (isFlag) {
                  cellCls = "bg-white/75 shadow-[0_1px_2px_rgba(31,41,55,0.12),inset_0_1px_0_rgba(255,255,255,0.8)]";
                } else {
                  cellCls =
                    "bg-white/75 shadow-[0_1px_2px_rgba(31,41,55,0.12),inset_0_1px_0_rgba(255,255,255,0.8)] hover:bg-white/95 active:bg-white";
                }

                const label = isFatal
                  ? `row ${r + 1} column ${c + 1}, fatal mine`
                  : revealed && isRevealed(ch)
                    ? `row ${r + 1} column ${c + 1}, revealed ${ch === "0" ? "empty" : `${ch} adjacent`}`
                    : status === "lost" && ch === "m"
                      ? `row ${r + 1} column ${c + 1}, mine`
                      : isFlag
                        ? `row ${r + 1} column ${c + 1}, flagged`
                        : `row ${r + 1} column ${c + 1}, unrevealed`;

                return (
                  <button
                    key={`${r}-${c}`}
                    type="button"
                    aria-label={label}
                    className={`grid aspect-square select-none place-items-center rounded-[5px] font-semibold outline-none transition-colors duration-75 focus-visible:ring-2 focus-visible:ring-teal-400 ${numCls} ${cellCls}`}
                    style={{ touchAction: "manipulation" }}
                    onClick={() => {
                      if (suppressClick.current) {
                        suppressClick.current = false;
                        return;
                      }
                      reveal(r, c);
                    }}
                    onDoubleClick={() => chord(r, c)}
                    onContextMenu={(e) => {
                      e.preventDefault();
                      if (lastPointerType.current !== "touch") flag(r, c);
                    }}
                    onPointerDown={(e) => {
                      lastPointerType.current = e.pointerType;
                      if (e.pointerType !== "touch") return;
                      clearPress();
                      pressTimer.current = setTimeout(() => {
                        suppressClick.current = true;
                        flag(r, c);
                      }, 380);
                    }}
                    onPointerUp={clearPress}
                    onPointerLeave={clearPress}
                    onPointerCancel={clearPress}
                  >
                    {/* keyed by cell char: any change remounts → spring pop */}
                    <motion.span
                      key={ch}
                      initial={{ scale: 0.6 }}
                      animate={{ scale: 1 }}
                      transition={{ type: "spring", stiffness: 480, damping: 26 }}
                      className="grid place-items-center"
                    >
                      {isFatal ? (
                        <Bomb className={`${iconCls} text-white`} aria-hidden />
                      ) : status === "lost" && ch === "m" ? (
                        <Bomb className={`${iconCls} text-stone-600`} aria-hidden />
                      ) : isFlag ? (
                        wrongFlag ? (
                          <span className="relative inline-grid place-items-center">
                            <Flag className={`${iconCls} text-stone-400`} aria-hidden />
                            <X className="absolute -right-1 -top-1 size-2 text-rose-500" aria-hidden />
                          </span>
                        ) : (
                          <Flag className={`${iconCls} text-rose-500`} aria-hidden />
                        )
                      ) : revealed && ch !== "0" ? (
                        <span className={NUM_COLOR[ch] ?? "text-stone-700"}>{ch}</span>
                      ) : null}
                    </motion.span>
                  </button>
                );
              }),
            )}
          </div>
        </div>

        {/* win / lose celebration */}
        <AnimatePresence>
          {(status === "won" || status === "lost") && (
            <motion.div
              key="mines-overlay"
              initial={{ opacity: 0, scale: 0.92 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.92 }}
              transition={SPRING}
              className="pointer-events-none absolute inset-0 z-10 grid place-items-center"
            >
              <div className="glass-strong pointer-events-auto rounded-2xl px-7 py-5 text-center">
                {status === "won" ? (
                  <Trophy className="mx-auto size-8 text-amber-500" aria-hidden />
                ) : (
                  <Bomb className="mx-auto size-8 text-rose-500" aria-hidden />
                )}
                <p className="mt-2 text-lg font-bold text-stone-800">
                  {status === "won" ? "Minefield cleared!" : "Boom!"}
                </p>
                <p className="mt-0.5 text-xs text-stone-500">
                  {status === "won"
                    ? `${DIFFS[diff].label} · ${fmtTime(dur)}`
                    : `You survived ${fmtTime(dur)} — try again`}
                </p>
                {status === "won" && (
                  <div className="mt-3 flex justify-center gap-1.5" aria-hidden>
                    {CONFETTI.map((color, i) => (
                      <motion.span
                        key={i}
                        className="size-2 rounded-full"
                        style={{ background: color }}
                        animate={{ y: [0, -7, 0], scale: [1, 1.35, 1] }}
                        transition={{ duration: 1.1, repeat: Infinity, delay: i * 0.07, ease: "easeInOut" }}
                      />
                    ))}
                  </div>
                )}
                <motion.button
                  type="button"
                  whileTap={{ scale: 0.94 }}
                  transition={SPRING}
                  onClick={() => newGame()}
                  className="gd-accent-gradient mt-4 rounded-xl px-4 py-2 text-sm font-semibold text-white shadow-sm outline-none transition-[filter] hover:brightness-105 focus-visible:ring-2 focus-visible:ring-teal-400"
                >
                  Play again
                </motion.button>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {/* help hint row */}
      <p className="text-center text-[11px] text-stone-400" role="note">
        Left-click reveal · right-click / long-press flag · double-click a number to chord
      </p>
    </div>
  );
}
