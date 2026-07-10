// -----------------------------------------------------------------------------
// GlowCard.jsx - the dashboard card shell. Wraps BorderGlow with the ATLAS glass
// look (translucent panel + backdrop blur, applied in theme.css via
// .border-glow-card.glow-card) and a restrained, theme-aware palette so the
// cursor-following border glow reads as "ours", not the stock neon.
//   • outer element carries the grid-area id (#c-map …) + glass styling
//   • children render inside .border-glow-inner (clipped, flex column)
// -----------------------------------------------------------------------------
import BorderGlow from './BorderGlow';

// Only the edge glow is used (the interior mesh is disabled in theme.css), so
// glowColor is what matters. Both modes use a PINK rim matching each theme's
// --accent (dark #ff8ec9 ≈ "329 100 76", light #e85b97 ≈ "335 75 63"), so the
// cursor-following border glow reads as the ATLAS pink, not the old amber/teal.
// Expressed as "H S L".
const PALETTE = {
  dark: { glow: '329 100 76' },
  light: { glow: '335 75 63' },
};

export default function GlowCard({ id, theme = 'dark', className = '', children }) {
  const p = PALETTE[theme] || PALETTE.dark;
  return (
    <BorderGlow
      id={id}
      className={`glow-card ${className}`}
      backgroundColor="var(--panel)"
      borderRadius={16}
      glowColor={p.glow}
      glowIntensity={0.95}
      glowRadius={30}
      coneSpread={32}
      edgeSensitivity={26}
      fillOpacity={0}
    >
      {children}
    </BorderGlow>
  );
}
