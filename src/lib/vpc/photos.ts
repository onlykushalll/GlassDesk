// ============================================================
// GlassDesk — Photos manifest. Shared library data for
// PhotosApp (wave-8). Pure data, no directives, no browser
// APIs — safe to import anywhere.
//
// Images live at /public/photos/*.png and are generated
// concurrently; every consumer MUST keep a gradient fallback
// (tint) so missing files never render a broken image.
// ============================================================

export type PhotoAlbum = "nature" | "city" | "abstract";
export type AlbumId = "all" | PhotoAlbum;

export interface PhotoItem {
  /** file name inside /public/photos */
  file: string;
  /** user-facing title */
  title: string;
  album: PhotoAlbum;
  /** gradient shown while loading / when the file is missing */
  tint: string;
  /** tiny accent dot color used in captions */
  dot: string;
}

export const PHOTOS: PhotoItem[] = [
  {
    file: "forest.png",
    title: "Misty Valley",
    album: "nature",
    tint: "linear-gradient(140deg,#99f6e4 0%,#14b8a6 45%,#134e4a 100%)",
    dot: "#5eead4",
  },
  {
    file: "lake.png",
    title: "Alpine Lake",
    album: "nature",
    tint: "linear-gradient(150deg,#a7f3d0 0%,#10b981 55%,#065f46 100%)",
    dot: "#6ee7b7",
  },
  {
    file: "desert.png",
    title: "Desert Bloom",
    album: "nature",
    tint: "linear-gradient(150deg,#fde68a 0%,#f59e0b 55%,#b45309 100%)",
    dot: "#fbbf24",
  },
  {
    file: "waterfall.png",
    title: "Jungle Falls",
    album: "nature",
    tint: "linear-gradient(160deg,#6ee7b7 0%,#059669 55%,#064e3b 100%)",
    dot: "#34d399",
  },
  {
    file: "tokyo.png",
    title: "Neon Alley",
    album: "city",
    tint: "linear-gradient(150deg,#fb7185 0%,#f43f5e 45%,#4c0519 100%)",
    dot: "#fb7185",
  },
  {
    file: "lisbon.png",
    title: "Lisbon Tram",
    album: "city",
    tint: "linear-gradient(140deg,#fcd34d 0%,#fb923c 50%,#7c2d12 100%)",
    dot: "#fbbf24",
  },
  {
    file: "skyline.png",
    title: "Dawn Skyline",
    album: "city",
    tint: "linear-gradient(160deg,#fef3c7 0%,#5eead4 45%,#0d9488 100%)",
    dot: "#fde047",
  },
  {
    file: "bubble.png",
    title: "Soap Universe",
    album: "abstract",
    tint: "linear-gradient(150deg,#fecdd3 0%,#fde68a 50%,#a7f3d0 100%)",
    dot: "#f9a8d4",
  },
  {
    file: "light.png",
    title: "Light Ribbons",
    album: "abstract",
    tint: "linear-gradient(145deg,#fde68a 0%,#5eead4 45%,#fb7185 100%)",
    dot: "#fcd34d",
  },
  {
    file: "dew.png",
    title: "Morning Dew",
    album: "abstract",
    tint: "linear-gradient(150deg,#ecfccb 0%,#a7f3d0 50%,#ccfbf1 100%)",
    dot: "#86efac",
  },
];

export const ALBUM_META: { id: AlbumId; label: string }[] = [
  { id: "all", label: "All Photos" },
  { id: "nature", label: "Nature" },
  { id: "city", label: "City" },
  { id: "abstract", label: "Abstract" },
];

export function photoUrl(file: string): string {
  return `/photos/${file}`;
}

export function photoByFile(file: string | null | undefined): PhotoItem | undefined {
  return file ? PHOTOS.find((p) => p.file === file) : undefined;
}
