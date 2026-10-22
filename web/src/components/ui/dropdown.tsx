import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { Check, ChevronDown } from "lucide-react";
import s from "./dropdown.module.css";

export interface DropdownOption {
  value: string;
  label: string;
  hint?: string;
  icon?: ReactNode;
  meta?: string;
}

export interface DropdownProps {
  options: DropdownOption[];
  value: string;
  onChange: (value: string) => void;
  ariaLabel: string;
  prefix?: ReactNode;
  icon?: ReactNode;
  className?: string;
  minWidth?: number;
  disabled?: boolean;
  title?: string;
}

interface MenuPosition {
  left: number;
  top: number;
  width: number;
}

const MENU_GAP = 4;
const VIEWPORT_MARGIN = 8;

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), Math.max(min, max));
}

export function Dropdown({
  options,
  value,
  onChange,
  ariaLabel,
  prefix,
  icon,
  className,
  minWidth = 160,
  disabled = false,
  title,
}: DropdownProps) {
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const [position, setPosition] = useState<MenuPosition | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const listId = useId();
  const optionIdPrefix = useId();

  const selectedIndex = Math.max(
    0,
    options.findIndex((option) => option.value === value),
  );
  const selected = options[selectedIndex];

  const measure = useCallback(() => {
    const trigger = triggerRef.current;
    if (!trigger) return;
    const rect = trigger.getBoundingClientRect();
    const menuHeight = menuRef.current?.offsetHeight ?? 0;
    const width = Math.min(
      Math.max(rect.width, minWidth),
      Math.max(minWidth, window.innerWidth - VIEWPORT_MARGIN * 2),
    );
    const left = clamp(rect.left, VIEWPORT_MARGIN, window.innerWidth - width - VIEWPORT_MARGIN);
    let top = rect.bottom + MENU_GAP;
    if (menuHeight > 0 && top + menuHeight > window.innerHeight - VIEWPORT_MARGIN) {
      const above = rect.top - menuHeight - MENU_GAP;
      top = above >= VIEWPORT_MARGIN ? above : Math.max(VIEWPORT_MARGIN, window.innerHeight - menuHeight - VIEWPORT_MARGIN);
    }
    setPosition((previous) =>
      previous && previous.left === left && previous.top === top && previous.width === width
        ? previous
        : { left, top, width },
    );
  }, [minWidth]);

  useLayoutEffect(() => {
    if (!open) {
      setPosition(null);
      return;
    }
    measure();
  }, [open, measure]);

  useEffect(() => {
    if (!open) return;
    const onScroll = () => measure();
    const onResize = () => measure();
    window.addEventListener("resize", onResize);
    window.addEventListener("scroll", onScroll, true);
    return () => {
      window.removeEventListener("resize", onResize);
      window.removeEventListener("scroll", onScroll, true);
    };
  }, [open, measure]);

  useEffect(() => {
    if (!open) return;
    setActiveIndex(selectedIndex);
    menuRef.current?.focus();
  }, [open, selectedIndex]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as Node | null;
      if (!target) return;
      if (triggerRef.current?.contains(target)) return;
      if (menuRef.current?.contains(target)) return;
      setOpen(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    return () => document.removeEventListener("mousedown", onPointerDown);
  }, [open]);

  const commit = useCallback(
    (index: number) => {
      const option = options[index];
      setOpen(false);
      triggerRef.current?.focus();
      if (option && option.value !== value) onChange(option.value);
    },
    [onChange, options, value],
  );

  const onMenuKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
      triggerRef.current?.focus();
      return;
    }
    if (event.key === "Tab") {
      setOpen(false);
      return;
    }
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      commit(activeIndex);
      return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp" || event.key === "Home" || event.key === "End") {
      event.preventDefault();
      const last = options.length - 1;
      if (last < 0) return;
      setActiveIndex((previous) => {
        if (event.key === "Home") return 0;
        if (event.key === "End") return last;
        const delta = event.key === "ArrowDown" ? 1 : -1;
        return (previous + delta + options.length) % options.length;
      });
    }
  };

  const onTriggerKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>) => {
    if (disabled) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      setOpen(true);
    }
  };

  return (
    <span className={[s.root, className].filter(Boolean).join(" ")}>
      <button
        ref={triggerRef}
        type="button"
        className={s.trigger}
        data-open={open ? "true" : undefined}
        onClick={() => setOpen((previous) => !previous)}
        onKeyDown={onTriggerKeyDown}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={ariaLabel}
        disabled={disabled}
        title={title}
      >
        {prefix ? <span className={s.prefix}>{prefix}</span> : null}
        {icon ? <span className={s.icon} aria-hidden="true">{icon}</span> : null}
        <span className={s.value}>{selected?.label ?? ""}</span>
        <ChevronDown size={14} className={s.chevron} aria-hidden="true" />
      </button>

      {open && typeof document !== "undefined"
        ? createPortal(
            <div
              ref={menuRef}
              id={listId}
              className={s.menu}
              role="listbox"
              aria-label={ariaLabel}
              tabIndex={-1}
              onKeyDown={onMenuKeyDown}
              aria-activedescendant={`${optionIdPrefix}-${activeIndex}`}
              style={{
                left: position?.left ?? 0,
                top: position?.top ?? 0,
                width: position?.width,
                visibility: position ? "visible" : "hidden",
              }}
            >
              {options.length === 0 ? <div className={s.emptyItem}>没有可选项</div> : null}
              {options.map((option, index) => (
                <div
                  key={option.value}
                  id={`${optionIdPrefix}-${index}`}
                  role="option"
                  aria-selected={option.value === value}
                  className={s.item}
                  data-active={index === activeIndex ? "true" : undefined}
                  data-selected={option.value === value ? "true" : undefined}
                  title={option.hint}
                  onMouseEnter={() => setActiveIndex(index)}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => commit(index)}
                >
                  {option.icon ? <span className={s.itemIcon} aria-hidden="true">{option.icon}</span> : null}
                  <span className={s.itemLabel}>{option.label}</span>
                  {option.meta ? <span className={s.itemMeta}>{option.meta}</span> : null}
                  {option.value === value ? <Check size={14} className={s.check} aria-hidden="true" /> : null}
                </div>
              ))}
            </div>,
            document.body,
          )
        : null}
    </span>
  );
}
