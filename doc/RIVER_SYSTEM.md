# 강 시스템 (River System)

내륙 강 렌더링 시스템. 바다 수면([WATER_SYSTEM.md](WATER_SYSTEM.md))과 별도의
파이프라인으로 동작하며, Phase 4 절차적 생성이 만든 강 polyline을 **타일별
RFD1 (River Field Data v1) 바이너리 — surfaceY + flow direction 텍스처** 로
굽고, 런타임은 그 위에 플랫 quad 하나만 깔아서 셰이더로 모든 시각 효과를
유도한다.

> 과거 디자인은 polyline → 리본 메시 + 정점별 attribute 였지만, 메시 봉합·
> miter join·flow direction 보간이 복잡해서 현재의 "타일당 65×65 텍스처 +
> 플랫 quad" 구조로 완전히 교체됨. 옛 ribbon geometry 코드 경로는 모두 제거.

## 1. 개요

- Phase 4 [`rivers.rs`](../shared/src/worldgen/rivers.rs)가 추출한 강 polyline을
  타일 bake 시점에 **per-pixel surfaceY + flowDir** 로 굽는다 (65×65 grid,
  지형 vertex 와 정확히 정렬).
- 런타임은 타일당 플랫 quad 하나(Y는 vertex shader 가 surfaceY 로 변위)와
  공유 강 머티리얼로 렌더. drawcall 은 강 있는 타일에만 1회.
- 가시 범위 / 가장자리 페이드는 모두 셰이더에서 `depth = surfaceY − heightmap`
  로 유도 — 별도 폭(width) 메시 같은 건 없다. 강의 보이는 폭은 곧 hightmap
  carve가 만든 단면.

### 1.1 바다 셰이더를 재사용할 수 없는 이유

- 바다는 Y=0 평면 quad 가 전제. 강은 매 픽셀의 surfaceY 가 다르다 (해발
  2m 해안부터 산지 100m+).
- 바다의 Gerstner wave, shore drawback, wet sand, hole alpha 는 전부 "넓은
  해수면" 전제. 수 m 폭의 강에 그대로 적용하면 어색.
- 바다는 한 방향 wind drift. 강은 픽셀마다 flow direction 이 다르고 그
  방향으로 ripple 노멀맵이 스크롤되어야 한다.

## 2. 데이터 파이프라인

### 2.1 Phase 4 polyline 추출

[`shared/src/worldgen/rivers.rs`](../shared/src/worldgen/rivers.rs)

1. `compute_flow(map) → RiverMap` — Barnes 2014 priority-queue pit-fill +
   D8 flow direction.
2. `extract_rivers(map, river_map, min_peak_elev, min_polyline_length)` —
   peak 셀에서 mouth 까지 trace 해서 `Vec<Polyline>` 채움.
3. 후처리 (이 순서로 수행):
   - `naturalize_river_meanders` — 비-anchor 정점을 windowed 접선의 수직
     방향으로 2-octave sine noise 변위. 진폭은 flow 에 비례, 합류부에서
     점차 0 으로 taper.
   - `synthesize_distributary_deltas` — top-flow 강의 trunk 를 apex 에서
     절단하고 부채꼴로 3 갈래 분류(distributary) 가지를 생성.
   - `remove_polyline_self_overlaps` — Bresenham 래스터화 후 hairpin 으로
     같은 셀이 8 정점 이상 거리를 둔 채 재방문되는 구간을 절단. 합류부에
     평행으로 흐르는 두 갈래가 만들어 내는 flow field smearing 을 방지.
   - `merge_overlapping_polylines` — 평행하게 흐르는 인접 polyline 을
     main stem 으로 흡수.

각 polyline 정점은 (cell_x, cell_z) `u32` 격자 좌표 + `flow` 누적값.
World-meter 좌표는 `vector_features.rs`의 `rivers_world` 변환에서 X-wrap
이음새 분리와 함께 처리된다.

### 2.2 Polyline → 세그먼트 변환

