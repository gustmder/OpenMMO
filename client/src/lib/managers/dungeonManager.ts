/**
 * dungeonManager.ts — client-side dungeon state singleton.
 *
 * Layouts come from the shared wasm generator (same code the server runs
 * natively), so entering a dungeon never downloads geometry: the manager
 * generates layouts from the entrance id, registers the passability entry
 * in the shared wasm cache (movement collision, click-to-move A* and
 * monster pathing then work unchanged), and answers height queries —
 * including the stair-shaft ramps that let the player physically walk
 * between floors. Module-level singleton like bridgeManager so
 * player-physics can consult it without prop drilling.
 */
import { get } from 'svelte/store'
import {
  dungeon_layout,
  dungeon_constants,
  dungeon_add_passability,
  dungeon_remove_passability,
  dungeon_passability_floor_cells,
} from '../wasm/onlinerpg_shared'
import { currentDungeonDepth, currentDungeonId } from '../stores/dungeonStore'
import { DUNGEON_ENTRANCES } from '../data/dungeonDefs'

export interface DungeonRoom {
  x: number
  z: number
  w: number
  d: number
}

export interface DungeonShaft {
  x: number
  z: number
  alongZ: boolean
  reversed: boolean
}

export interface DungeonSpawn {
  x: number
  z: number
  monsterType: string
  isBoss: boolean
}

export interface DungeonFloorLayout {
  depth: number
  rooms: DungeonRoom[]
  carved: boolean[]
  upShaft: DungeonShaft
  /** serde Option — arrives as undefined (not null) over wasm. */
  downShaft?: DungeonShaft | null
  chest?: [number, number] | null
  spawns: DungeonSpawn[]
}

export interface DungeonConstants {
  grid: number
  floorHeight: number
  wallHeight: number
  floorIndexBase: number
  shaftW: number
  shaftLen: number
  maxDepth: number
  pathMaxNodes: number
}

export interface DungeonEntrance {
  x: number
  y: number
  z: number
}

/** Flat landing length (in cells) at each end of a stair shaft ramp. */
const LANDING_CELLS = 1.0
/** Hysteresis (in run cells) around the shaft midpoint for floor switches. */
const SWITCH_HYSTERESIS = 0.3
/** Register a registry dungeon when the player gets this close (m). */
const ENTRANCE_REGISTER_DIST = 80
/** Drop a surface-level dungeon registration beyond this distance (m). */
const ENTRANCE_UNREGISTER_DIST = 120

let consts: DungeonConstants | null = null

function constants(): DungeonConstants {
  if (!consts) consts = dungeon_constants() as DungeonConstants
  return consts
}

export interface DungeonRect {
  minX: number
  minZ: number
  maxX: number
  maxZ: number
}

/** One floor's passability edge bits + world placement (debug overlay). */
export interface DungeonFloorCells {
  /** World min-corner X (= originX). */
  originX: number
  originZ: number
  width: number
  depth: number
  /** World Y of the floor. */
  yBase: number
  /** Per-cell edge bitmask (N=1, E=2, S=4, W=8), indexed [gx + gz*width]. */
  cells: number[]
}

/**
 * World-space XZ rect of a shaft's surface opening — the footprint minus
 * the one-cell entry landing row at the shallow end (so terrain/grass still
 * meet the lip where the player steps in).
 */
function shaftHoleRect(
  shaft: DungeonShaft,
  originX: number,
  originZ: number,
  shaftW: number,
  shaftLen: number
): DungeonRect {
  let minX: number, maxX: number, minZ: number, maxZ: number
  if (shaft.alongZ) {
    minX = shaft.x
    maxX = shaft.x + shaftW
    minZ = shaft.z
    maxZ = shaft.z + shaftLen
    if (shaft.reversed) maxZ -= LANDING_CELLS
    else minZ += LANDING_CELLS
  } else {
    minX = shaft.x
    maxX = shaft.x + shaftLen
    minZ = shaft.z
    maxZ = shaft.z + shaftW
    if (shaft.reversed) maxX -= LANDING_CELLS
    else minX += LANDING_CELLS
  }
  return {
    minX: originX + minX,
    minZ: originZ + minZ,
    maxX: originX + maxX,
    maxZ: originZ + maxZ,
  }
}

class DungeonManager {
  private id: string | null = null
  private entrance: DungeonEntrance | null = null
  private layouts: DungeonFloorLayout[] = []
  /** Cached surface-opening rects per entrance id (see allEntranceHoleRects). */
  private entranceRectCache = new Map<string, DungeonRect>()

  get active(): boolean {
    return this.id !== null
  }

  get dungeonId(): string | null {
    return this.id
  }

  get entrancePos(): DungeonEntrance | null {
    return this.entrance
  }

  get floors(): DungeonFloorLayout[] {
    return this.layouts
  }

  get consts(): DungeonConstants {
    return constants()
  }

  /** World min-corner of the cell grid (matches shared dungeon_origin). */
  get originX(): number {
    return Math.floor(this.entrance!.x) - constants().grid / 2
  }

  get originZ(): number {
    return Math.floor(this.entrance!.z) - constants().grid / 2
  }

