import type { PlayerControlEvent, PlayerControlUpdateOptions } from './events'
import type { ControlState } from './control-state'
import type { PlayerControlStateDefinitions } from './state-definitions'

export interface PlayerControlMachineHandlers {
  dispatchEvent: (event: PlayerControlEvent) => void
}

export interface PlayerControlMachineOptions {
  states?: PlayerControlStateDefinitions
  initialState?: ControlState
}

export class PlayerControlMachine {
  private queuedEvents: PlayerControlEvent[] = []
  private disposed = false
  private currentState: ControlState

  constructor(
    private readonly handlers: PlayerControlMachineHandlers,
    private readonly options: PlayerControlMachineOptions = {}
  ) {
    this.currentState = options.initialState ?? { name: 'idle' }
    this.enterState(this.currentState.name)
  }

  get stateName() {
    return this.currentState.name
  }

  /**
   * The machine's owned current state object, including any data the active
   * state holds (e.g. `moving` carries its target/movementState/waypoints).
   * Callers narrow on `.name` to read/mutate that data in place.
   */
  get state(): ControlState {
    return this.currentState
  }

  /**
   * Explicit state transition. The machine OWNS its current state: it changes
   * only through this method, never by polling/deriving a name from external
   * flags. Callers transition at the actual decision points (move start,
   * arrival, attack, interact enter/exit, dead/respawn, jump). A transition to
   * a different state object with the same name still swaps the object (to
   * carry new data) but does not re-fire exit/enter.
   */
  transition(next: ControlState) {
    if (this.disposed) return
    if (next.name === this.currentState.name) {
      this.currentState = next
      return
    }
    this.exitState(this.currentState.name)
    this.currentState = next
    this.enterState(next.name)
  }

  enqueueEvent(event: PlayerControlEvent) {
    if (this.disposed) return
    this.queuedEvents.push(event)
  }

  update(deltaTime: number, options: PlayerControlUpdateOptions) {
    if (this.disposed) return

    const events = this.queuedEvents
    this.queuedEvents = []

    for (const event of events) {
      this.dispatchEvent(event)
    }
    if (options.events) {
      for (const event of options.events) {
        this.dispatchEvent(event)
      }
    }

    if (!options.editorMode) {
      this.handleInteractKey()
      this.handleKeyboard()
    }

    this.tick(deltaTime)
  }

  dispose() {
    if (this.disposed) return
    this.exitState(this.currentState.name)
    this.disposed = true
    this.queuedEvents = []
  }

  private enterState(stateName: ControlState['name']) {
    this.options.states?.[stateName]?.enter?.()
  }

  private exitState(stateName: ControlState['name']) {
    this.options.states?.[stateName]?.exit?.()
  }

  private get currentDefinition() {
    return this.options.states?.[this.currentState.name]
  }

  private dispatchEvent(event: PlayerControlEvent) {
    const consumed = this.currentDefinition?.handleEvent?.(event) === true
    if (!consumed) {
      this.handlers.dispatchEvent(event)
    }
  }

  private handleInteractKey() {
    this.currentDefinition?.handleInteractKey?.()
  }

  private handleKeyboard() {
    this.currentDefinition?.handleKeyboard?.()
  }

  private tick(deltaTime: number) {
    this.currentDefinition?.tick?.(deltaTime)
  }
}
