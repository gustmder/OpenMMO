import * as THREE from 'three'
import { MeshBasicNodeMaterial } from 'three/webgpu'
import {
  abs,
  cameraPosition,
  dot,
  float,
  mix,
  normalLocal,
  normalWorldGeometry,
  normalize,
  positionLocal,
  positionWorld,
  pow,
  smoothstep,
  uniform,
  vec2,
} from 'three/tsl'
import { valueNoise } from './tsl-noise'

export function createGroundItemGlowMaterial() {
  const uColor = uniform(new THREE.Color('#ffd36a'))
  const uOpacity = uniform(0.55)
  const uShellOffset = uniform(0.025)
  const uTime = uniform(0)

  const mat = new MeshBasicNodeMaterial()
  mat.side = THREE.BackSide
  mat.transparent = true
  mat.depthWrite = false
  mat.depthTest = true
  mat.blending = THREE.AdditiveBlending
  mat.toneMapped = false

  mat.positionNode = positionLocal.add(normalize(normalLocal).mul(uShellOffset))

  const viewDir = normalize(cameraPosition.sub(positionWorld))
  const facing = abs(dot(normalize(normalWorldGeometry), viewDir))
  const rim = pow(float(1).sub(facing), float(0.7))
  const rimFade = smoothstep(float(0.08), float(0.88), rim)
  const innerFade = float(1).sub(rimFade)
  const shimmer = valueNoise(
    positionWorld.xz.mul(7).add(vec2(uTime.mul(0.35), uTime.mul(-0.22)))
  )
  const ember = smoothstep(float(0.62), float(1), shimmer).mul(0.26)
  const breathe = float(0.86).add(
    positionWorld.y.mul(8).add(uTime.mul(2.4)).sin().mul(0.14)
  )
  const alpha = innerFade
    .mul(float(0.92).add(ember.mul(0.2)))
    .mul(uOpacity)
    .mul(breathe)
  const intensity = mix(float(0.85), float(2.35), innerFade).add(ember.mul(0.8))

  mat.colorNode = uColor.mul(intensity)
  mat.opacityNode = alpha

  // uColor is fixed at creation; only the pulse uniforms are driven per-frame.
  return {
    material: mat,
    uniforms: { uOpacity, uShellOffset, uTime },
  }
}
