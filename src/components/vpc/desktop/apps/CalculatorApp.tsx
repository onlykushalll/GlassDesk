"use client";

// ============================================================
// GlassDesk — Calculator. Payload: { expr: string } — shared
// across both seats: every key press patches the expr so the
// peer sees the same keystrokes and result live.
// ============================================================

import { useState } from "react";
import { motion } from "framer-motion";
import { Delete } from "lucide-react";
import { useGlassDesk } from "@/lib/vpc/store";
import type { WindowState } from "@/lib/vpc/types";

type KeyKind = "digit" | "op" | "fn" | "eq";

interface CalcKey {
  k: string;
  ch?: string;
  act?: "clear" | "back" | "eval";
  kind: KeyKind;
  wide?: boolean;
}

// grid-cols-5 with the arithmetic operators and the 0 spanning
// two columns — realizes the exact key rows from the spec.
const KEYS: CalcKey[] = [
  { k: "C", act: "clear", kind: "fn" },
  { k: "\u232B", act: "back", kind: "fn" },
  { k: "(", ch: "(", kind: "fn" },
  { k: ")", ch: ")", kind: "fn" },
  { k: "%", ch: "%", kind: "fn" },
  { k: "7", ch: "7", kind: "digit" },
  { k: "8", ch: "8", kind: "digit" },
  { k: "9", ch: "9", kind: "digit" },
  { k: "\u00F7", ch: "\u00F7", kind: "op", wide: true },
  { k: "4", ch: "4", kind: "digit" },
  { k: "5", ch: "5", kind: "digit" },
  { k: "6", ch: "6", kind: "digit" },
  { k: "\u00D7", ch: "\u00D7", kind: "op", wide: true },
  { k: "1", ch: "1", kind: "digit" },
  { k: "2", ch: "2", kind: "digit" },
  { k: "3", ch: "3", kind: "digit" },
  { k: "\u2212", ch: "\u2212", kind: "op", wide: true },
  { k: "0", ch: "0", kind: "digit", wide: true },
  { k: ".", ch: ".", kind: "digit" },
  { k: "=", act: "eval", kind: "eq" },
  { k: "+", ch: "+", kind: "op" },
];

/** Evaluate a display expression → number, or null when not evaluable. */
function compute(expr: string): number | null {
  if (!expr.trim()) return null;
  let safe = expr
    .replace(/\u00D7/g, "*")
    .replace(/\u00F7/g, "/")
    .replace(/\u2212/g, "-")
    .replace(/%/g, "/100");
  safe = safe.replace(/[^0-9+\-*/(). ]/g, "");
  if (!safe.trim() || !/[0-9]/.test(safe)) return null;
  try {
    const evaluate = Function(`"use strict"; return (${safe});`);
    const value = evaluate() as unknown;
    if (typeof value !== "number" || !Number.isFinite(value)) return null;
    return value;
  } catch {
    return null;
  }
}

function fmtNum(v: number): string {
  return String(Number(v.toPrecision(12)));
}

function keyClass(kind: KeyKind, wide: boolean): string {
  const base =
    "glass-sheen flex h-12 select-none items-center justify-center rounded-xl text-base font-medium outline-none transition-[filter,background-color] focus-visible:ring-2 focus-visible:ring-stone-300";
  const span = wide ? " col-span-2" : "";
  switch (kind) {
    case "digit":
      return `${base}${span} bg-white/70 text-stone-700 hover:bg-white/90`;
    case "fn":
      return `${base}${span} bg-white/40 text-stone-500 hover:bg-white/70`;
    case "op":
      return `${base}${span} gd-accent-gradient text-white hover:brightness-105`;
    case "eq":
      return `${base}${span} bg-[linear-gradient(135deg,#34d399,#10b981)] text-white shadow-sm hover:brightness-105`;
    default:
      return `${base}${span} bg-white/70 text-stone-700 hover:bg-white/90`;
  }
}

export default function CalculatorApp({ win }: { win: WindowState }) {
  // read the LIVE window (payload changes on every shared keystroke)
  const liveWin = useGlassDesk((s) => s.state?.windows.find((w) => w.id === win.id));
  const dispatch = useGlassDesk((s) => s.dispatch);
  const w = liveWin ?? win;

  const expr = typeof w.payload.expr === "string" ? w.payload.expr : "";
  const [error, setError] = useState(false);

  const patch = (next: string) => dispatch({ t: "app:patch", id: win.id, patch: { expr: next } });

  const press = (key: CalcKey) => {
    setError(false);
    if (key.act === "clear") {
      patch("");
      return;
    }
    if (key.act === "back") {
      patch(expr.slice(0, -1));
      return;
    }
    if (key.act === "eval") {
      const value = compute(expr);
      if (value === null) {
        setError(true);
        return;
      }
      patch(fmtNum(value));
      return;
    }
    patch(expr + (key.ch ?? ""));
  };

  const preview = compute(expr);
  const previewText = error
    ? "error"
    : preview !== null && fmtNum(preview) !== expr
      ? `= ${fmtNum(preview)}`
      : "";

  return (
    <div className="flex h-full flex-col">
      <div className="flex min-h-0 flex-1 flex-col justify-end p-4">
        <div className="text-right">
          <div className="break-all text-2xl font-semibold leading-tight tabular-nums text-stone-800">
            {expr.length > 0 ? expr : <span className="text-stone-300">0</span>}
          </div>
          <div
            className={`mt-1 h-5 text-sm ${error ? "text-rose-500" : "text-stone-400"}`}
            aria-live="polite"
          >
            {previewText}
          </div>
        </div>
      </div>
      <div className="grid grid-cols-5 gap-1.5 p-3">
        {KEYS.map((key) => (
          <motion.button
            key={key.k}
            type="button"
            whileTap={{ scale: 0.93 }}
            transition={{ type: "spring", stiffness: 500, damping: 30 }}
            onClick={() => press(key)}
            className={keyClass(key.kind, key.wide === true)}
            aria-label={key.act === "back" ? "backspace" : key.k}
          >
            {key.act === "back" ? <Delete className="size-5" /> : key.k}
          </motion.button>
        ))}
      </div>
    </div>
  );
}
