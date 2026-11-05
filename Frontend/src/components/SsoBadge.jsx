export function isAppSsoEnabled(ssoMode) {
  return ssoMode === 'oidc';
}

const BADGE_CONFIG = {
  sso: {
    label: 'SSO',
    title: 'Signs you in through Downstream Hub',
    style: {
      background: 'var(--color-primary-soft)',
      color: 'var(--color-link)',
    },
  },
  direct: {
    label: 'Direct',
    title: 'Opens the link directly',
    style: {
      background: 'var(--color-bg-light)',
      color: 'var(--color-text-steel)',
    },
  },
};

export default function SsoBadge({ ssoMode, title, style }) {
  const variant = isAppSsoEnabled(ssoMode) ? 'sso' : 'direct';
  const config = BADGE_CONFIG[variant];

  return (
    <span
      title={title ?? config.title}
      style={{
        ...styles.badge,
        ...config.style,
        ...style,
      }}
    >
      {config.label}
    </span>
  );
}

const styles = {
  badge: {
    display: 'inline-block',
    padding: '2px var(--space-2)',
    borderRadius: 'var(--radius-sm)',
    fontSize: 'var(--text-xs)',
    fontWeight: 'var(--font-weight-medium)',
    lineHeight: 1.4,
    whiteSpace: 'nowrap',
  },
};