[`shared/src/worldgen/vector_features.rs`](../shared/src/worldgen/vector_features.rs)

타일 bake 시점에 `BakeContext`가 polyline 을 Chaikin smooth + 정점별
`flow_norm` / `width` 보간된 **세그먼트** 로 분해.

```rust
struct RiverSegment {
    ax, az, bx, bz: f32,            // world-space endpoints
    flow_norm_a, flow_norm_b: f32,  // 정규화된 flow [0,1]
    width_a, width_b: f32,          // 폭 (m)
}
```

`width` 매핑: `min_w + (max_w − min_w) · log1p(flow)/log1p(max_flow)`
(상수는 `tile_bake/constants.rs`: `RIVER_MIN_WIDTH_M=1.5`, `RIVER_MAX_WIDTH_M=10.0`).

타일별 베이크는 `river_segments_near_tile(rivers_world, tile_min, tile_max, margin)`
로 bbox + margin 안에 걸친 세그먼트만 끄집어내서 사용 — 한 타일에 보통
수~수십 개.

### 2.3 Heightmap carve

[`tile_bake/heightmap.rs`](../shared/src/worldgen/tile_bake/heightmap.rs)

각 heightmap 정점에서 가장 가까운 강 세그먼트로의 projection 거리를 계산,
flow-aware carve 깊이를 차감.

세그먼트별 carve 파라미터 (`tile_bake/constants.rs`):
- `RIVER_CARVE_DEPTH_MIN_M = 0.6` ~ `+RIVER_CARVE_DEPTH_EXTRA_M = 1.4` → 최대 2.0 m
- `RIVER_CARVE_MIN_BED_Y_M = 0.1` — bed floor clamp. 하구 근처에서 bed 가
  음수로 내려가 바다 셰이더의 shore drawback 이 강 위에서 발동하는 것을 방지.
- 폭은 세그먼트 정점 `width` 보간으로, 가장자리 taper 는 smoothstep.

이 carve 가 만든 단면이 곧 보이는 강의 폭이다. 셰이더는 별도의 width
mesh 를 갖지 않고 `depth = surfaceY − bedY` 로 가시 영역만 그린다.

### 2.4 RFD1 baking

[`tile_bake/river_field.rs`](../shared/src/worldgen/tile_bake/river_field.rs)

`bake_river_field(map, ctx, heights, tile_origin, river_segs) → Option<Vec<u8>>`.
세그먼트가 0 이면 `None` 을 반환해 파일을 만들지 않음 (강 없는 타일).

처리:
1. **세그먼트 unit tangent 사전계산** — 타일당 S 개 segment 에 대해
   `(dx, dz)/len` 을 한 번만 계산해 픽셀 루프에서 재사용.
2. **픽셀 65×65** 마다 `weighted_flow_and_nearest(wx, wz, segs, tangents)`
   호출:
   - 모든 세그먼트의 `1/(d² + 1)` 가중치 평균으로 flow direction 계산.
     인접 픽셀들이 Voronoi 경계에서 다른 세그먼트로 할당될 때 1-픽셀
     direction step 이 생기는 것을 막는다 (가까울수록 dominant).
   - cancellation (방향 상쇄) 시 nearest 세그먼트의 tangent 로 폴백 —
     픽셀이 zero flow 로 stall 되지 않게.
3. **surfaceY** = `bed_at_proj + RIVER_DEPTH_OFFSET_M (0.5 m)`.
   `bed_at_proj` 는 nearest 세그먼트의 centerline projection 위치의
   post-carve 지형 높이 (in-tile 이면 baked heightmap bilinear, 타일
   바깥이면 natural + carve 공식 재계산). 한 픽셀이 같은 centerline 점에
   투영되는 한 surface 는 수평을 유지 → 강이 채널을 따라 일관된 평면.
4. 결과를 16-byte header + 65×65×4 byte pixel 로 직렬화.

## 3. RFD1 바이너리 포맷

