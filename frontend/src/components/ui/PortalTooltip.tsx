/**
 * PortalTooltip — Tooltip, der nicht abgeschnitten wird.
 *
 * Absolut positionierte Tooltips werden von jedem Vorfahren mit `overflow: hidden`
 * beschnitten (Karten, Chart-Container, die eingeklappte Rail). Diese Komponente
 * rendert per Portal an `document.body`, positioniert `fixed` relativ zum Anker
 * und klemmt das Ergebnis an den Viewport — inkl. Umklappen auf die Gegenseite,
 * wenn auf der bevorzugten Seite kein Platz ist.
 */
import { useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

type Placement = "top" | "bottom" | "right";

/** Mindestabstand zu Anker und Fensterrand. */
const GAP = 8;

export default function PortalTooltip({
  anchorRef,
  visible,
  placement = "top",
  className,
  style,
  children,
}: {
  anchorRef: React.RefObject<HTMLElement | null>;
  visible: boolean;
  placement?: Placement;
  className?: string;
  style?: React.CSSProperties;
  children: React.ReactNode;
}) {
  const boxRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

  // useLayoutEffect: messen und positionieren vor dem Paint, sonst blitzt der
  // Tooltip einen Frame lang an der Startposition auf.
  useLayoutEffect(() => {
    if (!visible || !anchorRef.current || !boxRef.current) {
      setPos(null);
      return;
    }

    const place = () => {
      const anchor = anchorRef.current;
      const box = boxRef.current;
      if (!anchor || !box) return;

      const a = anchor.getBoundingClientRect();
      const b = box.getBoundingClientRect();
      const { innerWidth: vw, innerHeight: vh } = window;

      let top: number;
      let left: number;

      if (placement === "right") {
        top = a.top + a.height / 2 - b.height / 2;
        left = a.right + GAP;
        // Kein Platz rechts → nach links klappen
        if (left + b.width > vw - GAP) left = a.left - b.width - GAP;
      } else if (placement === "bottom") {
        top = a.bottom + GAP;
        left = a.left + a.width / 2 - b.width / 2;
        if (top + b.height > vh - GAP) top = a.top - b.height - GAP;
      } else {
        top = a.top - b.height - GAP;
        left = a.left + a.width / 2 - b.width / 2;
        if (top < GAP) top = a.bottom + GAP;
      }

      setPos({
        top: Math.max(GAP, Math.min(top, vh - b.height - GAP)),
        left: Math.max(GAP, Math.min(left, vw - b.width - GAP)),
      });
    };

    place();

    // `fixed` folgt dem Anker nicht — bei Scroll/Resize neu setzen, sonst
    // steht der Tooltip irgendwo im Nichts.
    window.addEventListener("scroll", place, true);
    window.addEventListener("resize", place);
    return () => {
      window.removeEventListener("scroll", place, true);
      window.removeEventListener("resize", place);
    };
  }, [visible, placement, anchorRef]);

  if (!visible) return null;

  return createPortal(
    <div
      ref={boxRef}
      className={className}
      style={{
        position: "fixed",
        // Vor der ersten Messung ausserhalb des Sichtfelds parken, damit die
        // Box ihre echte Grösse bekommt, ohne kurz an (0,0) zu erscheinen.
        top: pos?.top ?? -9999,
        left: pos?.left ?? -9999,
        zIndex: 200,
        pointerEvents: "none",
        ...style,
      }}
    >
      {children}
    </div>,
    document.body
  );
}
