import * as THREE from 'three'
import { MeshBasicNodeMaterial } from 'three/webgpu'
import {
  attribute,
  texture,
  uniform,
  uv,
  vec2,
  vec3,
  float,
  smoothstep,
  length,
} from 'three/tsl'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type N = any // TSL node — broad type for internal helper params

/**
 * Per-rock water effects, both fed by the layer with the emitters near
 * the player each frame and sharing the water foam's day/night dimming
 * (uDayDim, from the sun direction):
 * - RiverSpraySystem: droplet burst at the rock's upstream face, where
 *   the current slams into it.
 * - RiverWakeFoamSystem: large foam clumps shed at the downstream face
 *   that drift with the current — the whitewater trail behind the rock.
 *   (Replaced the shader-side masked turbulence foam: world-space
 *   particles cross tile seams for free and read as moving water rather
 *   than a scrolling texture lobe.)
 */

// ── Spray ───────────────────────────────────────────────────

const SPRAY_OPACITY_ATTR = 'aSprayOpacity'
const SPRAY_UV_ATTR = 'aSprayUV'
const MAX_SPRAY = 320
/** Fraction of the foam texture one particle shows — small enough that a
 *  patch reads as a single ragged foam clump, not a repeating pattern. */
const SPRAY_FOAM_PATCH = 0.16
/** Rocks farther than this from the player don't emit. */
export const SPRAY_EMIT_RADIUS_M = 45

export interface SprayEmitter {
  x: number
  y: number
  z: number
  /** Optional vertical offset for spray only; wake foam stays on y. */
  sprayYOffset?: number
  flowX: number
  flowZ: number
  /** Rock half-width (m) — sets the spawn line length. */
  radius: number
  /** Baked turbulence 0..1 — scales the spawn rate. */
  turb: number
  /** Baked flow speed 0.3..1 — scales the wake-foam drift velocity. */
  speed: number
  /** Water-surface drop per meter downstream (m/m) — wake foam rides the
   *  surface down a rapid instead of floating off it. */
  drop: number
  /** Per-emitter spawn accumulator (owned by the spray system). */
  acc: number
  /** Per-emitter spawn accumulator (owned by the wake-foam system). */
  wakeAcc: number
}

interface SprayParticle {
  alive: boolean
  age: number
  maxAge: number
  x: number
  y: number
  z: number
  vx: number
  vy: number
  vz: number
  baseScale: number
}

/**
 * One instanced pool serves every rock — the layer passes the emitters
 * near the player each frame. Same billboard/lifetime scheme as
 * TorchFireParticles, tuned for water: no buoyancy, hard gravity, short
 * lives, normal blending (spray is white water, not light). Each
 * particle shows a random patch of the same foam texture the river uses,
 * masked by a radial falloff — thrown foam clumps instead of smoke puffs.
 */
export class RiverSpraySystem {
  readonly mesh: THREE.InstancedMesh
  private readonly uDayDim = uniform(1)
  private readonly uvAttr: THREE.InstancedBufferAttribute
  private pool: SprayParticle[] = Array.from({ length: MAX_SPRAY }, () => ({
    alive: false,
    age: 0,
    maxAge: 0,
    x: 0,
    y: 0,
    z: 0,
    vx: 0,
    vy: 0,
    vz: 0,
    baseScale: 0,
  }))
  private readonly opacityAttr: THREE.InstancedBufferAttribute
  private readonly tmpMatrix = new THREE.Matrix4()
  private readonly tmpPos = new THREE.Vector3()
  private readonly tmpScale = new THREE.Vector3()
  private readonly zeroMatrix = new THREE.Matrix4().makeScale(0, 0, 0)