매직 `b"RFD1"` = **R**iver **F**ield **D**ata version **1**. 디코더가 첫
4 바이트로 포맷을 식별하는 표식 (PNG·ZIP 등이 첫 바이트에 매직을 두는
관습과 동일).

```
header (16 bytes):
  bytes  0..4   magic    b"RFD1"
  bytes  4..6   u16      version (현재 1)
  bytes  6..8   u16      grid_x  (== 65)
  bytes  8..10  u16      grid_z  (== 65)
  bytes 10..16  u8[6]    reserved (0)

per-pixel (4 bytes, row-major over 65×65, X then Z):
  bytes  0..2   u16      surfaceY (heightmap 와 동일: (h + 500) / 0.05)
  byte   2      i8       flowX (unit vector × 127, [-127..+127])
  byte   3      i8       flowZ (unit vector × 127)
```

총 `16 + 65*65*4 = 16916` bytes per file.

**타일 경계 일관성**: 한 정점이 두 타일에 동시에 속할 때, 양쪽이 같은
세그먼트 목록(전역 `river_margin` 필터)을 보므로 같은 world-XZ 픽셀에서
surfaceY/flowDir 가 비트 단위로 일치 → 타일 이음새 보이지 않음.

디코더: [`client/src/lib/utils/river-field-data.ts`](../client/src/lib/utils/river-field-data.ts).

## 4. 클라이언트 로딩

| 컴포넌트 | 역할 |
|---|---|
| [`riverFieldManager.ts`](../client/src/lib/managers/riverFieldManager.ts) | 타일별 RFD1 fetch + 디코드 + 캐시. 404 → null. |
| [`river-field-data.ts`](../client/src/lib/utils/river-field-data.ts) | 바이너리 → `{surfaceY, flowX, flowZ}: Float32Array` (각 65×65). |
| [`river-quad-geometry.ts`](../client/src/lib/utils/river-quad-geometry.ts) | 65×65 PlaneGeometry 생성 + vertex Y 를 surfaceY 로 채움. 보조 함수 `buildRiverFieldTexture` 는 RGBA32F DataTexture (R=surfaceY, GB=flowDir) 도 만들어 셰이더에서 bilinear 보간으로 다시 샘플. |
| [`GameSceneRiverLayer.svelte`](../client/src/lib/components/game-scene/GameSceneRiverLayer.svelte) | 활성 terrain 타일 목록과 동기화해 타일별 메시 lifecycle 관리. |

**왜 geometry vertex Y 와 텍스처 둘 다?** Vertex Y 는 65×65 격자에 정확히
정렬돼서 alpha=0 픽셀의 폴리곤이 바닥에 깔린다 (z-fighting 없음).
텍스처 surfaceY 는 픽셀별 bilinear 로 더 부드러운 depth fade.

## 5. 강 머티리얼 (River Field Material)

[`client/src/lib/shaders/river-field-material.ts`](../client/src/lib/shaders/river-field-material.ts)

TSL `NodeMaterial` (WebGPU). 입력: `heightmapTexture`, `riverField`,
`normalMap`, `reflectionMap`, `refractionMap` + 시간 / 태양 / 횃불 uniforms.

### 5.1 Vertex

플랫 quad 의 `positionLocal` 을 그대로 world 로 변환. Y 는 이미 geometry
에 구워져 있으므로 변위 없음.

### 5.2 Fragment

샘플 UV 는 `clamp(toHeightmapUV(uv()), 0, 1)` — half-texel inset 로 텍셀
중심에 정확히 정렬.

1. **Depth fade**
   - `bedHeight = heightmapTex.sample(uv).r`
   - `depth = max(0, surfaceY − bedHeight)` (surfaceY = `vWorldPos.y`,
     즉 geometry 의 baked vertex Y)
   - `depthFactor = clamp(depth / uMaxDepth (=0.5m), 0, 1)`
   - **Hard edge**: `depthEdgeCut = smoothstep(0, 0.05, depth)` —
     5 cm 안쪽은 hard cut 으로 carve 경계를 정확히 띄움.
   - **Body alpha**: `mix(0.005, 0.95, smoothstep(0.05, 0.5, depth))` 로
     마무리 페이드. `alpha = 0.95 · depthEdgeCut · bodyAlpha`.

