// -----------------------------------------------------------------------------
// Skeleton.jsx - a shimmering placeholder block shown while a tile's data hasn't
// arrived yet (connecting, or connected-but-awaiting-first-message). Distinct
// from the honest "offline" states (camera/ultrasonics), which never shimmer
// because their data is never coming.
// -----------------------------------------------------------------------------
export default function Skeleton({ width = '100%', height = 14, radius = 6, style }) {
  const w = typeof width === 'number' ? `${width}px` : width;
  const h = typeof height === 'number' ? `${height}px` : height;
  return <span className="skel" style={{ width: w, height: h, borderRadius: radius, ...style }} />;
}