  constructor(foamMap: THREE.Texture) {
    const geom = new THREE.PlaneGeometry(0.26, 0.26)
    this.opacityAttr = new THREE.InstancedBufferAttribute(
      new Float32Array(MAX_SPRAY),
      1
    )
    geom.setAttribute(SPRAY_OPACITY_ATTR, this.opacityAttr)
    this.uvAttr = new THREE.InstancedBufferAttribute(
      new Float32Array(MAX_SPRAY * 2),
      2
    )
    geom.setAttribute(SPRAY_UV_ATTR, this.uvAttr)

    const mat = new MeshBasicNodeMaterial()
    mat.transparent = true
    mat.depthWrite = false
    mat.side = THREE.DoubleSide
    const foamTex: N = texture(foamMap)
    const quadUV: N = uv()
    const patch = foamTex.sample(
      quadUV.mul(SPRAY_FOAM_PATCH).add(attribute(SPRAY_UV_ATTR, 'vec2'))
    ).r
    // Radial falloff keeps the quad edge invisible; the foam patch
    // thresholded inside it gives each clump its ragged silhouette.
    const radial = float(1).sub(
      smoothstep(float(0.2), float(0.5), length(quadUV.sub(0.5)))
    )
    mat.colorNode = vec3(0.94, 0.97, 1.0)
    mat.opacityNode = smoothstep(float(0.28), float(0.62), patch)
      .mul(radial)
      .mul(attribute(SPRAY_OPACITY_ATTR, 'float'))
      .mul(this.uDayDim)

    this.mesh = new THREE.InstancedMesh(geom, mat, MAX_SPRAY)
    this.mesh.frustumCulled = false
    this.mesh.castShadow = false
    this.mesh.receiveShadow = false
    this.mesh.renderOrder = 3
    for (let i = 0; i < MAX_SPRAY; i++)
      this.mesh.setMatrixAt(i, this.zeroMatrix)
  }

  setDayDim(v: number) {
    this.uDayDim.value = v
  }

  update(dt: number, camera: THREE.Camera, emitters: SprayEmitter[]) {
    // Spawn per emitter: the current piles into the upstream face and
    // kicks droplets up; the stream then carries them back over the rock.
    for (const e of emitters) {
      const rate = 8 + e.turb * 18
      e.acc += dt
      const interval = 1 / rate
      while (e.acc >= interval) {
        e.acc -= interval
        this.spawn(e)
      }
    }

    const opacityArr = this.opacityAttr.array as Float32Array
    const camQuat = camera.quaternion
    let alive = 0
    for (let i = 0; i < this.pool.length; i++) {
      const p = this.pool[i]
      if (!p.alive) continue
      p.age += dt
      if (p.age >= p.maxAge) {
        p.alive = false
        this.mesh.setMatrixAt(i, this.zeroMatrix)
        opacityArr[i] = 0
        continue
      }
      alive++
      p.vy -= 4.0 * dt
      p.x += p.vx * dt
      p.y += p.vy * dt
      p.z += p.vz * dt

      const t = p.age / p.maxAge
      opacityArr[i] = t < 0.15 ? t / 0.15 : t > 0.55 ? 1 - (t - 0.55) / 0.45 : 1
      const scale = p.baseScale * (0.7 + t * 0.9)
      this.tmpPos.set(p.x, p.y, p.z)
      this.tmpScale.set(scale, scale, scale)
      this.tmpMatrix.compose(this.tmpPos, camQuat, this.tmpScale)
      this.mesh.setMatrixAt(i, this.tmpMatrix)
    }
    if (alive > 0 || emitters.length > 0) {
      this.mesh.instanceMatrix.needsUpdate = true
      this.opacityAttr.needsUpdate = true
      this.uvAttr.needsUpdate = true
    }
    this.mesh.count = MAX_SPRAY
    this.mesh.visible = alive > 0
  }

  private spawn(e: SprayEmitter) {
    const slot = this.pool.findIndex((p) => !p.alive)
    if (slot === -1) return
    const p = this.pool[slot]
    // Each clump shows its own random patch of the foam texture.
    const uvArr = this.uvAttr.array as Float32Array
    uvArr[slot * 2] = Math.random() * (1 - SPRAY_FOAM_PATCH)
    uvArr[slot * 2 + 1] = Math.random() * (1 - SPRAY_FOAM_PATCH)
    // Spawn line across the upstream face, perpendicular to the flow.
    const perpX = -e.flowZ
    const perpZ = e.flowX
    const lateral = (Math.random() - 0.5) * 1.6 * e.radius
    p.x = e.x - e.flowX * e.radius * 0.8 + perpX * lateral
    p.z = e.z - e.flowZ * e.radius * 0.8 + perpZ * lateral
    p.y = e.y + 0.05 + (e.sprayYOffset ?? 0)
    // Up and slightly upstream, sideways scatter; the arc then falls
    // back onto the rock/wake under gravity.
    p.vx =
      -e.flowX * (0.15 + Math.random() * 0.3) +
      perpX * (Math.random() - 0.5) * 0.5
    p.vz =
      -e.flowZ * (0.15 + Math.random() * 0.3) +
      perpZ * (Math.random() - 0.5) * 0.5
    p.vy = 0.9 + Math.random() * 1.0
    p.maxAge = 0.35 + Math.random() * 0.4
    p.baseScale = 0.5 + Math.random() * 0.7
    p.age = 0
    p.alive = true
  }