2. **색상 그라디언트** — 3-stop 깊이 (sea-style):
   - `uShallowColor = (0.18, 0.32, 0.32)` → `uMidColor = (0.04, 0.12, 0.18)` →
     `uDeepColor = (0.02, 0.05, 0.12)`. 야간 감쇠 적용.

3. **Refraction** (얕은 물에서 바닥이 비침)
   - `refractionTex` 를 ripple 노멀로 distort 해 sample.
   - `refrShallow = 1 − smoothstep(0.05, 0.5, depthFactor)` 로 얕은 곳만
     refraction 비중 ↑, 깊은 중앙은 body 색이 dominant.

4. **Ripple normal** — flow 방향 스크롤 + dual-phase flowmap
   - 픽셀별 `flowDir = riverFieldTex.sample(uv).gb` (bilinear 보간 →
     합류부에서 두 흐름이 자연스럽게 섞임).
   - `flowDir × uTime` 처럼 단순히 스크롤하면 인접 픽셀의 약간 다른 flowDir
     이 시간이 지나며 텍스처 공간에서 decorrelate → **소용돌이 아티팩트**
     누적. 해결: Valve 식 dual-phase flowmap.

   ```ts
   buildWrappedDrift(rate, flow) {
     phase = uTime × rate
     pA    = fract(phase)
     pB    = fract(phase + 0.5)
     mixW  = abs(pA − 0.5) × 2          // triangle wave
     return { driftA: flow × pA, driftB: flow × pB, mixW }
   }
   ```

   두 phase 로 normalMap 을 각각 샘플해 `mix(sA, sB, mixW)` 로 crossfade —
   각 phase wrap 시점에 반대 phase 가 dominant 라 점프가 안 보인다.
   적용 위치: main ripple (`rate=0.4`) + sky reflection drift
   (`rate=WOBBLE_DRIFT_RATE=0.05`).

5. **Sky reflection** — fresnel + reflection map + cloud photo + sun glare.
   바다 셰이더와 거의 동일. `reflRippleN` 으로 view-aligned 약간의 noise.

6. **Specular** — sun half-vector pow + sparkle layer (uTime × 0.05 로
   스크롤, sparkle 자체는 dual-phase 미적용 — 고주파라 vortex 가
   눈에 띄지 않음).

7. **횃불 라이팅** — torch position 기반 diffuse + specular + 거리 페이드.

8. **야간**: 태양 고도 기반 multiplier + moon ambient/specular.

### 5.3 Uniforms

| 이름 | 타입 | 용도 |
|---|---|---|
| `uTime` | f32 | scroll/sparkle 위상 |
| `uSunDirection`, `uSunColor`, `uMoonBrightness` | vec3/color/f32 | 라이팅 |
| `uCameraDirection` | vec3 | view 방향 (specular) |
| `uTorchPos`, `uTorchColor`, `uTorchIntensity`, `uTorchDistance` | — | 횃불 |
| `uShallowColor`, `uMidColor`, `uDeepColor` | color×3 | depth gradient |
| `uMaxDepth` | f32 | depth fade 상한 (0.5 m) |
| `uRefractionStrength` | f32 | refraction UV 왜곡량 (0.04) |
| `uReflectionMap`, `uRefractionMap`, `uNormalMap` | tex | 멀티패스 + ripple |
| `uHeightmapTexture` | tex | bedHeight 샘플 |
| `uRiverField` | tex | surfaceY + flowDir (RFD1 → DataTexture) |

## 6. 하구 (Estuary) 처리

별도 mouth-detection 메타데이터 없음 — 두 단계의 자연스러운 인터랙션으로 처리:

