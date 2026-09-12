# GlassDesk — Cloud-Native Collaborative Virtual PC

**GlassDesk** is a browser-based, AnyDesk-style collaborative operating system where **two users share a single cloud virtual PC with simultaneous co-control**, integrated with **docked WebRTC video calling** and an **Apple-inspired liquid glassmorphism design system**.

---

## Architecture Overview

```
Browser A ───────────────────┐               ┌─────────────────── Browser B
(Keyboard / Mouse / Video)   │               │   (Keyboard / Mouse / Video)
                             ▼               ▼
                       Reverse Proxy (Port :80 / :81)
                             │               │
               HTTP / Next.js│               │WebSocket (Socket.io)
                             ▼               ▼
                     Next.js 16 Web App      Session Service (:3030)
                     (React 19, Zustand)     ├── Authoritative Op Reducer
                             │               ├── WebRTC Signaling Relay
                             ▼               └── SQLite WAL Persistence
                     30 Native VPC Apps          ("GlassDesk HD" Volume)
```

### Core Architecture Pillars

1. **Simultaneous Co-Control (AnyDesk in the Browser)**:
   - Shared 6-digit room session codes with join-or-create semantics.
   - Keystroke-level input mirroring and low-latency cursor synchronization.
   - Server-side authoritative state reducer with optimistic client-side rendering.
   - Automatic reconnect tokens: state survives page reloads, tab closing, and transient network drops.

2. **Software-Defined Virtual PC ("GlassDesk HD")**:
   - Hostname allocation (`glass-XXXX`) and configurable RAM tiers (512MB to 4GB).
   - In-memory hot state with 400ms debounced SQLite persistence and 24-hour volume retention.
   - Integrated system utilities: Task Manager, terminal (`ps`, `free`, `neofetch`), System Settings, and battery/RAM indicators.

3. **Docked WebRTC Peer-to-Peer Video Call**:
   - Seamless floating video sidebar with Picture-in-Picture (PiP), mute, camera toggle, and integrated room chat.
   - STUN/TURN signaling handled directly by the WebSocket session service without third-party teleconferencing dependencies.

4. **Liquid Glass Design System**:
   - Apple-inspired glassmorphism with dynamic ambient light blobs (Teal → Emerald aesthetic).
   - Fluid spring physics powered by Framer Motion 12.
   - Window management: magnetic snap assist, minimize-to-dock genie animations, focus elevation, and task view overview.

---

## 30 Built-In Virtual Applications

GlassDesk includes a comprehensive ecosystem of collaborative virtual applications:

| Category | Applications |
|---|---|
| **Productivity & Code** | `CodeApp` (Monaco/Ace editor), `TextEditApp`, `FilesApp` (virtual filesystem), `TerminalApp` (interactive shell) |
| **System & Monitoring** | `TaskMgrApp` (process inspection & RAM), `SettingsApp`, `SecurityApp`, `StoreApp` (app installer) |
| **Communication & Media** | `MailApp`, `ContactsApp`, `MediaApp`, `TubeApp`, `YTTheater` (synchronized YouTube playback) |
| **Creativity & Utility** | `WhiteboardApp` (collaborative canvas), `PaintApp`, `CameraApp`, `PhotosApp`, `VoiceApp` (audio notes) |
| **Lifestyle & Information** | `BrowserApp`, `MapsApp`, `WeatherApp`, `ClockApp`, `CalendarApp`, `CalculatorApp`, `NotesApp` |
| **Casual Games** | `G2048App` (2048 puzzle), `MinesApp` (Minesweeper), `SnakeApp` |

---

## Getting Started

### Prerequisites
- [Node.js 20+](https://nodejs.org/) or [Bun 1.1+](https://bun.sh/)
- SQLite3

### Installation

1. **Clone the repository**:
   ```bash
   git clone https://github.com/onlykushalll/GlassDesk.git
   cd GlassDesk
   ```

2. **Install dependencies**:
   ```bash
   bun install
   # or: npm install
   ```

3. **Configure environment**:
   ```bash
   cp .env.example .env
   ```

4. **Start the development servers**:
   - Frontend Next.js app:
     ```bash
     bun run dev
     ```
   - Real-time Session Service (in `mini-services/session-service`):
     ```bash
     cd mini-services/session-service
     bun install
     bun run index.ts
     ```

5. **Open in browser**:
   Navigate to `http://localhost:3000` to create or join a virtual PC session.

---

## Security & Compliance

GlassDesk is built for secure, private collaboration:
- **Zero Cloud Video Recording**: Video and audio calls are direct peer-to-peer WebRTC connections; no video frames are recorded or saved.
- **Ephemeral Input Streams**: Mouse coordinates and keyboard input events are relayed in volatile memory and never persisted.
- See [`PRIVACY.md`](./PRIVACY.md) and [`TERMS.md`](./TERMS.md) for complete details.
- Comprehensive security and architectural audit: [`audit.md`](./audit.md).

---

## License

This project is licensed under the MIT License — see the [`LICENSE`](./LICENSE) file for details.