  dispose() {
    this.mesh.geometry.dispose()
    if (this.mesh.material instanceof THREE.Material)
      this.mesh.material.dispose()
    this.mesh.removeFromParent()
  }
}

// ── Wake foam ───────────────────────────────────────────────

const MAX_WAKE = 512
/** Wake clumps show a bigger foam patch than spray droplets — they read
 *  as churned water riding the surface, not thrown droplets. */
const WAKE_FOAM_PATCH = 0.24

interface WakeParticle {
  alive: boolean
  age: number
  maxAge: number
  x: number
  y: number
  z: number
  vx: number
  vy: number
  vz: number
  yaw: number
  spin: number
  baseScale: number
}

/**
 * Foam clumps born at a rock's upstream face — where the current first
 * churns against it — that slip along the sides and trail off behind,
 * drifting with the current: flat quads lying on the water surface (not
 * billboards), each showing a random patch of the shared foam texture,
 * growing and fading as they disperse. The stretch under the rock body
 * is depth-occluded by the mesh, so the visible foam hugs the actual
 * silhouette. Velocity follows the baked flow speed and the emitter's
 * surface slope, so trails run down rapids instead of hovering. Same
 * instanced-pool scheme as RiverSpraySystem.
 */
export class RiverWakeFoamSystem {
  readonly mesh: THREE.InstancedMesh
  private readonly uDayDim = uniform(1)
  private readonly uvAttr: THREE.InstancedBufferAttribute
  private readonly opacityAttr: THREE.InstancedBufferAttribute
  private pool: WakeParticle[] = Array.from({ length: MAX_WAKE }, () => ({
    alive: false,
    age: 0,
    maxAge: 0,
    x: 0,
    y: 0,
    z: 0,
    vx: 0,
    vy: 0,
    vz: 0,
    yaw: 0,
    spin: 0,
    baseScale: 0,
  }))
  private readonly tmpMatrix = new THREE.Matrix4()
  private readonly tmpPos = new THREE.Vector3()
  private readonly tmpScale = new THREE.Vector3()
  private readonly tmpQuat = new THREE.Quaternion()
  private readonly upAxis = new THREE.Vector3(0, 1, 0)
  private readonly zeroMatrix = new THREE.Matrix4().makeScale(0, 0, 0)

  constructor(foamMap: THREE.Texture) {
    const geom = new THREE.PlaneGeometry(1.15, 1.15)
    geom.rotateX(-Math.PI / 2) // lie flat on the water surface
    this.opacityAttr = new THREE.InstancedBufferAttribute(
      new Float32Array(MAX_WAKE),
      1
    )
    geom.setAttribute(SPRAY_OPACITY_ATTR, this.opacityAttr)
    this.uvAttr = new THREE.InstancedBufferAttribute(
      new Float32Array(MAX_WAKE * 2),
      2
    )
    geom.setAttribute(SPRAY_UV_ATTR, this.uvAttr)

    const mat = new MeshBasicNodeMaterial()
    mat.transparent = true
    mat.depthWrite = false
    const foamTex: N = texture(foamMap)
    const quadUV: N = uv()
    const patch = foamTex.sample(
      quadUV.mul(WAKE_FOAM_PATCH).add(attribute(SPRAY_UV_ATTR, 'vec2'))
    ).r
    const radial = float(1).sub(
      smoothstep(float(0.15), float(0.5), length(quadUV.sub(0.5)))
    )
    mat.colorNode = vec3(0.93, 0.96, 1.0)
    mat.opacityNode = smoothstep(float(0.3), float(0.62), patch)
      .mul(radial)
      .mul(attribute(SPRAY_OPACITY_ATTR, 'float'))
      .mul(this.uDayDim)

    this.mesh = new THREE.InstancedMesh(geom, mat, MAX_WAKE)
    this.mesh.frustumCulled = false
    this.mesh.castShadow = false
    this.mesh.receiveShadow = false
    // Below the spray (3): drifting foam sits on the water, droplets fly
    // over it.
    this.mesh.renderOrder = 2
    for (let i = 0; i < MAX_WAKE; i++) this.mesh.setMatrixAt(i, this.zeroMatrix)
  }

