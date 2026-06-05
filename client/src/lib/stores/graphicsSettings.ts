import { writable, derived, get } from 'svelte/store'
import { refractionEnabled, reflectionEnabled } from './debugStore'

export type QualityLevel = 'high' | 'medium' | 'low'

export interface GraphicsPreset {
  pixelRatioCap: number
  shadowMapSize: number
  antialias: boolean
  refraction: boolean
  reflection: boolean
  grassDensity: number
}

const PRESETS: Record<QualityLevel, GraphicsPreset> = {
  high: {
    pixelRatioCap: 2.0,
    shadowMapSize: 4096,
    antialias: true,
    refraction: true,
    reflection: true,
    grassDensity: 1.0,
  },
  medium: {
    pixelRatioCap: 1.5,
    shadowMapSize: 2048,
    antialias: false,
    refraction: true,
    reflection: true,
    grassDensity: 1.0,
  },
  low: {
    pixelRatioCap: 1.0,
    shadowMapSize: 1024,
    antialias: false,
    refraction: false,
    reflection: false,
    grassDensity: 0.5,
  },
}

const STORAGE_KEY = 'onlinerpg_graphicsQuality'
const STORAGE_KEY_APPLIED_AA = 'onlinerpg_appliedAA'

export function shouldUseMobileRenderBudget(): boolean {
  if (typeof window === 'undefined') return false

  const coarsePointer =
    window.matchMedia?.('(pointer: coarse)').matches ?? false
  const narrowViewport = Math.min(window.innerWidth, window.innerHeight) <= 600
  const touchDevice = navigator.maxTouchPoints > 0

  return touchDevice && (coarsePointer || narrowViewport)
}

export function shouldUseIphoneRenderBudget(): boolean {
  if (typeof window === 'undefined') return false

  const ua = navigator.userAgent
  const explicitIphone = /\biPhone\b/.test(ua)
  const tinyTouchViewport =
    navigator.maxTouchPoints > 0 &&
    Math.min(window.innerWidth, window.innerHeight) <= 430

  return explicitIphone || tinyTouchViewport
}

function getMobileSafePreset(preset: GraphicsPreset): GraphicsPreset {
  return {
    ...preset,
    pixelRatioCap: Math.min(preset.pixelRatioCap, 1.0),
    shadowMapSize: Math.min(preset.shadowMapSize, 1024),
    antialias: false,
    refraction: false,
    reflection: false,
    grassDensity: Math.min(preset.grassDensity, 0.5),
  }
}

function loadQuality(): QualityLevel {
  try {
    const stored = localStorage.getItem(STORAGE_KEY)
    if (stored === 'high' || stored === 'medium' || stored === 'low')
      return stored
  } catch {
    // localStorage unavailable
  }
  return 'medium'
}

/**
 * Called once at renderer creation time.
 * Returns the antialias flag and records what was applied
 * so `reloadNeeded` can detect mismatches later.
 */
export function applyInitialAntialias(): boolean {
  const aa = getEffectivePreset(loadQuality()).antialias
  try {
    localStorage.setItem(STORAGE_KEY_APPLIED_AA, String(aa))
  } catch {
    // localStorage unavailable
  }
  return aa
}

export const graphicsQuality = writable<QualityLevel>(loadQuality())

/** True when the current preset's antialias differs from what the renderer was created with. */
export const reloadNeeded = derived(graphicsQuality, (level) => {
  try {
    const appliedAA = localStorage.getItem(STORAGE_KEY_APPLIED_AA) === 'true'
    return getEffectivePreset(level).antialias !== appliedAA
  } catch {
    return false
  }
})

// Sync to localStorage and debugStore on change
graphicsQuality.subscribe((level) => {
  try {
    localStorage.setItem(STORAGE_KEY, level)
  } catch {
    // localStorage unavailable
  }
  const preset = getEffectivePreset(level)
  refractionEnabled.set(preset.refraction)
  reflectionEnabled.set(preset.reflection)
})

export function getPreset(level: QualityLevel): GraphicsPreset {
  return PRESETS[level]
}

export function getEffectivePreset(level: QualityLevel): GraphicsPreset {
  const preset = PRESETS[level]
  return shouldUseMobileRenderBudget() || shouldUseIphoneRenderBudget()
    ? getMobileSafePreset(preset)
    : preset
}

export function getCurrentPreset(): GraphicsPreset {
  return getEffectivePreset(get(graphicsQuality))
}
