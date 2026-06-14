<script lang="ts">
  /**
   * GameSceneDungeonLayer — renders the dungeon floor the local player is
   * on. Geometry comes from the shared wasm layout (see dungeonManager);
   * only the current depth is built, rebuilt on depth/dungeon change.
   * Stair shafts are part of both adjacent floors' groups with identical
   * world-space geometry, so the midpoint floor switch is seamless.
   */
  import { T } from '@threlte/core'
  import * as THREE from 'three'
  import { onDestroy } from 'svelte'
  import {
    currentDungeonDepth,
    currentDungeonId,
  } from '../../stores/dungeonStore'
  import { dungeonManager } from '../../managers/dungeonManager'
  import { networkManager } from '../../network/socket'
  import {
    buildDungeonEntranceGroup,
    buildDungeonFloorGroup,
    disposeDungeonGroup,
  } from '../../utils/dungeon-geometry'
  import { passabilityDebugVisible } from '../../stores/debugStore'
  import { pushPassabilityEdges } from '../../utils/passability-wireframe'

  /** Walk-up-to-open range for the treasure chest (matches the server). */
  const CHEST_OPEN_RANGE = 1.8
  let chestRequested = false

  const root = new THREE.Group()
  let currentGroup: THREE.Group | null = null
  let entranceGroup: THREE.Group | null = null
  let builtKey = ''
  let entranceKey = ''

  function clearGroup() {
    if (currentGroup) {
      root.remove(currentGroup)
      disposeDungeonGroup(currentGroup)
      currentGroup = null
    }
  }

  function clearEntranceGroup() {
    if (entranceGroup) {
      root.remove(entranceGroup)
      disposeDungeonGroup(entranceGroup)
      entranceGroup = null
    }
  }

  // ── Passability debug overlay (red wireframe on blocked cell edges) ──
  // Shares the `__togglePassability` toggle with the housing overlay so one
  // command shows blocked edges everywhere. Draws the floor whose shaft the
  // player is on (the entry shaft lives in floor 1, hence Math.max(1, depth)).
  const debugPassGroup = new THREE.Group()
  debugPassGroup.name = 'dungeonPassabilityDebug'
  debugPassGroup.visible = false
  root.add(debugPassGroup)
  const debugLineMaterial = new THREE.LineBasicMaterial({ color: 0xff0000 })

  function clearDebugPass() {
    while (debugPassGroup.children.length > 0) {
      const child = debugPassGroup.children[0]
      debugPassGroup.remove(child)
      if (child instanceof THREE.LineSegments) child.geometry.dispose()
    }
  }

  function rebuildDebugPass() {
    clearDebugPass()
    if (!debugPassGroup.visible || !dungeonManager.active) return
    const floorLevel = dungeonManager.passabilityFloor(
      Math.max(1, $currentDungeonDepth)
    )
    const f = dungeonManager.floorPassabilityCells(floorLevel)
    if (!f) return

    const verts: number[] = []
    pushPassabilityEdges(
      verts,
      f.cells,
      f.width,
      f.depth,
      f.originX,
      f.originZ,
      f.yBase
    )
    if (verts.length > 0) {
      const geo = new THREE.BufferGeometry()
      geo.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3))
      const lines = new THREE.LineSegments(geo, debugLineMaterial)
      lines.frustumCulled = false
      debugPassGroup.add(lines)
    }
  }

  // Toggle + re-draw on dungeon/depth change. rebuildDebugPass early-outs
  // when hidden, so this is free while the overlay is off.
  $effect(() => {
    debugPassGroup.visible = $passabilityDebugVisible
    void $currentDungeonId
    void $currentDungeonDepth
    rebuildDebugPass()
  })

  // Surface entrance structure (descending stairs + pit walls). The geometry
  // depends only on the dungeon id, so it's built once per dungeon and only
  // its visibility tracks depth: shown at depth 0, hidden underground where
  // the floor group owns the shaft (rendering both would z-fight).
  $effect(() => {
    const id = $currentDungeonId
    const depth = $currentDungeonDepth
    if ((id ?? '') !== entranceKey) {
      entranceKey = id ?? ''
      clearEntranceGroup()
      if (id) {
        const first = dungeonManager.layoutAt(1)
        if (first) {
          const c = dungeonManager.consts
          entranceGroup = buildDungeonEntranceGroup(first.upShaft, {
            grid: c.grid,
            wallHeight: c.wallHeight,
            floorHeight: c.floorHeight,
            shaftW: c.shaftW,
            shaftLen: c.shaftLen,
          })
          entranceGroup.position.set(
            dungeonManager.originX,
            dungeonManager.entrancePos!.y,
            dungeonManager.originZ
          )
          root.add(entranceGroup)
        }
      }
    }
    if (entranceGroup) entranceGroup.visible = depth === 0
  })

  $effect(() => {
    const id = $currentDungeonId
    const depth = $currentDungeonDepth
    const key = id && depth >= 1 ? `${id}:${depth}` : ''
    if (key === builtKey) return
    builtKey = key
    clearGroup()
    if (!key) return

    const layout = dungeonManager.layoutAt(depth)
    if (!layout) return
    const c = dungeonManager.consts
    currentGroup = buildDungeonFloorGroup(layout, {
      grid: c.grid,
      wallHeight: c.wallHeight,
      floorHeight: c.floorHeight,
      shaftW: c.shaftW,
      shaftLen: c.shaftLen,
    })
    currentGroup.position.set(
      dungeonManager.originX,
      dungeonManager.floorY(depth),
      dungeonManager.originZ
    )
    root.add(currentGroup)
  })

  onDestroy(() => {
    clearGroup()
    clearEntranceGroup()
    clearDebugPass()
    debugLineMaterial.dispose()
  })

  /** Per-frame: stair-shaft floor transitions + chest proximity. */
  export function update(playerX: number, playerZ: number) {
    dungeonManager.updateFromPlayerPosition(playerX, playerZ)

    // Final-floor treasure chest: walking up to it requests an open once
    // per approach (the server validates boss state and the cooldown).
    if (!dungeonManager.active) return
    const depth = $currentDungeonDepth
    const layout = depth >= 1 ? dungeonManager.layoutAt(depth) : null
    const chest = layout?.chest ?? null
    if (!chest) {
      chestRequested = false
      return
    }
    const cx = dungeonManager.originX + chest[0] + 0.5
    const cz = dungeonManager.originZ + chest[1] + 0.5
    const dx = playerX - cx
    const dz = playerZ - cz
    const near = dx * dx + dz * dz < CHEST_OPEN_RANGE * CHEST_OPEN_RANGE
    if (near && !chestRequested) {
      chestRequested = true
      networkManager.sendOpenDungeonChest(dungeonManager.dungeonId!)
    } else if (!near) {
      chestRequested = false
    }
  }

  export function getGroup(): THREE.Group {
    return root
  }

  /** Raycast targets for click-to-move while underground. */
  export function getGroundMeshes(): THREE.Object3D[] {
    return currentGroup ? [currentGroup] : []
  }
</script>

<T is={root} />
