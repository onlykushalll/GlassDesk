"use client";

// ============================================================
// GlassDesk — remote cursors.
// The service relays pointer events between seats and never
// echoes your own, so every entry here is the other person.
// Coordinates are normalized 0..1 against the desktop area;
// cursors older than 10s are reaped (a 1s ticker forces the
// re-evaluation even when the peer went quiet).
// ============================================================

import { useEffect, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { MousePointer2 } from "lucide-react";
import { useGlassDesk, type CursorInfo } from "@/lib/vpc/store";

const STALE_MS = 10_000;

export default function RemoteCursors() {
  const cursors = useGlassDesk((s) => s.cursors);
  const count = Object.keys(cursors).length;

  const [, setTick] = useState(0);
  useEffect(() => {
    if (count === 0) return;
    const timer = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(timer);
  }, [count]);

  const now = Date.now();
  const live = Object.values(cursors).filter((c) => now - c.at <= STALE_MS);

  return (
    <div className="absolute inset-0 pointer-events-none z-[70] overflow-hidden">
      <AnimatePresence>
        {live.map((c) => (
          <RemoteCursor key={c.id} cursor={c} />
        ))}
      </AnimatePresence>
    </div>
  );
}

function RemoteCursor({ cursor }: { cursor: CursorInfo }) {
  const left = `${(cursor.x * 100).toFixed(2)}%`;
  const top = `${(cursor.y * 100).toFixed(2)}%`;
  return (
    <motion.div
      className="absolute"
      initial={{ opacity: 0, left, top }}
      animate={{ opacity: 1, left, top }}
      exit={{ opacity: 0 }}
      transition={{
        opacity: { duration: 0.2 },
        left: { type: "spring", stiffness: 500, damping: 40 },
        top: { type: "spring", stiffness: 500, damping: 40 },
      }}
    >
      <div className="flex items-start">
        <MousePointer2
          size={18}
          strokeWidth={1.5}
          stroke="white"
          className="shrink-0"
          style={{
            fill: "var(--gd-accent)",
            filter: "drop-shadow(0 1px 2px rgba(31,41,55,0.4))",
          }}
        />
        <span className="ml-4 -mt-1 text-[10px] font-medium px-1.5 py-0.5 rounded-full bg-white/80 backdrop-blur border border-white/60 text-stone-700 shadow-sm whitespace-nowrap">
          {cursor.name}
        </span>
      </div>
    </motion.div>
  );
}
