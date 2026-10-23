import { type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent, type SyntheticEvent, useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { X, ZoomIn, ZoomOut } from "lucide-react";
import s from "./zoomable-image.module.css";

const MIN_SCALE = 0.5;
const MAX_SCALE = 8;
const STEP_FACTOR = 1.4;
const DRAG_THRESHOLD_PX = 3;

interface ZoomableImageProps {
  src: string;
  alt: string;
  title?: string;
  frameClassName?: string;
  onError?: () => void;
}

interface ViewState {
  scale: number;
  x: number;
  y: number;
}

interface DragState {
  pointerId: number;
  startX: number;
  startY: number;
  originX: number;
  originY: number;
  moved: boolean;
}

const IDENTITY: ViewState = { scale: 1, x: 0, y: 0 };

function clampScale(value: number): number {
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, value));
}

function zoomAtPoint(current: ViewState, anchorX: number, anchorY: number, factor: number): ViewState {
  const scale = clampScale(current.scale * factor);
  if (scale === current.scale) return current;
  const k = scale / current.scale;
  return {
    scale,
    x: anchorX - (anchorX - current.x) * k,
    y: anchorY - (anchorY - current.y) * k,
  };
}

export function ZoomableImage({ src, alt, title, frameClassName, onError }: ZoomableImageProps) {
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<ViewState>(IDENTITY);
  const [panning, setPanning] = useState(false);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const overlayRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<ViewState>(IDENTITY);
  const dragRef = useRef<DragState | null>(null);
  const draggedRef = useRef(false);
  const restoreFocusRef = useRef<HTMLElement | null>(null);

  const applyView = useCallback((next: ViewState) => {
    viewRef.current = next;
    setView(next);
  }, []);

  const reset = useCallback(() => applyView(IDENTITY), [applyView]);

  const close = useCallback(() => setOpen(false), []);

  const openViewer = useCallback(() => {
    applyView(IDENTITY);
    setOpen(true);
  }, [applyView]);

  const zoomBy = useCallback(
    (factor: number) => {
      applyView(zoomAtPoint(viewRef.current, 0, 0, factor));
    },
    [applyView],
  );

  useEffect(() => {
    if (!open) {
      const target = restoreFocusRef.current;
      restoreFocusRef.current = null;
      target?.focus?.();
      return;
    }

    restoreFocusRef.current = triggerRef.current ?? (document.activeElement as HTMLElement | null);
    overlayRef.current?.focus();
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        setOpen(false);
        return;
      }
      if (event.key === "+" || event.key === "=") {
        event.preventDefault();
        zoomBy(STEP_FACTOR);
        return;
      }
      if (event.key === "-" || event.key === "_") {
        event.preventDefault();
        zoomBy(1 / STEP_FACTOR);
        return;
      }
      if (event.key === "0") {
        event.preventDefault();
        reset();
      }
    };

    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = previousOverflow;
    };
  }, [open, reset, zoomBy]);

  useEffect(() => {
    const overlay = overlayRef.current;
    if (!open || !overlay) return;

    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const rect = overlay.getBoundingClientRect();
      const anchorX = event.clientX - (rect.left + rect.width / 2);
      const anchorY = event.clientY - (rect.top + rect.height / 2);
      const factor = Math.exp(-event.deltaY * 0.0016);
      applyView(zoomAtPoint(viewRef.current, anchorX, anchorY, factor));
    };

    overlay.addEventListener("wheel", onWheel, { passive: false });
    return () => overlay.removeEventListener("wheel", onWheel);
  }, [open, applyView]);

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.stopPropagation();
    if (event.button !== 0) return;
    draggedRef.current = false;
    dragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      originX: viewRef.current.x,
      originY: viewRef.current.y,
      moved: false,
    };
    const target = event.currentTarget;
    if (typeof target.setPointerCapture === "function") target.setPointerCapture(event.pointerId);
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const dx = event.clientX - drag.startX;
    const dy = event.clientY - drag.startY;
    if (!drag.moved) {
      if (Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) return;
      drag.moved = true;
      setPanning(true);
    }
    applyView({ scale: viewRef.current.scale, x: drag.originX + dx, y: drag.originY + dy });
  };

  const endDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    draggedRef.current = drag.moved;
    dragRef.current = null;
    setPanning(false);
    const target = event.currentTarget;
    if (typeof target.releasePointerCapture === "function") target.releasePointerCapture(event.pointerId);
  };

  const onClick = (event: ReactMouseEvent<HTMLDivElement>) => {
    event.stopPropagation();
    if (draggedRef.current) {
      draggedRef.current = false;
      return;
    }
    if (event.target === event.currentTarget) close();
  };

  const onDoubleClick = (event: ReactMouseEvent<HTMLDivElement>) => {
    event.stopPropagation();
    draggedRef.current = false;
    reset();
  };

  const stopEvent = (event: SyntheticEvent) => event.stopPropagation();

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className={frameClassName ? `${s.trigger} ${frameClassName}` : s.trigger}
        title={title || alt}
        aria-haspopup="dialog"
        aria-label={`查看大图：${alt}`}
        onClick={(event) => {
          event.stopPropagation();
          openViewer();
        }}
        onPointerDown={stopEvent}
      >
        <img src={src} alt={alt} loading="lazy" decoding="async" onError={onError} />
      </button>
      {open
        ? createPortal(
            <div
              ref={overlayRef}
              className={s.overlay}
              role="dialog"
              aria-modal="true"
              aria-label={`查看大图：${alt}`}
              tabIndex={-1}
              data-panning={panning ? "true" : "false"}
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={endDrag}
              onPointerCancel={endDrag}
              onClick={onClick}
              onDoubleClick={onDoubleClick}
              onContextMenu={stopEvent}
            >
              <img
                className={s.stageImage}
                src={src}
                alt={alt}
                draggable={false}
                decoding="async"
                style={{ transform: `translate3d(${view.x}px, ${view.y}px, 0) scale(${view.scale})` }}
              />
              <div className={s.toolbar} onClick={stopEvent} onPointerDown={stopEvent} onDoubleClick={stopEvent}>
                <button type="button" className={s.iconButton} aria-label="缩小" onClick={() => zoomBy(1 / STEP_FACTOR)}>
                  <ZoomOut size={16} strokeWidth={1.8} aria-hidden="true" />
                </button>
                <button type="button" className={s.scaleButton} aria-label="复位缩放" onClick={reset}>
                  {Math.round(view.scale * 100)}%
                </button>
                <button type="button" className={s.iconButton} aria-label="放大" onClick={() => zoomBy(STEP_FACTOR)}>
                  <ZoomIn size={16} strokeWidth={1.8} aria-hidden="true" />
                </button>
                <span className={s.divider} aria-hidden="true" />
                <button type="button" className={s.iconButton} aria-label="关闭大图" onClick={close}>
                  <X size={16} strokeWidth={1.8} aria-hidden="true" />
                </button>
              </div>
              <p className={s.hint}>滚轮缩放 · 拖拽平移 · 双击复位 · Esc 关闭</p>
            </div>,
            document.body,
          )
        : null}
    </>
  );
}