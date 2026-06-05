import * as THREE from 'three'
import { PMREMGenerator, type WebGPURenderer } from 'three/webgpu'
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js'
import { RefractionRenderManager } from '../../managers/refractionRenderManager'
import { ReflectionRenderManager } from '../../managers/reflectionRenderManager'
import { loadFoamTexture } from '../../shaders/water-foam-gen'
import { loadCausticsTexture } from '../../shaders/caustics-gen'
import {
  TERRAIN_TILE_SEGMENTS,
  TERRAIN_TILE_SIZE,
  createTerrainGeometry,
} from './terrain-utils'

export interface SceneInitResult {
  terrainGeometry: THREE.BufferGeometry
  waterNormalMap: THREE.Texture | null
  waterFoamMapPromise: Promise<THREE.Texture | null>
  waterCausticsMapPromise: Promise<THREE.Texture | null>
  refractionManager: RefractionRenderManager | null
  refractionTexture: THREE.Texture | null
  reflectionManager: ReflectionRenderManager | null
  reflectionTexture: THREE.Texture | null
}

export function initScene(
  renderer: WebGPURenderer,
  scene: THREE.Scene,
  viewportWidth: number,
  viewportHeight: number,
  options: { skipWaterEffects?: boolean } = {}
): SceneInitResult {
  // Generate environment map. Skip on the tightest mobile budget to avoid a
  // large GPU allocation spike during world entry.
  if (!options.skipWaterEffects) {
    renderer.init().then(() => {
      const pmremGenerator = new PMREMGenerator(renderer)
      const rt = pmremGenerator.fromScene(new RoomEnvironment())
      scene.environment = rt.texture
      scene.environmentIntensity = 0.5
      pmremGenerator.dispose()
    })
  }

  // Create terrain geometry
  const terrainGeometry = createTerrainGeometry(
    TERRAIN_TILE_SIZE,
    TERRAIN_TILE_SEGMENTS
  )

  const loader = new THREE.TextureLoader()
  const waterNormalMap = options.skipWaterEffects
    ? null
    : loader.load('/textures/waternormals.jpg')
  if (waterNormalMap) {
    waterNormalMap.wrapS = waterNormalMap.wrapT = THREE.RepeatWrapping
  }

  const waterFoamMapPromise = options.skipWaterEffects
    ? Promise.resolve(null)
    : loadFoamTexture()
  const waterCausticsMapPromise = options.skipWaterEffects
    ? Promise.resolve(null)
    : loadCausticsTexture()

  // Initialize render managers
  const refractionManager = options.skipWaterEffects
    ? null
    : new RefractionRenderManager(
        renderer,
        scene,
        viewportWidth,
        viewportHeight
      )
  const reflectionManager = options.skipWaterEffects
    ? null
    : new ReflectionRenderManager(
        renderer,
        scene,
        viewportWidth,
        viewportHeight
      )

  return {
    terrainGeometry,
    waterNormalMap,
    waterFoamMapPromise,
    waterCausticsMapPromise,
    refractionManager,
    refractionTexture: refractionManager?.texture ?? null,
    reflectionManager,
    reflectionTexture: reflectionManager?.texture ?? null,
  }
}
