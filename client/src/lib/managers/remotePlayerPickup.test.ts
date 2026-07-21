import { beforeEach, describe, expect, it } from 'vitest'
import { remotePlayerManager } from './remotePlayerManager'

const ID = 1

function startPickupAt(x: number, z: number) {
  remotePlayerManager.initPlayer(ID, { x, y: 0, z }, 0)
  remotePlayerManager.handleInteraction(ID, 'pickup', 0)
}

function stateOf() {
  return remotePlayerManager.players.get(ID)?.state
}

describe('remote pickup crouch', () => {
  beforeEach(() => {
    remotePlayerManager.reset()
  })

  it('ends when the picker moves away, matching their own client', () => {
    startPickupAt(0, 0)
    expect(stateOf()).toBe('interact')

    remotePlayerManager.setTargetPosition(ID, { x: 3, y: 0, z: 0 }, 0)

    expect(stateOf()).toBe('idle')
  })

  it('survives the resting flush sent where the walk to the item ended', () => {
    startPickupAt(0, 0)

    remotePlayerManager.setTargetPosition(ID, { x: 0.05, y: 0, z: 0.05 }, 0)

    expect(stateOf()).toBe('interact')
  })

  it('leaves held poses alone — they wait for their StopInteraction', () => {
    remotePlayerManager.initPlayer(ID, { x: 0, y: 0, z: 0 }, 0)
    remotePlayerManager.handleInteraction(ID, 'bench_sit', 0)

    remotePlayerManager.setTargetPosition(ID, { x: 3, y: 0, z: 0 }, 0)

    expect(stateOf()).toBe('interact')
  })
})
