/**
 * ProviderBrandIcon — Shows a brand logo from @icons-pack/react-simple-icons.
 * Falls back to Globe (Lucide) for unknown providers.
 */
import { Globe } from "lucide-react";
import {
  SiNetflix, SiAppletv, SiYoutube, SiDazn,
  SiSpotify, SiApplemusic, SiDeezer, SiTidal,
  SiGoogledrive, SiDropbox, SiIcloud, SiNotion, SiEvernote,
  SiSunrise,
  SiFitbit, SiApple, SiStrava,
  SiCoursera, SiUdemy, SiDuolingo,
} from "@icons-pack/react-simple-icons";
import { clsx } from "clsx";

// Map provider IDs → SimpleIcon component
const BRAND_MAP: Record<string, React.ComponentType<{ size?: number; className?: string }>> = {
  // Streaming & TV
  netflix:         SiNetflix,
  "apple-tv":      SiAppletv,
  youtube:         SiYoutube,
  dazn:            SiDazn,
  // Musik
  spotify:         SiSpotify,
  "apple-music":   SiApplemusic,
  deezer:          SiDeezer,
  tidal:           SiTidal,
  // Cloud & Software
  "google-drive":  SiGoogledrive,
  dropbox:         SiDropbox,
  icloud:          SiIcloud,
  notion:          SiNotion,
  evernote:        SiEvernote,
  // Kommunikation
  sunrise:         SiSunrise,
  // Fitness
  fitbit:          SiFitbit,
  "apple-fitness": SiApple,
  strava:          SiStrava,
  // Bildung
  coursera:        SiCoursera,
  udemy:           SiUdemy,
  duolingo:        SiDuolingo,
};

// Normalize provider IDs that differ from brand map keys
const ID_ALIASES: Record<string, string> = {
  "yt-premium":    "youtube",
  "apple-tv":      "apple-tv",
  "apple-music":   "apple-music",
  "apple-fitness": "apple-fitness",
  "google-drive":  "google-drive",
};

function resolveBrandId(providerId: string): string {
  return ID_ALIASES[providerId] ?? providerId;
}

interface Props {
  providerId: string;
  size?: number;
  className?: string;
}

export default function ProviderBrandIcon({ providerId, size = 20, className }: Props) {
  const BrandIcon = BRAND_MAP[resolveBrandId(providerId)];

  if (BrandIcon) {
    return (
      <div
        className={clsx(
          "flex items-center justify-center rounded-sm bg-white/5 flex-shrink-0",
          className
        )}
        style={{ width: size, height: size }}
      >
        <BrandIcon size={Math.round(size * 0.65)} className="text-text-secondary" />
      </div>
    );
  }

  // Fallback: Globe icon
  return (
    <div
      className={clsx(
        "flex items-center justify-center rounded-sm bg-white/5 flex-shrink-0",
        className
      )}
      style={{ width: size, height: size }}
    >
      <Globe className="text-text-tertiary" style={{ width: size * 0.6, height: size * 0.6 }} />
    </div>
  );
}
