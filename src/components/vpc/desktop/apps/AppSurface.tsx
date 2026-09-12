"use client";

// ============================================================
// GlassDesk — app router. Maps a window's AppKind to its
// surface component. Files/TextEdit/Terminal/Calculator are
// owned by agent 2-c; the remaining five are imported from
// sibling files owned by the other app agents (they exist at
// integration time — this file is the single wiring point).
// ============================================================

import type { WindowState } from "@/lib/vpc/types";
import AiApp from "./AiApp";
import BrowserApp from "./BrowserApp";
import CalculatorApp from "./CalculatorApp";
import CalendarApp from "./CalendarApp";
import CameraApp from "./CameraApp";
import ClockApp from "./ClockApp";
import CodeApp from "./CodeApp";
import ContactsApp from "./ContactsApp";
import FilesApp from "./FilesApp";
import G2048App from "./G2048App";
import MailApp from "./MailApp";
import MapsApp from "./MapsApp";
import MediaApp from "./MediaApp";
import MinesApp from "./MinesApp";
import NotesApp from "./NotesApp";
import PaintApp from "./PaintApp";
import PhotosApp from "./PhotosApp";
import SecurityApp from "./SecurityApp";
import SettingsApp from "./SettingsApp";
import SnakeApp from "./SnakeApp";
import StoreApp from "./StoreApp";
import TaskMgrApp from "./TaskMgrApp";
import TerminalApp from "./TerminalApp";
import TextEditApp from "./TextEditApp";
import TubeApp from "./TubeApp";
import VoiceApp from "./VoiceApp";
import WeatherApp from "./WeatherApp";
import WhiteboardApp from "./WhiteboardApp";

export default function AppSurface({ win }: { win: WindowState }) {
  switch (win.app) {
    case "files":
      return <FilesApp win={win} />;
    case "textedit":
      return <TextEditApp win={win} />;
    case "terminal":
      return <TerminalApp win={win} />;
    case "whiteboard":
      return <WhiteboardApp win={win} />;
    case "browser":
      return <BrowserApp win={win} />;
    case "media":
      return <MediaApp win={win} />;
    case "calculator":
      return <CalculatorApp win={win} />;
    case "settings":
      return <SettingsApp win={win} />;
    case "taskmgr":
      return <TaskMgrApp win={win} />;
    case "photos":
      return <PhotosApp win={win} />;
    case "notes":
      return <NotesApp win={win} />;
    case "calendar":
      return <CalendarApp win={win} />;
    case "clock":
      return <ClockApp win={win} />;
    case "weather":
      return <WeatherApp win={win} />;
    case "paint":
      return <PaintApp win={win} />;
    case "mines":
      return <MinesApp win={win} />;
    case "snake":
      return <SnakeApp win={win} />;
    case "g2048":
      return <G2048App win={win} />;
    case "youtube":
      return <TubeApp win={win} />;
    case "ai":
      return <AiApp win={win} />;
    case "code":
      return <CodeApp win={win} />;
    case "mail":
      return <MailApp win={win} />;
    case "camera":
      return <CameraApp win={win} />;
    case "voice":
      return <VoiceApp win={win} />;
    case "maps":
      return <MapsApp win={win} />;
    case "contacts":
      return <ContactsApp win={win} />;
    case "security":
      return <SecurityApp win={win} />;
    case "store":
      return <StoreApp win={win} />;
    default:
      return null;
  }
}