1. **Bed floor clamp** — heightmap carve 단계에서 `RIVER_CARVE_MIN_BED_Y_M`
   (0.1 m) 이하로는 파지 않는다. 결과: 하구 부근에서 bed 가 sea level
   위로 살짝 올라와 바다 셰이더의 `depth = waterY − terrainY` 가 0 이
   되어 shore drawback 이 강 영역에서 발동 안 함.

2. **Depth-fade 자연 페이드** — 강 셰이더의 `depthEdgeCut +
   bodyAlpha` 자체가 surface-bed 차이로 페이드되므로, 하구에서
   bed 가 surface 에 근접하면 강 quad 알파가 자연스럽게 0 으로 떨어진다.
   별도 mouth 알파 attribute 불필요.

색 팔레트는 강·바다 양쪽 모두 그대로 유지 (mouth fade 가 알파 페이드일
뿐 색을 섞지 않음). 진정한 delta/sediment plume 같은 사실적 표현은
별도 worldgen 단계 필요 — 현재 미구현.

## 7. 핵심 파일

### Shared (Rust)
| 파일 | 역할 |
|---|---|
| [`shared/src/worldgen/rivers.rs`](../shared/src/worldgen/rivers.rs) | Phase 4: polyline 추출 + meander/distributary/self-overlap 후처리 |
| [`shared/src/worldgen/vector_features.rs`](../shared/src/worldgen/vector_features.rs) | `RiverSegment`, `nearest_river_segment`, `project_point_to_segment`, `river_segments_near_tile` |
| [`shared/src/worldgen/tile_bake/heightmap.rs`](../shared/src/worldgen/tile_bake/heightmap.rs) | 강 carve (flow-aware depth + width) |
| [`shared/src/worldgen/tile_bake/river_field.rs`](../shared/src/worldgen/tile_bake/river_field.rs) | RFD1 바이너리 베이크 (weighted flow + surfaceY) |
| [`shared/src/worldgen/tile_bake/constants.rs`](../shared/src/worldgen/tile_bake/constants.rs) | `RIVER_*` 상수 (폭/깊이/오프셋/min bed) |

### Client (TS / Svelte)
| 파일 | 역할 |
|---|---|
| [`client/src/lib/utils/river-field-data.ts`](../client/src/lib/utils/river-field-data.ts) | RFD1 디코더 |
| [`client/src/lib/managers/riverFieldManager.ts`](../client/src/lib/managers/riverFieldManager.ts) | 타일별 fetch + 캐시 |
| [`client/src/lib/utils/river-quad-geometry.ts`](../client/src/lib/utils/river-quad-geometry.ts) | 65×65 quad + DataTexture 빌드 |
| [`client/src/lib/shaders/river-field-material.ts`](../client/src/lib/shaders/river-field-material.ts) | TSL `NodeMaterial` (depth fade + dual-phase flowmap + 멀티패스) |
| [`client/src/lib/components/game-scene/GameSceneRiverLayer.svelte`](../client/src/lib/components/game-scene/GameSceneRiverLayer.svelte) | 타일 lifecycle / 메시 풀 |

### Tools
| 파일 | 역할 |
|---|---|
| [`tools/terrain-gen/src/main.rs`](../tools/terrain-gen/src/main.rs) | `bake` 시 RFD1 도 함께 출력 |
| [`tools/terrain-gen/src/inspect.rs`](../tools/terrain-gen/src/inspect.rs) | `inspect-tile` 서브커맨드 — 한 타일에 영향을 주는 강 segment 덤프 (디버깅용) |

## 8. 미해결 / 추후

- **폭포**: 세그먼트 slope 가 큰 구간을 별도 처리 안 함 — 그냥 surfaceY 가
  급격히 떨어지는 모양. 별도 셰이더/효과는 후순위.
- **플레이어 수영**: 서버가 surfaceY 를 알아야 수영 판정이 가능. RFD1 을
  서버측에서도 로드하는 패스 필요. 현재는 시각화 전용.
- **Sediment plume / delta 지형**: 하구에 가까울수록 바다 색이 탁해지는
  거리장 효과 + 부채꼴 carve. worldgen 개편이 함께 필요.
