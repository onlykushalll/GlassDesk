"use client";

// ============================================================
// Aurora — GlassDesk's ambient animated background.
// Four huge, soft gradient blobs (teal / emerald / soft amber —
// NEVER blue or indigo) drifting on slow mirrored framer-motion
// loops behind frosted glass surfaces. The Landing renders it at
// full strength; the Desktop reuses it dimmed behind windows.
// ============================================================

import { motion } from "framer-motion";

export interface AuroraProps {
  /**
   * Soften the blobs for busy surfaces (the Desktop layers the
   * Aurora behind its windows). Full strength on the Landing.
   * @default false
   */
  dim?: boolean;
  /**
   * Paint the static base wash (opaque light gradient). The Landing
   * keeps it; the Desktop passes wash={false} so the live wallpaper
   * (image or gradient) shows through beneath the drifting blobs.
   * @default true
   */
  wash?: boolean;
}

interface BlobSpec {
  /** Base color — teal #14b8a6, emerald #10b981, soft amber #f59e0b family only. */
  color: string;
  /** Blob diameter (vmax keeps it huge on any viewport). */
  size: string;
  /** Anchored position — offsets bleed gracefully off-canvas. */
  left: string;
  top: string;
  /** Base opacity (pre-dim). */
  opacity: number;
  /** Seconds for one full drift loop (mirrored → feels endless). */
  duration: number;
  x: number[];
  y: number[];
  scale: number[];
}

const BLOBS: BlobSpec[] = [
  {
    color: "#14b8a6", // teal
    size: "58vmax",
    left: "-16%",
    top: "-24%",
    opacity: 0.2,
    duration: 26,
    x: [0, 60, -34, 0],
    y: [0, 42, -18, 0],
    scale: [1, 1.12, 0.96, 1],
  },
  {
    color: "#10b981", // emerald
    size: "50vmax",
    left: "56%",
    top: "-14%",
    opacity: 0.16,
    duration: 34,
    x: [0, -72, 24, 0],
    y: [0, 58, -12, 0],
    scale: [1, 0.94, 1.1, 1],
  },
  {
    color: "#f59e0b", // soft amber tint
    size: "46vmax",
    left: "60%",
    top: "52%",
    opacity: 0.1,
    duration: 40,
    x: [0, -52, 30, 0],
    y: [0, -58, 12, 0],
    scale: [1, 1.08, 0.92, 1],
  },
  {
    color: "#34d399", // emerald-400 tint
    size: "44vmax",
    left: "-12%",
    top: "54%",
    opacity: 0.12,
    duration: 30,
    x: [0, 52, -38, 0],
    y: [0, -46, 24, 0],
    scale: [1, 1.14, 1, 1],
  },
];

// Static light wash echoing the "aurora" wallpaper — the page reads
// right even before the first animation frame lands.
const BASE_WASH = "linear-gradient(160deg, #f8fffd 0%, #f0fdf9 45%, #f7fdf5 100%)";

const DIM_FACTOR = 0.35;

export default function Aurora({ dim = false, wash = true }: AuroraProps) {
  const factor = dim ? DIM_FACTOR : 1;

  return (
    <div
      aria-hidden="true"
      className="pointer-events-none absolute inset-0 select-none overflow-hidden"
      style={wash ? { background: BASE_WASH } : undefined}
    >
      {BLOBS.map((blob, i) => (
        <motion.div
          key={i}
          className="absolute rounded-full"
          style={{
            left: blob.left,
            top: blob.top,
            width: blob.size,
            height: blob.size,
            background: `radial-gradient(closest-side, ${blob.color} 0%, transparent 72%)`,
            filter: "blur(52px)",
            opacity: blob.opacity * factor,
            willChange: "transform",
          }}
          animate={{ x: blob.x, y: blob.y, scale: blob.scale }}
          transition={{
            duration: blob.duration,
            repeat: Infinity,
            repeatType: "mirror",
            ease: "easeInOut",
          }}
        />
      ))}
    </div>
  );
}
