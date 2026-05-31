<script lang="ts">
  import { T } from '@threlte/core'
  import { onDestroy } from 'svelte'
  import * as THREE from 'three'
  import { getItemDef } from '../data/itemDefs'
  import { getWeaponModelPath } from '../utils/modelPaths'
  import { loadGLB } from '../utils/gltfCache'
  import { localPlayerRightHand } from '../stores/playerHandRegistry'
  import { createGroundItemGlowMaterial } from '../shaders/ground-item-glow-material'
  import type { TerrainHeightManager } from '../managers/terrainHeightManager'
  import {
    evaluateSpawnAnimation,
    type GroundItemData,
  } from '../managers/groundItemManager'

  interface Props {
    data: GroundItemData
    rotation?: number
    animationTimeMs?: number
    heightManager?: TerrainHeightManager
  }

  let {
    data,
    rotation = 0,
    animationTimeMs = 0,
    heightManager,
  }: Props = $props()

  const def = $derived(getItemDef(data.itemDefId))
  const label = $derived(def?.name ?? data.itemDefId)
  const UP = new THREE.Vector3(0, 1, 0)
  const TERRAIN_NORMAL_SAMPLE_DISTANCE = 0.75
  const MAX_TERRAIN_Y_DELTA_FOR_TILT = 0.75

  const { material: outlineGlowMaterial, uniforms: outlineGlowUniforms } =
    createGroundItemGlowMaterial()

  let worldModelScene: THREE.Object3D | undefined = $state()
  let outlineGlowScene: THREE.Object3D | undefined = $state()
  let groundParentRef: THREE.Group | undefined = $state()
  let terrainAlignedRef: THREE.Group | undefined = $state()

  function cloneScene(
    scene: THREE.Object3D,
    onMesh: (mesh: THREE.Mesh) => void
  ): THREE.Object3D {
    const clone = scene.clone(true)
    clone.traverse((child) => {
      if (child instanceof THREE.Mesh) onMesh(child)
    })
    return clone
  }

  function cloneGroundItemScene(scene: THREE.Object3D): THREE.Object3D {
    return cloneScene(scene, (mesh) => {
      mesh.castShadow = true
      mesh.receiveShadow = true
    })
  }

  function cloneOutlineGlowScene(scene: THREE.Object3D): THREE.Object3D {
    return cloneScene(scene, (mesh) => {
      mesh.material = outlineGlowMaterial
      mesh.castShadow = false
      mesh.receiveShadow = false
      mesh.renderOrder = 1
    })
  }

  function getTerrainAlignmentQuaternion(
    worldX: number,
    worldY: number,
    worldZ: number,
    shouldTilt: boolean
  ): THREE.Quaternion {
    if (!shouldTilt || !heightManager?.hasHeightData(worldX, worldZ)) {
      return new THREE.Quaternion()
    }

    const d = TERRAIN_NORMAL_SAMPLE_DISTANCE
    if (
      !heightManager.hasHeightData(worldX - d, worldZ) ||
      !heightManager.hasHeightData(worldX + d, worldZ) ||
      !heightManager.hasHeightData(worldX, worldZ - d) ||
      !heightManager.hasHeightData(worldX, worldZ + d)
    ) {
      return new THREE.Quaternion()
    }

    const terrainY = heightManager.getHeightAtWorldPosition(worldX, worldZ)
    if (Math.abs(worldY - terrainY) > MAX_TERRAIN_Y_DELTA_FOR_TILT) {
      return new THREE.Quaternion()
    }

    const hL = heightManager.getHeightAtWorldPosition(worldX - d, worldZ)
    const hR = heightManager.getHeightAtWorldPosition(worldX + d, worldZ)
    const hB = heightManager.getHeightAtWorldPosition(worldX, worldZ - d)
    const hF = heightManager.getHeightAtWorldPosition(worldX, worldZ + d)
    const normal = new THREE.Vector3(hL - hR, 2 * d, hB - hF).normalize()
    return new THREE.Quaternion().setFromUnitVectors(UP, normal)
  }

  $effect(() => {
    const worldModel = def?.worldModel
    if (!worldModel) {
      worldModelScene = undefined
      outlineGlowScene = undefined
      return
    }
    let cancelled = false
    let loadedScene: THREE.Object3D | undefined
    let loadedGlowScene: THREE.Object3D | undefined
    const path = getWeaponModelPath(worldModel)
    loadGLB(path).then((gltf) => {
      if (cancelled) return
      const scene = cloneGroundItemScene(gltf.scene)
      const glowScene = cloneOutlineGlowScene(gltf.scene)
      loadedScene = scene
      loadedGlowScene = glowScene
      worldModelScene = scene
      outlineGlowScene = glowScene
    })
    return () => {
      cancelled = true
      if (loadedScene?.parent) loadedScene.parent.remove(loadedScene)
      if (loadedGlowScene?.parent) loadedGlowScene.parent.remove(loadedGlowScene)
    }
  })

  $effect(() => {
    const scene = worldModelScene
    const ground = groundParentRef
    if (!scene || !ground) return
    const hand = data.inHand ? $localPlayerRightHand : null
    const targetParent = hand ?? ground
    if (scene.parent === targetParent) return
    scene.position.set(0, hand ? 0.08 : 0, 0)
    scene.rotation.set(0, 0, 0)
    targetParent.add(scene)
  })

  $effect(() => {
    const scene = outlineGlowScene
    const ground = groundParentRef
    if (!scene || !ground) return
    if (!showGlow) {
      if (scene.parent) scene.parent.remove(scene)
      return
    }
    if (scene.parent !== ground) ground.add(scene)
    scene.position.set(0, 0, 0)
    scene.rotation.set(0, 0, 0)
  })

  function makeNameTexture(text: string): THREE.CanvasTexture {
    const c = document.createElement('canvas')
    c.width = 256
    c.height = 64
    const ctx = c.getContext('2d')!
    ctx.fillStyle = 'rgba(0,0,0,0.6)'
    ctx.fillRect(0, 0, 256, 64)
    ctx.font = 'bold 28px Courier New'
    ctx.fillStyle = '#f0c040'
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText(text, 128, 32)
    return new THREE.CanvasTexture(c)
  }

  const nameTexture = $derived(
    def?.worldModel || worldModelScene ? null : makeNameTexture(label)
  )

  onDestroy(() => {
    nameTexture?.dispose()
    outlineGlowMaterial.dispose()
  })

  const spawnTransform = $derived(
    data.spawnAnimation && !data.inHand
      ? evaluateSpawnAnimation(data.spawnAnimation, animationTimeMs)
      : null
  )
  const displayX = $derived(data.position.x + (spawnTransform?.offsetX ?? 0))
  const displayY = $derived(
    data.position.y + 0.3 + (spawnTransform?.offsetY ?? 0)
  )
  const displayZ = $derived(data.position.z + (spawnTransform?.offsetZ ?? 0))
  const shouldTiltToTerrain = $derived(!data.inHand && !spawnTransform)
  // Depends only on the (post-animation, constant) display position and tilt
  // flag — so a resting item computes its terrain alignment once and stops,
  // rather than re-running terrain height lookups every frame.
  const terrainAlignmentQuaternion = $derived(
    getTerrainAlignmentQuaternion(
      displayX,
      data.position.y,
      displayZ,
      shouldTiltToTerrain
    )
  )
  const glowPulse = $derived(
    0.5 + Math.sin(animationTimeMs * 0.004 + data.instanceId) * 0.5
  )
  const outlineGlowOpacity = $derived(0.22 + glowPulse * 0.12)
  const outlineGlowScale = $derived(1.03 + glowPulse * 0.008)
  const outlineGlowShellOffset = $derived(0.044 + glowPulse * 0.012)
  const showGlow = $derived(!data.inHand)

  $effect(() => {
    terrainAlignedRef?.quaternion.copy(terrainAlignmentQuaternion)
  })

  $effect(() => {
    if (!showGlow) return
    outlineGlowUniforms.uTime.value = animationTimeMs / 1000
    outlineGlowUniforms.uOpacity.value = outlineGlowOpacity
    outlineGlowUniforms.uShellOffset.value = outlineGlowShellOffset
    outlineGlowScene?.scale.setScalar(outlineGlowScale)
  })
