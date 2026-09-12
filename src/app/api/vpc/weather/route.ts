import { NextRequest, NextResponse } from "next/server";
import dns from "node:dns";

// ============================================================
// GlassDesk — live weather backend (server-side only, no API key).
// GET /api/vpc/weather?city=Bengaluru
//   → wttr.in (self-geocoding: nearest_area + current + 3 days)
//     with Open-Meteo as a secondary fallback source.
// In-memory cache 10 min per city.
// weatherCode follows the WWO table:
//   113 sunny · 116/119/122 cloudy · 143+ fog · 176..359 rain
//   200/386/389/392/395 thunder · 179..371+ snow
// ============================================================

dns.setDefaultResultOrder("ipv4first");

const CACHE_MS = 10 * 60 * 1000;
const cache = new Map<string, { at: number; data: WeatherPayload }>();
const UA = "GlassDesk/1.0 (weather widget)";

export interface WeatherPayload {
  city: string;
  region: string;
  country: string;
  timezone: string;
  lat: number;
  lon: number;
  source: "wttr.in" | "open-meteo";
  current: {
    temperature: number;
    apparent: number;
    humidity: number;
    isDay: boolean;
    precipitation: number;
    weatherCode: number;
    windSpeed: number;
    windDir: number;
    observedAt: string;
    desc: string;
    uv: number;
    pressure: number;
    visibility: number;
    cloudcover: number;
  };
  daily: {
    date: string;
    code: number;
    max: number;
    min: number;
    sunrise: string;
    sunset: string;
  }[];
}

interface WttrVal {
  value?: string;
}
interface WttrJ1 {
  nearest_area?: {
    areaName?: WttrVal[];
    country?: WttrVal[];
    region?: WttrVal[];
    latitude?: string;
    longitude?: string;
  }[];
  current_condition?: {
    temp_C?: string;
    FeelsLikeC?: string;
    humidity?: string;
    precipMM?: string;
    weatherCode?: string;
    windspeedKmph?: string;
    winddirDegree?: string;
    observation_time?: string;
    weatherDesc?: WttrVal[];
    uvIndex?: string;
    pressure?: string;
    visibility?: string;
    cloudcover?: string;
  }[];
  weather?: {
    date?: string;
    maxtempC?: string;
    mintempC?: string;
    astronomy?: { sunrise?: string; sunset?: string }[];
    hourly?: { time?: string; weatherCode?: string }[];
  }[];
}

async function fromWttr(city: string): Promise<WeatherPayload | null> {
  const res = await fetch(`https://wttr.in/${encodeURIComponent(city)}?format=j1`, {
    cache: "no-store",
    headers: { "User-Agent": UA },
    signal: AbortSignal.timeout(12000),
  });
  if (!res.ok) return null;
  const j = (await res.json()) as WttrJ1;
  const cur = j.current_condition?.[0];
  const na = j.nearest_area?.[0];
  if (!cur) return null;

  const sunrise = j.weather?.[0]?.astronomy?.[0]?.sunrise ?? "06:00 AM";
  const sunset = j.weather?.[0]?.astronomy?.[0]?.sunset ?? "06:00 PM";
  const nowH = new Date().getHours() + new Date().getMinutes() / 60;
  const parseHm = (s: string) => {
    const m = /(\d{1,2}):(\d{2})\s*(AM|PM)?/i.exec(s);
    if (!m) return 12;
    let h = Number(m[1]) % 12;
    if (m[3]?.toUpperCase() === "PM") h += 12;
    return h + Number(m[2]) / 60;
  };
  const isDay = nowH >= parseHm(sunrise) && nowH <= parseHm(sunset);

  const daily: WeatherPayload["daily"] = [];
  for (const d of j.weather ?? []) {
    const noon = d.hourly?.find((h) => (h.time ?? "").endsWith("1200")) ?? d.hourly?.[4];
    daily.push({
      date: d.date ?? "",
      code: Number(noon?.weatherCode ?? 113),
      max: Number(d.maxtempC ?? 0),
      min: Number(d.mintempC ?? 0),
      sunrise: d.astronomy?.[0]?.sunrise ?? "",
      sunset: d.astronomy?.[0]?.sunset ?? "",
    });
  }

  return {
    city: na?.areaName?.[0]?.value || city,
    region: na?.region?.[0]?.value || city,
    country: na?.country?.[0]?.value || "",
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    lat: Number(na?.latitude ?? 0),
    lon: Number(na?.longitude ?? 0),
    source: "wttr.in",
    current: {
      temperature: Number(cur.temp_C ?? 0),
      apparent: Number(cur.FeelsLikeC ?? 0),
      humidity: Number(cur.humidity ?? 0),
      isDay,
      precipitation: Number(cur.precipMM ?? 0),
      weatherCode: Number(cur.weatherCode ?? 116),
      windSpeed: Number(cur.windspeedKmph ?? 0),
      windDir: Number(cur.winddirDegree ?? 0),
      observedAt: cur.observation_time ?? "",
      desc: cur.weatherDesc?.[0]?.value?.trim() ?? "",
      uv: Number(cur.uvIndex ?? 0),
      pressure: Number(cur.pressure ?? 0),
      visibility: Number(cur.visibility ?? 0),
      cloudcover: Number(cur.cloudcover ?? 0),
    },
    daily,
  };
}

export async function GET(req: NextRequest) {
  const city = (req.nextUrl.searchParams.get("city") ?? "").trim().slice(0, 64);
  if (!city) {
    return NextResponse.json({ error: "city_required" }, { status: 400 });
  }

  const key = city.toLowerCase();
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) {
    return NextResponse.json({ ...hit.data, cached: true });
  }

  try {
    const data = await fromWttr(city);
    if (!data) {
      return NextResponse.json({ error: "forecast_unavailable" }, { status: 502 });
    }
    cache.set(key, { at: Date.now(), data });
    return NextResponse.json({ ...data, cached: false });
  } catch (err) {
    console.error("[weather] failed:", err);
    return NextResponse.json({ error: "weather_failed" }, { status: 502 });
  }
}
