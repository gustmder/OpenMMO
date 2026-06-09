import { describe, expect, it, vi } from 'vitest'
import type { ControlState } from './control-state'
import type { PlayerControlEvent } from './events'
import { PlayerControlMachine } from './machine'
import { createPlayerControlStateDefinitions } from './state-definitions'

function makeEvent(type: 'anim_pickup_grab' | 'anim_interaction_finished') {
  return { type } satisfies PlayerControlEvent
}

describe('PlayerControlMachine', () => {
  it('drains queued events before per-frame phases and tick', () => {
    const calls: string[] = []
    const machine = new PlayerControlMachine(
      {
        dispatchEvent: (event) => calls.push(`event:${event.type}`),
      },
      {
        states: createPlayerControlStateDefinitions({
          idle: {
            handleInteractKey: () => {
              calls.push('interact')
            },
            handleKeyboard: () => {
              calls.push('keyboard')
            },
            tick: () => {
              calls.push('tick')
            },
          },
        }),
      }
    )

    machine.enqueueEvent(makeEvent('anim_pickup_grab'))
    machine.update(16, {
      editorMode: false,
      events: [makeEvent('anim_interaction_finished')],
    })

    expect(calls).toEqual([
      'event:anim_pickup_grab',
      'event:anim_interaction_finished',
      'interact',
      'keyboard',
      'tick',
    ])
  })

  it('skips interact and keyboard phases in editor mode but still ticks', () => {
    const handleInteractKey = vi.fn()
    const handleKeyboard = vi.fn()
    const tick = vi.fn()
    const machine = new PlayerControlMachine(
      {
        dispatchEvent: vi.fn(),
      },
      {
        states: createPlayerControlStateDefinitions({
          idle: {
            handleInteractKey,
            handleKeyboard,
            tick,
          },
        }),
      }
    )

    machine.update(16, { editorMode: true })

    expect(handleInteractKey).not.toHaveBeenCalled()
    expect(handleKeyboard).not.toHaveBeenCalled()
    expect(tick).toHaveBeenCalledWith(16)
  })

  it('clears queued events after dispose', () => {
    const dispatchEvent = vi.fn()
    const machine = new PlayerControlMachine({ dispatchEvent })

    machine.enqueueEvent(makeEvent('anim_pickup_grab'))
    machine.dispose()
    machine.update(16, { editorMode: false })

    expect(dispatchEvent).not.toHaveBeenCalled()
  })

  it('starts in the initial state and changes only via explicit transition', () => {
    const machine = new PlayerControlMachine(
      { dispatchEvent: vi.fn() },
      {
        states: createPlayerControlStateDefinitions({
          // A tick that does NOT call transition must leave the state unchanged.
          idle: { tick: () => undefined },
        }),
        initialState: { name: 'idle' },
      }
    )

    expect(machine.stateName).toBe('idle')
    machine.update(16, { editorMode: false })
    expect(machine.stateName).toBe('idle')

    machine.transition({ name: 'moving' } as ControlState)
    expect(machine.stateName).toBe('moving')
  })

  it('fires exit(old) then enter(new) on transition, and exits current on dispose', () => {
    const calls: string[] = []
    const machine = new PlayerControlMachine(
      { dispatchEvent: vi.fn() },
      {
        states: createPlayerControlStateDefinitions({
          idle: {
            enter: () => calls.push('enter:idle'),
            exit: () => calls.push('exit:idle'),
          },
          moving: {
            enter: () => calls.push('enter:moving'),
            exit: () => calls.push('exit:moving'),
          },
        }),
        initialState: { name: 'idle' },
      }
    )

    machine.transition({ name: 'moving' } as ControlState)
    machine.dispose()

    expect(calls).toEqual([
      'enter:idle',
      'exit:idle',
      'enter:moving',
      'exit:moving',
    ])
  })

  it('treats a transition to the current state as a no-op', () => {
    const calls: string[] = []
    const machine = new PlayerControlMachine(
      { dispatchEvent: vi.fn() },
      {
        states: createPlayerControlStateDefinitions({
          idle: {
            enter: () => calls.push('enter:idle'),
            exit: () => calls.push('exit:idle'),
          },
        }),
        initialState: { name: 'idle' },
      }
    )

    machine.transition({ name: 'idle' })

    expect(machine.stateName).toBe('idle')
    expect(calls).toEqual(['enter:idle'])
  })

  it('lets the current state consume events before the fallback dispatcher', () => {
    const dispatchEvent = vi.fn()
    const machine = new PlayerControlMachine(
      {
        dispatchEvent,
      },
      {
        states: createPlayerControlStateDefinitions({
          idle: {
            handleEvent: () => true,
          },
        }),
      }
    )

    machine.update(16, {
      editorMode: false,
      events: [makeEvent('anim_pickup_grab')],
    })

    expect(dispatchEvent).not.toHaveBeenCalled()
  })

  it('does not run global frame handlers for unhandled phases', () => {
    const dispatchEvent = vi.fn()
    const machine = new PlayerControlMachine(
      {
        dispatchEvent,
      },
      {
        states: createPlayerControlStateDefinitions({
          idle: {
            handleKeyboard: () => false,
            tick: () => undefined,
          },
        }),
      }
    )

    machine.update(16, { editorMode: false })

    expect(dispatchEvent).not.toHaveBeenCalled()
  })
})
