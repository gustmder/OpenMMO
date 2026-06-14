import { EDGE_N, EDGE_E, EDGE_S, EDGE_W } from '../managers/housing-passability'

/**
 * Append red-wireframe line vertices for a passability cell grid's blocked
 * edges to `verts` (flat [x,y,z, x,y,z, ...] pairs for a THREE.LineSegments).
 * Shared by the housing and dungeon passability debug overlays so the
 * edge-bit → geometry contract lives in one place.
 *
 * `cells` is a per-cell edge bitmask (N=1, E=2, S=4, W=8) indexed
 * `[gx + gz*width]`. `originX/originZ` are the grid's world min-corner;
 * `yBase` is the floor's world Y.
 */
export function pushPassabilityEdges(
  verts: number[],
  cells: ArrayLike<number>,
  width: number,
  depth: number,
  originX: number,
  originZ: number,
  yBase: number
): void {
  const y0 = yBase + 0.05 // slightly above the floor
  const y1 = y0 + 0.1 // line height
  const pushQuad = (x0: number, z0: number, x1: number, z1: number) => {
    verts.push(x0, y0, z0, x1, y0, z1) // bottom
    verts.push(x0, y1, z0, x1, y1, z1) // top
    verts.push(x0, y0, z0, x0, y1, z0) // left vertical
    verts.push(x1, y0, z1, x1, y1, z1) // right vertical
  }
  for (let gz = 0; gz < depth; gz++) {
    for (let gx = 0; gx < width; gx++) {
      const bits = cells[gx + gz * width]
      if (!bits) continue
      const cx = originX + gx
      const cz = originZ + gz
      if (bits & EDGE_N) pushQuad(cx, cz, cx + 1, cz)
      if (bits & EDGE_S) pushQuad(cx, cz + 1, cx + 1, cz + 1)
      if (bits & EDGE_W) pushQuad(cx, cz, cx, cz + 1)
      if (bits & EDGE_E) pushQuad(cx + 1, cz, cx + 1, cz + 1)
    }
  }
}
