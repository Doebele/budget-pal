/**
 * ProviderBrandIcon — Shows local provider icons first (stored in public/provider-icons),
 * then falls back to react-simple-icons and finally to Globe.
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

const LOCAL_ICON_IDS = new Set<string>([
  "1password",
  "adobe-cc",
  "amazon-prime",
  "apple-fitness",
  "apple-music",
  "apple-tv",
  "blick-plus",
  "chatgpt",
  "claude-pro",
  "cumulus-extra",
  "dazn",
  "disney-plus",
  "fitnesscenter",
  "galaxus-plus",
  "gartenpflege",
  "google-one",
  "guardian",
  "icloud",
  "linkedin",
  "mobility",
  "ms365",
  "netflix",
  "notion",
  "nzz",
  "reinigung",
  "salt-home",
  "salt-mobile",
  "sbb-ga",
  "sbb-halbtax",
  "schwimmbad",
  "security",
  "slack",
  "spotify",
  "strava",
  "sunrise-internet",
  "sunrise-mobile",
  "swisscom-internet",
  "swisscom-mobile",
  "tagi",
  "tidal",
  "wingo",
  "yt-premium",
]);

function resolveBrandId(providerId: string): string {
  return ID_ALIASES[providerId] ?? providerId;
}

interface Props {
  providerId: string;
  size?: number;
  className?: string;
}

export default function ProviderBrandIcon({ providerId, size = 20, className }: Props) {
  const resolvedId = resolveBrandId(providerId);
  const BrandIcon = BRAND_MAP[resolvedId];
  const localId = LOCAL_ICON_IDS.has(providerId)
    ? providerId
    : (LOCAL_ICON_IDS.has(resolvedId) ? resolvedId : null);

  if (localId) {
    return (
      <div
        className={clsx(
          "flex items-center justify-center rounded-sm bg-white/5 flex-shrink-0 overflow-hidden",
          className
        )}
        style={{ width: size, height: size }}
      >
        <img
          src={`/provider-icons/${localId}.svg`}
          alt=""
          aria-hidden="true"
          className="w-[140%] h-[140%] object-contain grayscale opacity-80"
          loading="lazy"
        />
      </div>
    );
  }

  if (BrandIcon) {
    return (
      <div
        className={clsx(
          "flex items-center justify-center rounded-sm bg-white/5 flex-shrink-0 overflow-hidden",
          className
        )}
        style={{ width: size, height: size }}
      >
        <BrandIcon size={Math.round(size * 1.3)} className="filter-grayscale text-text-secondary" />
      </div>
    );
  }

  // Fallback: Globe icon
  return (
    <div
      className={clsx(
        "flex items-center justify-center rounded-sm bg-white/5 flex-shrink-0 overflow-hidden",
        className
      )}
      style={{ width: size, height: size }}
    >
      <Globe className="text-text-tertiary" style={{ width: size * 1.2, height: size * 1.2 }} />
    </div>
  );
}