  setDayDim(v: number) {
    this.uDayDim.value = v
  }

  update(dt: number, emitters: SprayEmitter[]) {
    for (const e of emitters) {
      const rate = 3 + e.turb * 4.5
      e.wakeAcc += dt
      const interval = 1 / rate
      while (e.wakeAcc >= interval) {
        e.wakeAcc -= interval
        this.spawn(e)
      }
    }

    const opacityArr = this.opacityAttr.array as Float32Array
    let alive = 0
    for (let i = 0; i < this.pool.length; i++) {
      const p = this.pool[i]
      if (!p.alive) continue
      p.age += dt
      if (p.age >= p.maxAge) {
        p.alive = false
        this.mesh.setMatrixAt(i, this.zeroMatrix)
        opacityArr[i] = 0
        continue
      }
      alive++
      p.x += p.vx * dt
      p.y += p.vy * dt
      p.z += p.vz * dt
      p.yaw += p.spin * dt

      const t = p.age / p.maxAge
      opacityArr[i] =
        (t < 0.1 ? t / 0.1 : t > 0.55 ? 1 - (t - 0.55) / 0.45 : 1) * 0.9
      const scale = p.baseScale * (1 + t * 0.8)
      this.tmpPos.set(p.x, p.y, p.z)
      this.tmpScale.set(scale, 1, scale)
      this.tmpQuat.setFromAxisAngle(this.upAxis, p.yaw)
      this.tmpMatrix.compose(this.tmpPos, this.tmpQuat, this.tmpScale)
      this.mesh.setMatrixAt(i, this.tmpMatrix)
    }
    if (alive > 0 || emitters.length > 0) {
      this.mesh.instanceMatrix.needsUpdate = true
      this.opacityAttr.needsUpdate = true
      this.uvAttr.needsUpdate = true
    }
    this.mesh.count = MAX_WAKE
    this.mesh.visible = alive > 0
  }

  private spawn(e: SprayEmitter) {
    const slot = this.pool.findIndex((p) => !p.alive)
    if (slot === -1) return
    const p = this.pool[slot]
    const uvArr = this.uvAttr.array as Float32Array
    uvArr[slot * 2] = Math.random() * (1 - WAKE_FOAM_PATCH)
    uvArr[slot * 2 + 1] = Math.random() * (1 - WAKE_FOAM_PATCH)
    // Born at the upstream face where the current first breaks on the
    // rock; the flow then carries the clump along the sides (the
    // under-rock stretch is hidden by the mesh) and off behind.
    const perpX = -e.flowZ
    const perpZ = e.flowX
    const face = -e.radius * (0.4 + Math.random() * 0.6)
    const lateral = (Math.random() - 0.5) * 2.1 * e.radius
    p.x = e.x + e.flowX * face + perpX * lateral
    p.z = e.z + e.flowZ * face + perpZ * lateral
    p.y = e.y + 0.05
    // Carried by the current, pinched slightly outward around the body;
    // the trail length is drift speed × lifetime.
    const drift = 0.3 + 0.8 * e.speed
    const outward = Math.sign(lateral) * (0.04 + Math.random() * 0.1)
    p.vx = e.flowX * drift + perpX * ((Math.random() - 0.5) * 0.08 + outward)
    p.vz = e.flowZ * drift + perpZ * ((Math.random() - 0.5) * 0.08 + outward)
    p.vy = -e.drop * drift
    // + the extra travel from starting upstream of the rock.
    p.maxAge = Math.min(
      10,
      Math.max(2.5, (3.0 + e.turb * 4.5 + 2 * e.radius) / drift)
    )
    p.yaw = Math.random() * Math.PI * 2
    p.spin = (Math.random() - 0.5) * 0.5
    p.baseScale = 0.55 + Math.random() * 0.75
    p.age = 0
    p.alive = true
  }

  dispose() {
    this.mesh.geometry.dispose()
    if (this.mesh.material instanceof THREE.Material)
      this.mesh.material.dispose()
    this.mesh.removeFromParent()
  }
}

