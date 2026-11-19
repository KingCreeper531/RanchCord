import {
  Children,
  cloneElement,
  forwardRef,
  type ButtonHTMLAttributes,
  type CSSProperties,
  type InputHTMLAttributes,
  type ReactElement,
  type ReactNode,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';
import { create } from 'zustand';
import { AnimatePresence, motion } from 'motion/react';
import { X } from '@phosphor-icons/react';
import { fileUrl } from '../lib/server';
import { useBrand } from '../lib/brand';
import { initials } from '../lib/format';
import { isMobileDevice } from '../lib/platform';
import type { Presence, User } from '../types';

/* ---------------- Spinner ---------------- */

export function Spinner({ size = 18, className = '' }: { size?: number; className?: string }) {
  return <span className={`ui-spinner ${className}`} style={{ width: size, height: size }} aria-label="Loading" />;
}

/* ---------------- Buttons ---------------- */

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'danger-ghost' | 'link';

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: 'sm' | 'md' | 'lg';
  loading?: boolean;
  icon?: ReactNode;
  block?: boolean;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'primary', size = 'md', loading, icon, block, className = '', children, disabled, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      className={`ui-btn ui-btn-${variant} ui-btn-${size}${block ? ' ui-btn-block' : ''}${loading ? ' is-loading' : ''} ${className}`}
      disabled={disabled || loading}
      {...rest}
    >
      {loading && <Spinner size={16} className="ui-btn-spinner" />}
      <span className="ui-btn-content">
        {icon}
        {children}
      </span>
    </button>
  );
});

interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  label: string;
  active?: boolean;
  danger?: boolean;
  size?: number;
  tooltipSide?: Side;
  children: ReactNode;
}

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { label, active, danger, size = 32, tooltipSide = 'top', className = '', children, ...rest },
  ref,
) {
  return (
    <Tooltip label={label} side={tooltipSide}>
      <button
        ref={ref}
        aria-label={label}
        className={`ui-icon-btn${active ? ' is-active' : ''}${danger ? ' is-danger' : ''} ${className}`}
        style={{ width: size, height: size }}
        {...rest}
      >
        {children}
      </button>
    </Tooltip>
  );
});

/* ---------------- Inputs ---------------- */

interface FieldProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'prefix'> {
  label?: string;
  hint?: ReactNode;
  error?: string | null;
  prefix?: ReactNode;
  suffix?: ReactNode;
}

export const TextField = forwardRef<HTMLInputElement, FieldProps>(function TextField(
  { label, hint, error, prefix, suffix, className = '', id, ...rest },
  ref,
) {
  const fallbackId = useRef(`f${Math.random().toString(36).slice(2, 8)}`).current;
  const inputId = id ?? fallbackId;
  return (
    <div className={`ui-field${error ? ' has-error' : ''} ${className}`}>
      {label && (
        <label className="ui-field-label" htmlFor={inputId}>
          {label}
          {error && <span className="ui-field-error"> · {error}</span>}
        </label>
      )}
      <div className="ui-input-wrap">
        {prefix && <span className="ui-input-affix">{prefix}</span>}
        <input ref={ref} id={inputId} className="ui-input" {...rest} />
        {suffix && <span className="ui-input-affix ui-input-suffix">{suffix}</span>}
      </div>
      {hint && !error && <div className="ui-field-hint">{hint}</div>}
      {!label && error && <div className="ui-field-hint ui-field-error">{error}</div>}
    </div>
  );
});

export function Switch({ checked, onChange, label, disabled }: { checked: boolean; onChange: (v: boolean) => void; label?: string; disabled?: boolean }) {
  return (
    <button
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      className={`ui-switch${checked ? ' is-on' : ''}`}
      onClick={() => onChange(!checked)}
    >
      <span className="ui-switch-thumb" />
    </button>
  );
}

export function Slider({ value, min = 0, max = 1, step = 0.01, onChange, label }: { value: number; min?: number; max?: number; step?: number; onChange: (v: number) => void; label?: string }) {
  const pct = ((value - min) / (max - min)) * 100;
  return (
    <input
      type="range"
      className="ui-slider"
      min={min}
      max={max}
      step={step}
      value={value}
      aria-label={label}
      style={{ '--pct': `${pct}%` } as CSSProperties}
      onChange={(e) => onChange(Number(e.target.value))}
    />
  );
}

/* ---------------- Avatar ---------------- */