  floorY(depth: number): number {
    return this.entrance!.y - depth * constants().floorHeight
  }

  /** Passability floor index for path queries at a given depth. */
  passabilityFloor(depth: number): number {
    return constants().floorIndexBase + depth - 1
  }

  /**
   * Debug: per-cell passability edge bits for the registered dungeon's floor
   * at the given passability floor level (see passabilityFloor). Null when no
   * dungeon is registered or the level isn't present.
   */
  floorPassabilityCells(floorLevel: number): DungeonFloorCells | null {
    if (!this.id) return null
    return dungeon_passability_floor_cells(
      this.id,
      floorLevel
    ) as DungeonFloorCells | null
  }

  layoutAt(depth: number): DungeonFloorLayout | null {
    return this.layouts[depth - 1] ?? null
  }

  /**
   * Generate layouts and register passability for a dungeon. Idempotent
   * per entrance id.
   */
  enter(id: string, entrance: DungeonEntrance) {
    if (this.id === id) return
    if (this.id) this.exit()
    this.layouts = dungeon_layout(id) as DungeonFloorLayout[]
    dungeon_add_passability(id, entrance.x, entrance.y, entrance.z)
    this.id = id
    this.entrance = entrance
    currentDungeonId.set(id)
  }

  /** Drop dungeon state (passability included). Depth resets to surface. */
  exit() {
    if (this.id) dungeon_remove_passability(this.id)
    this.id = null
    this.entrance = null
    this.layouts = []
    currentDungeonId.set(null)
    currentDungeonDepth.set(0)
  }

  setDepth(depth: number) {
    currentDungeonDepth.set(depth)
  }

  /** Grid cell of a shaft's entry landing (shallower floor). */
  shaftEntryCell(shaft: DungeonShaft): { x: number; z: number } {
    const run = shaft.reversed ? constants().shaftLen - 1 : 0
    return shaft.alongZ
      ? { x: shaft.x, z: shaft.z + run }
      : { x: shaft.x + run, z: shaft.z }
  }

  /** Grid cell of a shaft's exit landing (deeper floor). */
  shaftExitCell(shaft: DungeonShaft): { x: number; z: number } {
    const run = shaft.reversed ? 0 : constants().shaftLen - 1
    return shaft.alongZ
      ? { x: shaft.x, z: shaft.z + run }
      : { x: shaft.x + run, z: shaft.z }
  }

  /** World-space center of a grid cell at a given depth's floor Y. */
  cellCenter(depth: number, cell: { x: number; z: number }) {
    return {
      x: this.originX + cell.x + 0.5,
      y: this.floorY(depth),
      z: this.originZ + cell.z + 0.5,
    }
  }

  /**
   * World-space XZ rect of the currently-registered dungeon's surface
   * opening. Used by the terrain shader to discard fragments there, opening
   * up the descending stairs. Null when no dungeon is registered.
   */
  entranceHoleRect(): DungeonRect | null {
    const first = this.layoutAt(1)
    if (!first || !this.entrance) return null
    const { shaftW, shaftLen } = constants()
    return shaftHoleRect(
      first.upShaft,
      this.originX,
      this.originZ,
      shaftW,
      shaftLen
    )
  }

  /**
   * Surface-opening rects for *all* registry dungeons, independent of
   * proximity registration. Layouts are generated once (deterministic from
   * the entrance id) and the resulting rects cached. Used to suppress grass
   * over entrances so the opening is always visible, even before the dungeon
   * registers.
   */
  allEntranceHoleRects(): DungeonRect[] {
    const out: DungeonRect[] = []
    for (const e of DUNGEON_ENTRANCES) {
      let rect = this.entranceRectCache.get(e.id)
      if (!rect) {
        // Defensive: if wasm isn't ready yet, skip this entrance without
        // caching so a later call retries (rather than throwing and aborting
        // the grass tile load).
        try {
          const { grid, shaftW, shaftLen } = constants()
          const layouts = dungeon_layout(e.id) as DungeonFloorLayout[]
          const first = layouts[0]
          if (!first) continue
          const ox = Math.floor(e.x) - grid / 2
          const oz = Math.floor(e.z) - grid / 2
          rect = shaftHoleRect(first.upShaft, ox, oz, shaftW, shaftLen)
          this.entranceRectCache.set(e.id, rect)
        } catch {
          continue
        }
      }
      out.push(rect)
    }
    return out
  }

  /**
   * Shaft run position in [0, shaftLen) measured from the entry (shallow)
   * end, or null when (x, z) is outside the shaft footprint.
   */
  private shaftRunPos(
    shaft: DungeonShaft,
    x: number,
    z: number
  ): number | null {
    const { shaftW, shaftLen } = constants()
    const lx = x - this.originX - shaft.x
    const lz = z - this.originZ - shaft.z
    const lateral = shaft.alongZ ? lx : lz
    const run = shaft.alongZ ? lz : lx
    if (lateral < 0 || lateral >= shaftW || run < 0 || run >= shaftLen) {
      return null
    }
    return shaft.reversed ? shaftLen - run : run
  }

