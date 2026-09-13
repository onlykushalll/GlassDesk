# GlassDesk Software Engineering (SWE) Evaluation Benchmark Suite

This directory defines turn-key **Software Engineering (SWE) evaluation tasks** designed for testing autonomous coding agents (such as SWE-bench, Devin, Claude Code, and Codex) on real-world collaborative systems challenges.

---

## Benchmark Overview

Each task consists of:
1. **Problem Statement**: An issue description describing a bug or feature specification.
2. **Environment**: The GlassDesk full-stack container (`Dockerfile` / `docker-compose.yml`).
3. **Automated Verifier**: A test file in `tests/` that fails before the patch and passes only when the agent delivers the correct solution.

---

## Task Catalog

### `SWE-EVAL-01`: Recursive VFS Inode Cleanup
* **Target File**: `src/lib/vpc/types.ts` (`deleteWithDescendants`)
* **Difficulty**: Medium
* **Category**: Systems Engineering / Data Structures
* **Prompt**: *"When deleting a folder in the virtual filesystem, any deeply nested subfolders and files must be recursively purged from `FSMap` to prevent orphaned nodes. Ensure the traversal handles circular references defensively."*
* **Verifier Command**: `bun test tests/eval-tasks.test.ts -t "SWE-EVAL-01"`

### `SWE-EVAL-02`: Reducer Reference Stability
* **Target File**: `src/lib/vpc/types.ts` (`applyOp`)
* **Difficulty**: Easy
* **Category**: React / State Architecture
* **Prompt**: *"To avoid unneeded re-renders across the desktop UI tree, `applyOp` must return the exact previous `DesktopState` reference whenever an unrecognized or no-op action is received."*
* **Verifier Command**: `bun test tests/eval-tasks.test.ts -t "SWE-EVAL-02"`

### `SWE-EVAL-03`: Multi-Workspace Window Clamping
* **Target File**: `src/lib/vpc/types.ts` (`win:ws`)
* **Difficulty**: Easy
* **Category**: Window Management / Math Clamping
* **Prompt**: *"Enforce strict boundary clamping (0..3) on window workspace migrations so windows cannot disappear into non-existent virtual workspaces."*
* **Verifier Command**: `bun test tests/eval-tasks.test.ts -t "SWE-EVAL-03"`

### `SWE-EVAL-04`: Ghost Eviction Timer Expiry
* **Target File**: `mini-services/session-service/index.ts` (`evictStaleMembers`)
* **Difficulty**: Hard
* **Category**: Distributed Systems / Network Partitions
* **Prompt**: *"If a client drops connection without an explicit disconnect packet, reclaim the seat after `GHOST_GRACE_MS` while preserving the room's dirty state for subsequent database flush."*
* **Verifier Command**: `bun test tests/session-service.test.ts -t "ghost member eviction"`

### `SWE-EVAL-05`: Asymmetric WebRTC Glare Avoidance
* **Target File**: `src/lib/vpc/useCall.ts`
* **Difficulty**: Hard
* **Category**: WebRTC / Real-Time Media
* **Prompt**: *"Ensure only the host seat initiates SDP offers to prevent collision glare over high-latency WebSocket signaling relays."*
* **Verifier Command**: `bun test tests/webrtc-signaling.test.ts -t "asymmetric offer"`