export function Avatar({
  user,
  size = 32,
  presence,
  speaking,
  className = '',
  onClick,
}: {
  user: Pick<User, 'displayName' | 'avatar' | 'bannerColor'> | null | undefined;
  size?: number;
  presence?: Presence | null;
  speaking?: boolean;
  className?: string;
  onClick?: (e: React.MouseEvent<HTMLElement>) => void;
}) {
  const [broken, setBroken] = useState(false);
  const dot = Math.max(8, Math.round(size * 0.3));
  const src = user?.avatar && !broken ? fileUrl(user.avatar) : null;
  const style = {
    width: size,
    height: size,
    '--dot': `${dot}px`,
    '--avatar-bg': user?.bannerColor ?? 'var(--bg-4)',
  } as CSSProperties;
  return (
    <span
      className={`ui-avatar${presence ? ' has-presence' : ''}${speaking ? ' is-speaking' : ''}${onClick ? ' is-clickable' : ''} ${className}`}
      style={style}
      onClick={onClick}
    >
      <span className="ui-avatar-img">
        {src ? (
          <img src={src} alt="" draggable={false} loading="lazy" decoding="async" onError={() => setBroken(true)} />
        ) : (
          <span className="ui-avatar-initials" style={{ fontSize: Math.max(10, size * 0.38) }}>
            {initials(user?.displayName ?? '?')}
          </span>
        )}
      </span>
      {presence && <span className={`ui-presence ui-presence-${presence}`} aria-label={presence} />}
    </span>
  );
}

export function PresenceDot({ status, size = 10 }: { status: Presence; size?: number }) {
  return <span className={`ui-presence ui-presence-${status} is-standalone`} style={{ '--dot': `${size}px` } as CSSProperties} />;
}

export const presenceLabel: Record<Presence, string> = {
  online: 'Online',
  idle: 'Idle',
  dnd: 'Do Not Disturb',
  offline: 'Offline',
};

/* ---------------- Floating positioning ---------------- */

export type Side = 'top' | 'bottom' | 'left' | 'right';

export function placeFloating(
  anchor: DOMRect,
  size: { width: number; height: number },
  side: Side,
  gap = 8,
  align: 'center' | 'start' | 'end' = 'center',
) {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const pad = 8;
  let s = side;
  const fits = {
    top: anchor.top - gap - size.height >= pad,
    bottom: anchor.bottom + gap + size.height <= vh - pad,
    left: anchor.left - gap - size.width >= pad,
    right: anchor.right + gap + size.width <= vw - pad,
  };
  const opposite: Record<Side, Side> = { top: 'bottom', bottom: 'top', left: 'right', right: 'left' };
  if (!fits[s] && fits[opposite[s]]) s = opposite[s];
  let left: number;
  let top: number;
  if (s === 'top' || s === 'bottom') {
    top = s === 'top' ? anchor.top - gap - size.height : anchor.bottom + gap;
    left =
      align === 'start' ? anchor.left : align === 'end' ? anchor.right - size.width : anchor.left + anchor.width / 2 - size.width / 2;
  } else {
    left = s === 'left' ? anchor.left - gap - size.width : anchor.right + gap;
    top = align === 'start' ? anchor.top : align === 'end' ? anchor.bottom - size.height : anchor.top + anchor.height / 2 - size.height / 2;
  }
  left = Math.min(Math.max(pad, left), vw - size.width - pad);
  top = Math.min(Math.max(pad, top), vh - size.height - pad);
  return { left, top, side: s };
}

/* ---------------- Tooltip ---------------- */

function TooltipBubble({ rect, side, children }: { rect: DOMRect; side: Side; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number; side: Side } | null>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    setPos(placeFloating(rect, { width: el.offsetWidth, height: el.offsetHeight }, side, 8));
  }, [rect, side]);
  return (
    <div
      ref={ref}
      role="tooltip"
      className={`ui-tooltip ui-tooltip-${pos?.side ?? side}`}
      style={{ left: pos?.left ?? -9999, top: pos?.top ?? -9999, opacity: pos ? 1 : 0 }}
    >
      {children}
    </div>
  );
}

const hoverCapable = typeof matchMedia !== 'undefined' && matchMedia('(hover: hover)').matches && !isMobileDevice;

export function Tooltip({ label, side = 'top', delay = 250, children }: { label: ReactNode; side?: Side; delay?: number; children: ReactElement }) {
  const [rect, setRect] = useState<DOMRect | null>(null);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  if (!hoverCapable || !label) return children;
  const child = Children.only(children) as ReactElement<Record<string, (e: React.MouseEvent<HTMLElement>) => void>>;
  const props = child.props;
  return (
    <>
      {cloneElement(child, {
        onMouseEnter: (e: React.MouseEvent<HTMLElement>) => {
          props.onMouseEnter?.(e);
          const el = e.currentTarget;
          clearTimeout(timer.current);
          timer.current = window.setTimeout(() => setRect(el.getBoundingClientRect()), delay);
        },
        onMouseLeave: (e: React.MouseEvent<HTMLElement>) => {
          props.onMouseLeave?.(e);
          clearTimeout(timer.current);
          setRect(null);
        },
        onMouseDown: (e: React.MouseEvent<HTMLElement>) => {
          props.onMouseDown?.(e);
          clearTimeout(timer.current);
          setRect(null);
        },
      })}
      {rect &&
        createPortal(
          <TooltipBubble rect={rect} side={side}>
            {label}
          </TooltipBubble>,
          document.body,
        )}
    </>
  );
}

/* ---------------- Menus (context menus & dropdowns) ---------------- */