  /** Linear stair ramp with flat landings at both ends. */
  private rampY(highY: number, lowY: number, t: number): number {
    const len = constants().shaftLen
    if (t <= LANDING_CELLS) return highY
    if (t >= len - LANDING_CELLS) return lowY
    const f = (t - LANDING_CELLS) / (len - LANDING_CELLS * 2)
    return highY + (lowY - highY) * f
  }

  /** Y at the top of a shaft (surface entrance uses the entrance Y). */
  private shaftHighY(depth: number): number {
    return depth <= 1 ? this.entrance!.y : this.floorY(depth - 1)
  }

  /**
   * Ground height on a specific dungeon floor (stair-shaft ramps
   * included), independent of the local player's depth — used for
   * monsters and other entities on arbitrary floors. Null when inactive.
   */
  floorHeightAt(depth: number, x: number, z: number): number | null {
    if (!this.active) return null
    const layout = this.layoutAt(depth)
    if (!layout) return null

    const tUp = this.shaftRunPos(layout.upShaft, x, z)
    if (tUp !== null) {
      return this.rampY(this.shaftHighY(depth), this.floorY(depth), tUp)
    }
    if (layout.downShaft) {
      const tDown = this.shaftRunPos(layout.downShaft, x, z)
      if (tDown !== null) {
        return this.rampY(this.floorY(depth), this.floorY(depth + 1), tDown)
      }
    }
    return this.floorY(depth)
  }

  /**
   * Ground height for the local player while the dungeon is active, or
   * null when terrain should be used instead (surface, outside shafts).
   */
  sampleHeightAt(x: number, z: number): number | null {
    if (!this.active) return null
    const depth = get(currentDungeonDepth)

    if (depth === 0) {
      // On the surface: only the entrance shaft ramp overrides terrain.
      const first = this.layouts[0]
      if (!first) return null
      const t = this.shaftRunPos(first.upShaft, x, z)
      if (t === null) return null
      return this.rampY(this.entrance!.y, this.floorY(1), t)
    }

    return this.floorHeightAt(depth, x, z)
  }

  /**
   * Register/unregister registry dungeons by proximity so the entrance
   * structure and passability exist before the player reaches the stairs.
   */
  private updateAutoRegister(x: number, z: number) {
    if (!this.active) {
      for (const e of DUNGEON_ENTRANCES) {
        const dx = x - e.x
        const dz = z - e.z
        if (
          dx * dx + dz * dz <
          ENTRANCE_REGISTER_DIST * ENTRANCE_REGISTER_DIST
        ) {
          this.enter(e.id, { x: e.x, y: e.y, z: e.z })
          return
        }
      }
      return
    }
    if (get(currentDungeonDepth) === 0 && this.entrance) {
      const dx = x - this.entrance.x
      const dz = z - this.entrance.z
      if (
        dx * dx + dz * dz >
        ENTRANCE_UNREGISTER_DIST * ENTRANCE_UNREGISTER_DIST
      ) {
        this.exit()
      }
    }
  }

  /**
   * Adopt a server-driven floor change (teleport/respawn): activate the
   * covering registry dungeon when needed and set the depth.
   */
  syncFromFloorLevel(floorLevel: number, x: number, z: number) {
    if (floorLevel >= 0) {
      if (this.active) currentDungeonDepth.set(0)
      return
    }
    if (!this.active) {
      const grid = constants().grid
      const covering = DUNGEON_ENTRANCES.find((e) => {
        const ox = Math.floor(e.x) - grid / 2
        const oz = Math.floor(e.z) - grid / 2
        return x >= ox && x < ox + grid && z >= oz && z < oz + grid
      })
      if (!covering) return
      this.enter(covering.id, { x: covering.x, y: covering.y, z: covering.z })
    }
    currentDungeonDepth.set(-floorLevel)
  }

  /**
   * Per-frame: switch the current depth when the player walks past a
   * shaft midpoint. Returns the new depth, or null when unchanged.
   */
  updateFromPlayerPosition(x: number, z: number): number | null {
    this.updateAutoRegister(x, z)
    if (!this.active) return null
    const depth = get(currentDungeonDepth)
    const mid = constants().shaftLen / 2

    if (depth === 0) {
      const first = this.layouts[0]
      if (!first) return null
      const t = this.shaftRunPos(first.upShaft, x, z)
      if (t !== null && t > mid + SWITCH_HYSTERESIS) {
        currentDungeonDepth.set(1)
        return 1
      }
      return null
    }

    const layout = this.layoutAt(depth)
    if (!layout) return null

    const tUp = this.shaftRunPos(layout.upShaft, x, z)
    if (tUp !== null && tUp < mid - SWITCH_HYSTERESIS) {
      const next = depth - 1
      currentDungeonDepth.set(next)
      return next
    }
    if (layout.downShaft) {
      const tDown = this.shaftRunPos(layout.downShaft, x, z)
      if (tDown !== null && tDown > mid + SWITCH_HYSTERESIS) {
        const next = depth + 1
        currentDungeonDepth.set(next)
        return next
      }
    }
    return null
  }
}

export const dungeonManager = new DungeonManager()
