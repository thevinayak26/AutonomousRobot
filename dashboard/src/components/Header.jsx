// -----------------------------------------------------------------------------
// Header.jsx - the top bar: brand, mission clock, mode/rate/link pills, theme
// toggle. Mode, rate and link all reflect REAL state (motion, measured odom Hz,
// rosbridge status); nothing here is decorative-only. The wordmark reveals the
// ATLAS acronym on hover (after a beat) or tap.
// -----------------------------------------------------------------------------
import { useState } from 'react';

const LINK = {
  connected: { cls: 'accent', label: 'Linked', blip: '' },
  connecting: { cls: 'gold', label: 'Linking', blip: 'gold' },
  reconnecting: { cls: 'gold', label: 'Reconnecting', blip: 'gold' },
  down: { cls: 'coral', label: 'Offline', blip: 'coral' },
};

export default function Header({ clock, mode, hz, latency, status, theme, onToggleTheme }) {
  const link = LINK[status] || LINK.down;
  const linkColor =
    link.cls === 'accent' ? 'var(--accent)' : link.cls === 'gold' ? 'var(--gold)' : 'var(--coral)';
  const [tip, setTip] = useState(false);
  return (
    <header>
      <div className="brand">
        <span
          className="brand-logo"
          onClick={() => setTip((v) => !v)}
          onMouseLeave={() => setTip(false)}
          role="button"
          tabIndex={0}
          aria-label="What ATLAS stands for"
        >
          <span className="logo">
            Atl<b>a</b>s
          </span>
          <span className={'atlas-tip' + (tip ? ' show' : '')}>
            <b>A</b>utonomous <b>T</b>racking, <b>L</b>ocalization &amp; <b>A</b>wareness{' '}
            <b>S</b>ystem
          </span>
        </span>
        <span className="tag">Autonomous&nbsp;Console</span>
      </div>
      <div className="divider" />
      <div className="clock">
        Mission&nbsp;T+&nbsp;<b>{clock}</b>
      </div>
      <div className="spacer" />
      <div className="pill mode-pill">
        <span className="k">Mode</span>
        <span className="v">{mode}</span>
      </div>
      <div className="pill">
        <span className="k">Rate</span>
        <span className="v num">{hz != null ? Math.round(hz) : '-'}</span>
      </div>
      <div className="pill">
        <span className={'blip' + (link.blip ? ' ' + link.blip : '')} />
        <span className="v" style={{ color: linkColor }}>
          {link.label}
        </span>
        {status === 'connected' && latency != null && (
          <span className="v num link-ms">{latency}&thinsp;ms</span>
        )}
      </div>
      <button
        type="button"
        className="toggle"
        onClick={onToggleTheme}
        title={`Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`}
        aria-label="Toggle dark/light theme"
        aria-pressed={theme === 'light'}
      >
        <span className="t-ic moon" aria-hidden="true">
          ☾
        </span>
        <span className="t-ic sun" aria-hidden="true">
          ☀
        </span>
        <span className="knob" />
      </button>
    </header>
  );
}
