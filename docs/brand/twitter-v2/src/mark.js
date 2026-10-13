// Mark A (crescent / bowl), same geometry as docs/brand/logo/src/build.py. Returns an SVG string.
// opts: { size, disc, edge, glow 0..1, id, t }  t = rim thickness at the bottom in 64-unit space
//   t=5.1 is the logo weight; t~1.5 is the "display" weight for large heroes (a hairline corona).
function crescent({ size = 64, disc = null, edge = null, glow = 0, id = "c", t = 5.1, rim = "#f4b728" } = {}) {
  const r = 22.4, cy = 57.5 - r - t;
  const g = glow ? `<defs><radialGradient id="g${id}" cx="32" cy="${cy + 4}" r="36" gradientUnits="userSpaceOnUse">
      <stop offset=".58" stop-color="#f4b728" stop-opacity="${0.24 * glow}"/><stop offset=".75" stop-color="#f4b728" stop-opacity="${0.06 * glow}"/><stop offset="1" stop-color="#f4b728" stop-opacity="0"/></radialGradient></defs>
      <circle cx="32" cy="${cy + 4}" r="36" fill="url(#g${id})"/>` : "";
  return `<svg viewBox="0 0 64 64" width="${size}" height="${size}" style="overflow:visible;display:block">${g}
    <defs><mask id="m${id}" maskUnits="userSpaceOnUse" x="-10" y="-10" width="84" height="84"><rect x="-10" y="-10" width="84" height="84" fill="#fff"/><circle cx="32" cy="${cy}" r="${r}" fill="#000"/></mask></defs>
    <circle cx="32" cy="34.5" r="23" fill="${rim}" mask="url(#m${id})"/>
    ${disc ? `<circle cx="32" cy="${cy}" r="${r}" fill="${disc}"/>` : ""}
    ${edge ? `<circle cx="32" cy="${cy}" r="${r - 0.3}" fill="none" stroke="${edge}" stroke-width="${64 / size}"/>` : ""}</svg>`;
}
