/**
 * ProviderIcon — Shows provider favicon via Google S2 with Globe fallback.
 */
import { useState } from "react";
import { Globe } from "lucide-react";
import { getFaviconUrl } from "@/services/faviconService";
import { clsx } from "clsx";

interface Props {
  website?: string;
  name: string;
  size?: number;        // px, default 20
  className?: string;
}

export default function ProviderIcon({ website, name, size = 20, className }: Props) {
  const [failed, setFailed] = useState(false);
  const faviconUrl = website ? getFaviconUrl(website, 32) : "";

  if (!faviconUrl || failed) {
    return (
      <div
        className={clsx(
          "flex items-center justify-center rounded bg-bg-surface2 flex-shrink-0",
          className
        )}
        style={{ width: size, height: size }}
      >
        <Globe className="text-text-tertiary" style={{ width: size * 0.6, height: size * 0.6 }} />
      </div>
    );
  }

  return (
    <img
      src={faviconUrl}
      alt={name}
      width={size}
      height={size}
      className={clsx("rounded object-contain flex-shrink-0", className)}
      onError={() => setFailed(true)}
    />
  );
}
