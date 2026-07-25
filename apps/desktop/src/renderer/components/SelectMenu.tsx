import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Icon, ReasoningDepthGlyph, type IconName } from "./Icons";

export interface SelectMenuOption<T extends string> {
  value: T;
  label: string;
  description?: string;
  icon?: IconName;
  tone?: "default" | "accent" | "warning" | "danger";
  depthLevel?: 1 | 2 | 3;
}

interface SelectMenuProps<T extends string> {
  value: T;
  options: Array<SelectMenuOption<T>>;
  onChange: (value: T) => void;
  icon?: IconName;
  disabled?: boolean;
  placement?: "top" | "bottom";
  size?: "compact" | "regular";
  variant?: "default" | "reasoning";
  ariaLabel: string;
  className?: string;
}

export function SelectMenu<T extends string>({
  value,
  options,
  onChange,
  icon,
  disabled = false,
  placement = "bottom",
  size = "compact",
  variant = "default",
  ariaLabel,
  className = "",
}: SelectMenuProps<T>) {
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const menuId = useId();
  const selected = useMemo(() => options.find((option) => option.value === value) ?? options[0], [options, value]);

  useEffect(() => {
    if (!open) return;
    const selectedIndex = options.findIndex((option) => option.value === value);
    setActiveIndex(Math.max(0, selectedIndex));
    const close = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, [open, options, value]);

  const commit = (option: SelectMenuOption<T>) => {
    onChange(option.value);
    setOpen(false);
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>) => {
    if (disabled) return;
    if (!open && ["ArrowDown", "ArrowUp", "Enter", " "].includes(event.key)) {
      event.preventDefault();
      setOpen(true);
      return;
    }
    if (!open) return;
    if (event.key === "Escape") {
      event.preventDefault();
      setOpen(false);
    } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const direction = event.key === "ArrowDown" ? 1 : -1;
      setActiveIndex((index) => (index + direction + options.length) % options.length);
    } else if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      const option = options[activeIndex];
      if (option) commit(option);
    }
  };

  return (
    <div ref={rootRef} className={`select-menu select-menu--${size} select-menu--${variant} ${className}`.trim()}>
      <button
        type="button"
        className={`select-menu__trigger${open ? " is-open" : ""}`}
        aria-label={ariaLabel}
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-controls={menuId}
        disabled={disabled}
        onClick={() => setOpen((value) => !value)}
        onKeyDown={handleKeyDown}
      >
        {variant === "reasoning" && selected?.depthLevel
          ? <ReasoningDepthGlyph level={selected.depthLevel} size={size === "compact" ? 16 : 17} />
          : icon
            ? <Icon name={icon} size={size === "compact" ? 14 : 15} />
            : selected?.icon && <Icon name={selected.icon} size={size === "compact" ? 14 : 15} />}
        <span>{selected?.label}</span>
        <Icon name="chevron-down" size={12} className="select-menu__chevron" />
      </button>
      {open && (
        <div id={menuId} role="listbox" aria-label={ariaLabel} className={`select-menu__popover select-menu__popover--${placement}`}>
          <div className="select-menu__surface">
            {options.map((option, index) => (
              <button
                key={option.value}
                type="button"
                role="option"
                aria-selected={option.value === value}
                data-depth={option.depthLevel}
                className={`select-menu__option select-menu__option--${option.tone ?? "default"}${index === activeIndex ? " is-active" : ""}`}
                onMouseEnter={() => setActiveIndex(index)}
                onClick={() => commit(option)}
              >
                <span className="select-menu__option-icon">
                  {option.depthLevel
                    ? <ReasoningDepthGlyph level={option.depthLevel} size={18} />
                    : option.icon
                      ? <Icon name={option.icon} size={15} />
                      : <span className="select-menu__option-dot" />}
                </span>
                <span className="select-menu__option-copy">
                  <strong>{option.label}</strong>
                  {option.description && <small>{option.description}</small>}
                  {option.depthLevel && (
                    <span className="select-menu__depth-meter" aria-hidden="true">
                      {[1, 2, 3].map((segment) => <i className={segment <= option.depthLevel! ? "is-live" : ""} key={segment} />)}
                    </span>
                  )}
                </span>
                {option.value === value && <Icon name="check" size={14} />}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
