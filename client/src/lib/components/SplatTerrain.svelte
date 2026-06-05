<script lang="ts">
  import { T } from '@threlte/core'
  import * as THREE from 'three'

  interface Props {
    geometry: THREE.BufferGeometry
    material: THREE.Material
    mesh?: THREE.Mesh | undefined
    tileId?: string
    position?: [number, number, number]
    onBeforeRender?: THREE.Mesh['onBeforeRender'] | null
  }

  let {
    geometry,
    material,
    mesh = $bindable(undefined),
    tileId = '',
    position = [0, 0, 0],
    onBeforeRender = null,
  }: Props = $props()

  function handleCreate(ref: THREE.Mesh) {
    ref.userData.tileId = tileId
    if (onBeforeRender) ref.onBeforeRender = onBeforeRender
  }
</script>

<T.Mesh
  bind:ref={mesh}
  {geometry}
  {material}
  {position}
  receiveShadow
  frustumCulled={false}
  dispose={false}
  oncreate={handleCreate}
/>