// ── Waterline collar ────────────────────────────────────────

/** Rock centre along the quad's U axis. Placing it toward the upstream
 * side of the oval leaves a broader, longer patch behind the rock. */
const COLLAR_ROCK_U = 0.34
const COLLAR_LENGTH = 2.7
const COLLAR_WIDTH = 3.0
const COLLAR_OVAL_CENTRE_U = 0.48
const COLLAR_OVAL_RADIUS_U = 0.43
const COLLAR_OVAL_RADIUS_V = 0.4

/**
 * Broad oval foam patch at each rock's waterline. The rock sits toward
 * the upstream side of the oval, leaving a longer, wider foam area behind
 * it without a pointed teardrop tail.
 * One shared quad + one shared material (one pipeline); each mesh is
 * yawed so its local +U axis points downstream. The oval's inner area
 * hides under the rock body via depth, so the visible fringe hugs the
 * actual silhouette. The shared texture is
 * sampled in local U/V space, so its scroll follows the river current.
 */
export class RiverRockFoamCollars {
  private readonly material: MeshBasicNodeMaterial
  private readonly geom: THREE.PlaneGeometry
  private readonly uDayDim = uniform(1)
  private readonly uTime = uniform(0)

  constructor(foamMap: THREE.Texture) {
    this.geom = new THREE.PlaneGeometry(1, 1)
    this.geom.rotateX(-Math.PI / 2) // lie flat on the water surface

    const mat = new MeshBasicNodeMaterial()
    mat.transparent = true
    mat.depthWrite = false
    const foamTex: N = texture(foamMap)
    const u: N = uv().x
    const v: N = uv().y
    const ovalD = length(
      vec2(
        u.sub(COLLAR_OVAL_CENTRE_U).div(COLLAR_OVAL_RADIUS_U),
        v.sub(0.5).div(COLLAR_OVAL_RADIUS_V)
      )
    )
    const collarTexUv = vec2(
      u.mul(1.1).sub(this.uTime.mul(0.16)),
      v.mul(2.6).add(this.uTime.mul(0.04))
    )
    const foamPatch = foamTex.sample(collarTexUv).r
    // A separate, finer patch perturbs only the oval distance field so the
    // silhouette breaks up without losing its broad downstream shape.
    const edgeNoiseUv = vec2(
      u.mul(4.6).sub(this.uTime.mul(0.26)),
      v.mul(4.6).add(this.uTime.mul(0.1))
    )
    const edgeJitter = foamTex.sample(edgeNoiseUv).r.sub(0.5).mul(0.34)
    const foamShape = float(1).sub(
      smoothstep(float(0.74), float(1.0), ovalD.add(edgeJitter))
    )
    mat.colorNode = vec3(0.94, 0.97, 1.0)
    mat.opacityNode = smoothstep(float(0.28), float(0.52), foamPatch)
      .mul(foamShape)
      .mul(0.85)
      .mul(this.uDayDim)
    this.material = mat
  }

  /** One oval collar mesh per rock, offset so its broader section extends
   *  downstream. Parent it to the tile group (shared geometry/material —
   *  remove only, never dispose per tile). */
  createMesh(
    x: number,
    y: number,
    z: number,
    rockHalfWidth: number,
    flowX: number,
    flowZ: number
  ): THREE.Mesh {
    const m = new THREE.Mesh(this.geom, this.material)
    const along = rockHalfWidth * COLLAR_LENGTH
    m.scale.set(along, 1, rockHalfWidth * COLLAR_WIDTH)
    // The rock sits at U = COLLAR_ROCK_U, upstream of the oval centre.
    const off = (0.5 - COLLAR_ROCK_U) * along
    m.position.set(x + flowX * off, y, z + flowZ * off)
    // Local +X (the U axis) → world flow direction.
    m.rotation.y = Math.atan2(-flowZ, flowX)
    m.castShadow = false
    m.receiveShadow = false
    // Above the water (0), under the drifting wake clumps (2).
    m.renderOrder = 1
    return m
  }

  setDayDim(v: number) {
    this.uDayDim.value = v
  }

  setTime(t: number) {
    this.uTime.value = t
  }

  dispose() {
    this.geom.dispose()
    this.material.dispose()
  }
}
