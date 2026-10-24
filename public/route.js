// The walking route between two points. The server uses it to time a walk and
// the browser to animate it, so both agree on where everyone is.
import { TILE, findPath } from './map.js';

export const tileOf = (p) => ({ x: Math.floor(p.x / TILE), y: Math.floor((p.y - 4) / TILE) });

export function route(town, from, to) {
  return [from, ...(findPath(town, tileOf(from), tileOf(to)) ?? []), to];
}

export function routeLength(points) {
  let d = 0;
  for (let i = 1; i < points.length; i++) d += Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y);
  return d;
}

/** Where along the route someone is after walking `dist`, and which way they face. */
export function pointAlong(points, dist) {
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    const seg = Math.hypot(b.x - a.x, b.y - a.y);
    if (dist <= seg || i === points.length - 1) {
      const f = seg ? Math.min(1, dist / seg) : 1;
      return { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f, fx: seg ? (b.x - a.x) / seg : 0, fy: seg ? (b.y - a.y) / seg : 1 };
    }
    dist -= seg;
  }
  const last = points[points.length - 1];
  return { x: last.x, y: last.y, fx: 0, fy: 1 };
}