</script>

<T.Group
  position.x={displayX}
  position.y={displayY}
  position.z={displayZ}
  userData={{ groundItemId: data.instanceId }}
>
  <T.Group bind:ref={terrainAlignedRef}>
    <T.Group
      rotation.y={data.restingRotationY + (worldModelScene || data.spawnAnimation ? 0 : rotation)}
      rotation.z={spawnTransform?.spinZ ?? 0}
    >
      <T.Group bind:ref={groundParentRef} />

      {#if !worldModelScene}
        {#if showGlow}
          <T.Mesh scale={[outlineGlowScale, outlineGlowScale, outlineGlowScale]} renderOrder={1}>
            <T.BoxGeometry args={[0.3, 0.3, 0.3]} />
            <T is={outlineGlowMaterial} />
          </T.Mesh>
        {/if}

        <T.Mesh>
          <T.BoxGeometry args={[0.3, 0.3, 0.3]} />
          <T.MeshStandardMaterial color="#f0c040" />
        </T.Mesh>

        {#if nameTexture}
          <T.Sprite position.y={0.5} scale={[label.length * 0.08, 0.2, 1]}>
            <T.SpriteMaterial map={nameTexture} transparent={true} />
          </T.Sprite>
        {/if}
      {/if}
    </T.Group>
  </T.Group>
</T.Group>
