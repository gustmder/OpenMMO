/**
 * RFD1 (River Field Data, version 1) decoder. Format documented in
 * `shared/src/worldgen/tile_bake/river_field.rs`.
 */

const MAGIC = 0x31444652 // "RFD1" little-endian
const HEADER_BYTES = 16
const BYTES_PER_PIXEL = 4
const SUPPORTED_VERSION = 1

/** Heightmap encoding constants — must match
 *  `shared/src/worldgen/tile_bake/constants.rs` (HEIGHT_BIAS / HEIGHT_STEP). */
const HEIGHT_BIAS_M = 500
const HEIGHT_STEP_M = 0.05

/** Vertex-grid side length of one tile (matches heightmap resolution). */
export const RIVER_FIELD_GRID = 65

export interface RiverFieldTileData {
  /** Row-major 65×65 surface elevation in meters. Outside the river's
   *  influence radius this matches the natural ground so the runtime
   *  shader's `depth = surfaceY − bedY` reads 0 there. */
  surfaceY: Float32Array
  /** Row-major 65×65 unit downstream flow vector X component (-1..1). */
  flowX: Float32Array
  /** Row-major 65×65 unit downstream flow vector Z component (-1..1). */
  flowZ: Float32Array
}

/** Decode an `RFD1` per-tile file. Throws on corrupt data so the caller
 *  doesn't render garbage from a bad payload. */
export function decodeRiverFieldData(buffer: ArrayBuffer): RiverFieldTileData {
  if (buffer.byteLength < HEADER_BYTES) {
    throw new Error(`river field too small: ${buffer.byteLength} bytes`)
  }
  const view = new DataView(buffer)
  const magic = view.getUint32(0, true)
  if (magic !== MAGIC) {
    throw new Error(
      `river field magic mismatch: got 0x${magic.toString(16)}, expected 0x${MAGIC.toString(16)}`
    )
  }
  const version = view.getUint16(4, true)
  if (version !== SUPPORTED_VERSION) {
    throw new Error(
      `river field version ${version} unsupported (expected ${SUPPORTED_VERSION})`
    )
  }
  const gridX = view.getUint16(6, true)
  const gridZ = view.getUint16(8, true)
  if (gridX !== RIVER_FIELD_GRID || gridZ !== RIVER_FIELD_GRID) {
    throw new Error(
      `river field grid ${gridX}×${gridZ} != expected ${RIVER_FIELD_GRID}×${RIVER_FIELD_GRID}`
    )
  }
  const expected = HEADER_BYTES + gridX * gridZ * BYTES_PER_PIXEL
  if (buffer.byteLength !== expected) {
    throw new Error(
      `river field size ${buffer.byteLength} does not match header (expected ${expected})`
    )
  }

  const count = gridX * gridZ
  const surfaceY = new Float32Array(count)
  const flowX = new Float32Array(count)
  const flowZ = new Float32Array(count)
  let off = HEADER_BYTES
  for (let i = 0; i < count; i++) {
    const enc = view.getUint16(off, true)
    surfaceY[i] = enc * HEIGHT_STEP_M - HEIGHT_BIAS_M
    flowX[i] = view.getInt8(off + 2) / 127
    flowZ[i] = view.getInt8(off + 3) / 127
    off += BYTES_PER_PIXEL
  }
  return { surfaceY, flowX, flowZ }
}