export type MenuItem =
  | { label: string; icon?: ReactNode; danger?: boolean; disabled?: boolean; hint?: string; onSelect: () => void; checked?: boolean }
  | { separator: true }
  | { header: string };

interface MenuState {
  open: { items: MenuItem[]; x: number; y: number; anchor?: DOMRect; align?: 'start' | 'end' } | null;
}
const useMenu = create<MenuState>(() => ({ open: null }));

export function openMenu(e: { clientX: number; clientY: number } | DOMRect, items: MenuItem[], align: 'start' | 'end' = 'start') {
  if ('clientX' in e) useMenu.setState({ open: { items, x: e.clientX, y: e.clientY } });
  else useMenu.setState({ open: { items, x: e.left, y: e.bottom, anchor: e, align } });
}

export function closeMenu() {
  useMenu.setState({ open: null });
}

export function MenuHost() {
  const open = useMenu((s) => s.open);
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  useLayoutEffect(() => {
    if (!open || !ref.current) {
      setPos(null);
      return;
    }
    const el = ref.current;
    const size = { width: el.offsetWidth, height: el.offsetHeight };
    if (open.anchor) {
      const p = placeFloating(open.anchor, size, 'bottom', 6, open.align === 'end' ? 'end' : 'start');
      setPos({ left: p.left, top: p.top });
    } else {
      const left = Math.min(open.x, window.innerWidth - size.width - 8);
      const top = open.y + size.height > window.innerHeight - 8 ? Math.max(8, open.y - size.height) : open.y;
      setPos({ left, top });
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: Event) => {
      if (ref.current && !ref.current.contains(e.target as Node)) closeMenu();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeMenu();
    };
    window.addEventListener('pointerdown', onDown, true);
    window.addEventListener('keydown', onKey);
    window.addEventListener('resize', closeMenu);
    window.addEventListener('blur', closeMenu);
    return () => {
      window.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', closeMenu);
      window.removeEventListener('blur', closeMenu);
    };
  }, [open]);

  return createPortal(
    <AnimatePresence>
      {open && (
        <motion.div
          ref={ref}
          role="menu"
          className="ui-menu"
          style={{ left: pos?.left ?? -9999, top: pos?.top ?? -9999 }}
          initial={{ opacity: 0, scale: 0.97 }}
          animate={{ opacity: 1, scale: 1 }}
          exit={{ opacity: 0, scale: 0.97, transition: { duration: 0.08 } }}
          transition={{ duration: 0.12, ease: [0.22, 0.8, 0.24, 1] }}
          onContextMenu={(e) => e.preventDefault()}
        >
          {open.items.map((item, i) => {
            if ('separator' in item) return <div key={i} className="ui-menu-sep" />;
            if ('header' in item) return <div key={i} className="ui-menu-header">{item.header}</div>;
            return (
              <button
                key={i}
                role="menuitem"
                className={`ui-menu-item${item.danger ? ' is-danger' : ''}`}
                disabled={item.disabled}
                onClick={() => {
                  closeMenu();
                  item.onSelect();
                }}
              >
                <span className="ui-menu-label">{item.label}</span>
                {item.hint && <span className="ui-menu-hint">{item.hint}</span>}
                {item.checked !== undefined && <span className={`ui-menu-check${item.checked ? ' is-on' : ''}`} />}
                {item.icon && <span className="ui-menu-icon">{item.icon}</span>}
              </button>
            );
          })}
        </motion.div>
      )}
    </AnimatePresence>,
    document.body,
  );
}

/* ---------------- Modal shell ---------------- */

export function ModalFrame({
  title,
  subtitle,
  onClose,
  children,
  footer,
  size = 'md',
  className = '',
  hideClose,
}: {
  title?: ReactNode;
  subtitle?: ReactNode;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  size?: 'sm' | 'md' | 'lg' | 'xl';
  className?: string;
  hideClose?: boolean;
}) {
  return (
    <div className={`ui-modal ui-modal-${size} ${className}`} role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
      {!hideClose && (
        <button className="ui-modal-close" aria-label="Close" onClick={onClose}>
          <X size={20} />
        </button>
      )}
      {(title || subtitle) && (
        <header className="ui-modal-header">
          {title && <h2 className="ui-modal-title">{title}</h2>}
          {subtitle && <p className="ui-modal-subtitle">{subtitle}</p>}
        </header>
      )}
      <div className="ui-modal-body scroll">{children}</div>
      {footer && <footer className="ui-modal-footer">{footer}</footer>}
    </div>
  );
}

/* ---------------- Empty state ---------------- */

export function EmptyState({ title, body, art = true, children }: { title: string; body?: ReactNode; art?: boolean; children?: ReactNode }) {
  const brand = useBrand();
  return (
    <div className="ui-empty">
      {art && <img className="ui-empty-art" src={brand.logo} alt="" draggable={false} />}
      <h3>{title}</h3>
      {body && <p>{body}</p>}
      {children}
    </div>
  );
}

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="ui-kbd">{children}</kbd>;
}
