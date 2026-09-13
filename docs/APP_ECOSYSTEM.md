# GlassDesk — Virtual Application Ecosystem & Systems Protocols

GlassDesk features 30 built-in applications built atop the unified **authoritative operational reducer (`applyOp`)**. While basic desktop environments provide isolated toys, GlassDesk's applications are synchronized systems components that interact with the shared virtual machine:

---

## 1. High-Entropy Systems & Engineering Applications

### A. Shared Virtual Terminal (`TerminalApp.tsx`)
- **Dual-Seat Input Multiplexing**: Both participants share the same active virtual terminal shell. Keystrokes, commands, and outputs are synchronized across both seats in real-time.
- **Simulated Hardware Inspection**: Implements virtualized shell commands (`neofetch`, `ps`, `free`, `top`, `uname`, `uptime`) reading live memory metrics from `DesktopState.machine`.
- **ANSI Terminal Protocol**: Custom escape sequence renderer with persistent command history and tab auto-completion.

### B. Live Process & Memory Monitor (`TaskMgrApp.tsx`)
- **Virtual Memory Paging**: Tracks RAM utilization across 168 MB base system overhead and dynamic per-application allocations (`ramUsage` calculator).
- **Process Lifecycle Control**: Provides task termination (`kill -9`) with responsive desktop state cleanup, preventing memory leaks in simulated long-running sessions.

### C. Collaborative Code Studio (`CodeApp.tsx`)
- **VFS File Binding**: Directly mounts the virtual filesystem (`FSMap`), supporting multi-file editing, syntax highlighting, and live auto-save into the debounced SQLite WAL database.
- **Code Execution Simulation**: Sandboxed evaluation engine for JavaScript, TypeScript, and Markdown rendering.

### D. Real-Time Vector Canvas (`WhiteboardApp.tsx`)
- **Stroke-Level Op Broadcasting**: Vector paths are serialized and broadcasted across WebSocket relays, ensuring sub-10ms drawing co-presence between remote peers.
- **Infinite Canvas Math**: Viewport pan/zoom transforms synchronized with pressure-sensitive stroke interpolation.

### E. Synchronized Media Theater (`YTTheater.tsx`)
- **Asymmetric Timestamp State Machine**: Master/slave playback synchronization preventing audio echo and seek thrashing across distributed networks.

---

## 2. Integrated Desktop Services

* **FilesApp**: Hierarchical file manager with folder creation, rename, move, and recursive deletion.
* **ContactsApp**: Directory service with internal extension routing and role tracking.
* **SecurityApp**: Firewall, session encryption status, and room code rotation.
* **StoreApp**: Package installer simulation demonstrating dynamic application mounting.
