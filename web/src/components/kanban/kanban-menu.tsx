import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import s from "./kanban-menu.module.css";

export interface KanbanMenuItem {
  key: string;
  label: string;
  icon?: ReactNode;
  hint?: string;
  disabled?: boolean;
  danger?: boolean;
}

interface KanbanMenuProps {
  label: string;
  icon: ReactNode;
  items: KanbanMenuItem[];
  onSelect: (key: string) => void;
}

const MENU_WIDTH = 208;
const MENU_GAP = 4;
const VIEWPORT_MARGIN = 8;

interface MenuPosition {
  left: number;
  top: number;
}

export function KanbanMenu({ label, icon, items, onSelect }: KanbanMenuProps) {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<MenuPosition | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const measure = useCallback(() => {
    const trigger = triggerRef.current;
    if (!trigger) return;
    const rect = trigger.getBoundingClientRect();
    const left = Math.min(
      Math.max(rect.right - MENU_WIDTH, VIEWPORT_MARGIN),
      Math.max(VIEWPORT_MARGIN, window.innerWidth - MENU_WIDTH - VIEWPORT_MARGIN),
    );
    const top = rect.bottom + MENU_GAP;
    setPosition((previous) =>
      previous && previous.left === left && previous.top === top ? previous : { left, top },
    );
  }, []);

  useEffect(() => {
    if (!open) {
      setPosition(null);
      return;
    }
    measure();
    menuRef.current?.focus();
    const onScroll = () => measure();
    window.addEventListener("resize", measure);
    window.addEventListener("scroll", onScroll, true);
    return () => {
      window.removeEventListener("resize", measure);
      window.removeEventListener("scroll", onScroll, true);
    };
  }, [open, measure]);

  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as Node | null;
      if (!target) return;
      if (triggerRef.current?.contains(target)) return;
      if (menuRef.current?.contains(target)) return;
      close();
    };
    document.addEventListener("mousedown", onPointerDown);
    return () => document.removeEventListener("mousedown", onPointerDown);
  }, [open]);

  const select = (item: KanbanMenuItem) => {
    if (item.disabled) return;
    setOpen(false);
    triggerRef.current?.focus();
    onSelect(item.key);
  };

  return (
    <span className={s.root}>
      <button
        ref={triggerRef}
        type="button"
        className={s.trigger}
        data-open={open ? "true" : undefined}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={label}
        title={label}
        onClick={() => setOpen((previous) => !previous)}
      >
        {icon}
      </button>

      {open && typeof document !== "undefined"
        ? createPortal(
            <div
              ref={menuRef}
              className={s.menu}
              role="menu"
              aria-label={label}
              tabIndex={-1}
              style={{
                left: position?.left ?? 0,
                top: position?.top ?? 0,
                visibility: position ? "visible" : "hidden",
              }}
              onKeyDown={(event) => {
                if (event.key !== "Escape") return;
                event.stopPropagation();
                setOpen(false);
                triggerRef.current?.focus();
              }}
            >
              {items.map((item) => (
                <button
                  key={item.key}
                  type="button"
                  role="menuitem"
                  className={s.item}
                  data-danger={item.danger ? "true" : undefined}
                  disabled={item.disabled}
                  title={item.hint}
                  onClick={() => select(item)}
                >
                  {item.icon ? (
                    <span className={s.icon} aria-hidden="true">
                      {item.icon}
                    </span>
                  ) : null}
                  <span>{item.label}</span>
                </button>
              ))}
            </div>,
            document.body,
          )
        : null}
    </span>
  );
}
