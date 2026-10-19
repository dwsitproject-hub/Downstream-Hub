import { useEffect, useRef, useId } from 'react';

const SIZE_MAX_WIDTH = {
  sm: 480,
  md: 560,
  lg: 640,
  xl: 720,
  xxl: 960,
};

/**
 * AdminModal — accessible overlay wrapper.
 * Provides: role="dialog", aria-modal, focus on open, Escape to close.
 *
 * Props:
 *   title        — optional heading (aria-labelledby)
 *   size         — 'sm' | 'md' | 'lg' | 'xl' | 'xxl' (default 'sm')
 *   wide         — legacy alias for size='lg' when size not set
 *   scrollable   — scroll body when content is tall (default true)
 *   footer       — optional sticky footer node (e.g. action buttons)
 *   disableClose — block Escape/backdrop close (e.g. while saving)
 *   onClose      — () => void
 *   children     — modal body content
 */
export default function AdminModal({
  title,
  size,
  wide = false,
  scrollable = true,
  footer,
  disableClose = false,
  onClose,
  children,
}) {
  const contentRef = useRef(null);
  const titleId = useId();

  const maxWidth = SIZE_MAX_WIDTH[size || (wide ? 'lg' : 'sm')] || SIZE_MAX_WIDTH.sm;

  useEffect(() => {
    const el = contentRef.current;
    if (!el) return;
    const focusable = el.querySelectorAll(
      'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
    );
    if (focusable.length > 0) focusable[0].focus();
  }, []);

  useEffect(() => {
    function handleKey(e) {
      if (e.key === 'Escape' && !disableClose) onClose?.();
    }
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [onClose, disableClose]);

  function handleBackdropClick(e) {
    if (e.target !== e.currentTarget || disableClose) return;
    onClose?.();
  }

  return (
    <div style={overlayStyle} role="presentation" onClick={handleBackdropClick}>
      <div
        ref={contentRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={title ? titleId : undefined}
        tabIndex={-1}
        style={{
          ...contentStyle,
          maxWidth,
          display: 'flex',
          flexDirection: 'column',
          maxHeight: scrollable ? '90vh' : undefined,
        }}
      >
        {title && (
          <h3 id={titleId} style={titleStyle}>
            {title}
          </h3>
        )}
        <div style={scrollable ? bodyScrollStyle : bodyStyle}>{children}</div>
        {footer && <div style={footerStyle}>{footer}</div>}
      </div>
    </div>
  );
}

const overlayStyle = {
  position: 'fixed',
  inset: 0,
  background: 'rgba(0,0,0,0.45)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  zIndex: 200,
  padding: 'var(--space-3)',
};

const contentStyle = {
  background: 'var(--color-bg-white)',
  borderRadius: 'var(--radius-lg)',
  padding: 'var(--space-4)',
  width: '100%',
  boxShadow: '0 8px 32px rgba(0,0,0,0.18)',
};

const titleStyle = {
  margin: '0 0 var(--space-3)',
  fontSize: 'var(--text-h3)',
  fontFamily: 'var(--font-heading)',
  fontWeight: 'var(--font-weight-semibold)',
  color: 'var(--color-text-charcoal)',
  flexShrink: 0,
};

const bodyStyle = {
  flex: '1 1 auto',
  minHeight: 0,
};

const bodyScrollStyle = {
  ...bodyStyle,
  overflowY: 'auto',
  maxHeight: 'calc(90vh - 8rem)',
};

const footerStyle = {
  flexShrink: 0,
  marginTop: 'var(--space-3)',
  paddingTop: 'var(--space-3)',
  borderTop: '1px solid var(--color-border-light)',
};
