import KeyEventType from '../../const/KeyEventType';
import ModifierFlagsDictionary from '../../const/ModifierFlagsDictionary';

import KeyCombinationSerializer from '../shared/KeyCombinationSerializer';
import Configuration from '../config/Configuration';
import KeyHistory from '../listening/KeyHistory';
import KeyCombination from '../listening/KeyCombination';
import ComponentTree from '../definitions/ComponentTree';
import ComponentOptionsList from '../definitions/ComponentOptionsList';
import ActionResolver from '../matching/ActionResolver';

import describeKeyEventType from '../../helpers/logging/describeKeyEventType';
import printComponent from '../../helpers/logging/printComponent';
import stateFromEvent from '../../helpers/parsing-key-maps/stateFromEvent';
import KeyCombinationDecorator from '../listening/KeyCombinationDecorator';

/**
 * Defines common behaviour for key event strategies
 * @abstract
 * @class
 */
class AbstractKeyEventStrategy {
  /********************************************************************************
   * Init & Reset
   ********************************************************************************/

  /**
   * Creates a new instance of an event strategy (this class is an abstract one and
   * not intended to be instantiated directly).
   * @param {Object} options Options for how event strategy should behave
   * @param {string} options.logLevel The level of severity to log at
   * @param {KeyEventManager} keyEventManager KeyEventManager used for passing
   *        messages between key event strategies
   */
  constructor(options = {}, keyEventManager) {
    /**
     * @typedef {number} ComponentId Unique index associated with every HotKeys component
     * as it becomes active.
     *
     * For focus-only components, this happens when the component is focused. The HotKeys
     * component closest to the DOM element in focus gets the smallest number (0) and
     * those further up the render tree get larger (incrementing) numbers. When a different
     * element is focused (triggering the creation of a new focus tree) all component indexes
     * are reset (de-allocated) and re-assigned to the new tree of HotKeys components that
     * are now in focus.
     *
     * For global components, component indexes are assigned when a HotKeys component is
     * mounted, and de-allocated when it unmounts. The component index counter is never reset
     * back to 0 and just keeps incrementing as new components are mounted.
     */

    /**
     * Should be overridden by children to set a Logger instance
     */
    this.logger = null;

    /**
     * Counter to maintain what the next component index should be
     * @type {ComponentId}
     */
    this.componentId = -1;

    /**
     * Reference to key event manager, so that information may pass between the
     * global strategy and the focus-only strategy
     * @type {KeyEventManager}
     */
    this.keyEventManager = keyEventManager;

    this._componentTree = new ComponentTree();

    this._reset();

    this.resetKeyHistory();
  }

  /**
   * Resets all strategy state to the values it had when it was first created
   * @protected
   */
  _reset() {
    this._componentList = new ComponentOptionsList();

    this._actionResolver = null;
  }

  _recalculate() {
    this._actionResolver = null;

    this._updateLongestSequence();
  }

  getKeyHistory() {
    if (!this._keyHistory) {
      this._keyHistory = this._newKeyHistory();
    }

    return this._keyHistory;
  }

  /**
   * Reset the state values that record the current and recent state of key events
   * @param {Object} options An options hash
   * @param {boolean} options.force Whether to force a hard reset of the key
   *        combination history.
   */
  resetKeyHistory(options = {}) {
    if (this._simulator) {
      this._simulator.clear();
    }

    if (this.getKeyHistory().any() && !options.force) {
      this._keyHistory = new KeyHistory(
        { maxLength: this._componentList.getLongestSequence() },
        new KeyCombination(this.getCurrentCombination().keysStillPressedDict())
      );
    } else {
      this._keyHistory = this._newKeyHistory();
    }
  }

  _newKeyHistory() {
    return new KeyHistory({
      maxLength: this._componentList.getLongestSequence()
    });
  }

  getComponentTree() {
    return this._componentTree;
  }

  /********************************************************************************
   * Registering key maps
   ********************************************************************************/

  /**
   * Registers a new mounted component's key map so that it can be included in the
   * application's key map
   * @param {KeyMap} keyMap - Map of actions to key expressions
   * @returns {ComponentId} Unique component ID to assign to the focused HotKeys
   *          component and passed back when handling a key event
   */
  registerKeyMap(keyMap) {
    this.componentId += 1;

    this._componentTree.add(this.componentId, keyMap);

    this.logger.verbose(
      this.logger.keyEventPrefix(this.componentId),
      'Registered component:\n',
      `${printComponent(this._componentTree.get(this.componentId))}`
    );

    return this.componentId;
  }

  /**
   * Re-registers (updates) a mounted component's key map
   * @param {ComponentId} componentId - Id of the component that the keyMap belongs to
   * @param {KeyMap} keyMap - Map of actions to key expressions
   */
  reregisterKeyMap(componentId, keyMap) {
    this._componentTree.update(componentId, keyMap);
  }

  /**
   * Registers that a component has now mounted, and declares its parent hot keys
   * component id so that actions may be properly resolved
   * @param {ComponentId} componentId - Id of the component that has mounted
   * @param {ComponentId} parentId - Id of the parent hot keys component
   */
  registerComponentMount(componentId, parentId) {
    this._componentTree.setParent(componentId, parentId);

    this.logger.verbose(
      this.logger.keyEventPrefix(componentId),
      'Registered component mount:\n',
      `${printComponent(this._componentTree.get(componentId))}`
    );
  }

  /**
   * De-registers (removes) a mounted component's key map from the registry
   * @param {ComponentId} componentId - Id of the component that the keyMap
   *        belongs to
   */
  deregisterKeyMap(componentId) {
    this._componentTree.remove(componentId);

    this.logger.verbose(
      this.logger.keyEventPrefix(componentId),
      'De-registered component. Remaining component Registry:\n',
      `${printComponent(this._componentTree.toJSON())}`
    );

    if (this._componentTree.isRootId(componentId)) {
      this._componentTree.clearRootId();
    }
  }

  /********************************************************************************
   * Registering key maps and handlers
   ********************************************************************************/

  /**
   * Registers the hotkeys defined by a HotKeys component
   * @param {ComponentId} componentId - Index of the component
   * @param {KeyMap} actionNameToKeyMap - Definition of actions and key maps defined
   *        in the HotKeys component
   * @param {HandlersMap} actionNameToHandlersMap - Map of ActionNames to handlers
   *        defined in the HotKeys component
   * @param {string} action - Description of the action that triggers the new component
   *        registering a new key map.
   * @param {Object} options - Hash of options that configure how the key map is built.
   * @protected
   */
  _addComponent(componentId, actionNameToKeyMap = {}, actionNameToHandlersMap = {}, action, options) {
    this._componentList.add(componentId,
      actionNameToKeyMap, actionNameToHandlersMap, options
    );

    this._recalculate();

    this.logger.debug(this.logger.nonKeyEventPrefix(componentId), action);
    this.logger.logComponentOptions(componentId);
  }

  _updateComponent(componentId, actionNameToKeyMap, actionNameToHandlersMap, options) {
    this._componentList.update(
      componentId, actionNameToKeyMap, actionNameToHandlersMap, options
    );

    this._recalculate();

    this.logger.logComponentOptions(componentId);
  }

  /********************************************************************************
   * Recording key events
   ********************************************************************************/

  getCurrentCombination() {
    return this.getKeyHistory().getCurrentCombination();
  }

  getComponent(componentId) {
    return this._componentList.get(componentId);
  }

  _describeCurrentCombination() {
    const keyCombinationDecorator = new KeyCombinationDecorator(this.getCurrentCombination());

    return keyCombinationDecorator.describe();
  }

  _updateLongestSequence() {
    this.getKeyHistory().setMaxLength(this._componentList.getLongestSequence());
  }

  _recordKeyDown(event, key) {
    const keyEventState = stateFromEvent(event);

    const currentCombination = this.getCurrentCombination();

    if (currentCombination.isKeyIncluded(key) || currentCombination.isEnding()) {
      this._startAndLogNewKeyCombination(key, keyEventState);
    } else {
      this._addToAndLogCurrentKeyCombination(key, KeyEventType.keydown, keyEventState);
    }
  }

  _startAndLogNewKeyCombination(keyName, keyEventState) {
    this.getKeyHistory().startNewKeyCombination(keyName, keyEventState);

    this.logger.verbose(
      this.logger.keyEventPrefix(),
      `Started a new combination with '${keyName}'.`
    );

    this.logger.logKeyHistory();
  }

  _addToAndLogCurrentKeyCombination(keyName, keyEventType, keyEventState) {
    this.getKeyHistory().addKeyToCurrentCombination(keyName, keyEventType, keyEventState);

    if (keyEventType === KeyEventType.keydown) {
      this.logger.verbose(
        this.logger.keyEventPrefix(),
        `Added '${keyName}' to current combination: '${this._describeCurrentCombination()}'.`
      );
    }

    this.logger.logKeyHistory();
  }

  /********************************************************************************
   * Matching and calling handlers
   ********************************************************************************/

  _callClosestMatchingHandler(event, keyName, keyEventType, componentPosition, componentSearchIndex) {
    if (!this._actionResolver) {
      this._actionResolver = new ActionResolver(this._componentList);
    }

    while (componentSearchIndex <= componentPosition) {
      const keyHistoryMatcher =
        this._actionResolver.getKeyHistoryMatcher(componentSearchIndex);

      this.logger.verbose(
        this.logger.keyEventPrefix(componentSearchIndex),
        'Internal key mapping:\n',
        `${printComponent(keyHistoryMatcher.toJSON())}`
      );

      const sequenceMatch =
        this._actionResolver.findMatchingKeySequenceInComponent(
          componentSearchIndex, this.getKeyHistory(), keyName, keyEventType
        );

      if (sequenceMatch) {
        const eventSchema = sequenceMatch.events[keyEventType];

        if (Configuration.option('allowCombinationSubmatches')) {
          const subMatchDescription = KeyCombinationSerializer.serialize(sequenceMatch.keyDictionary);

          this.logger.debug(
            this.logger.keyEventPrefix(componentSearchIndex),
            `Found action that matches '${this._describeCurrentCombination()}' (sub-match: '${subMatchDescription}'): ${eventSchema.actionName}. Calling handler . . .`
          );
        } else {
          this.logger.debug(
            this.logger.keyEventPrefix(componentSearchIndex),
            `Found action that matches '${this._describeCurrentCombination()}': ${eventSchema.actionName}. Calling handler . . .`
          );
        }

        eventSchema.handler(event);

        this._stopEventPropagationAfterHandlingIfEnabled(event, componentSearchIndex);

        return true;
      } else {
        if (this._actionResolver.componentHasActionsBoundToEventType(componentSearchIndex, keyEventType)) {
          const eventName = describeKeyEventType(keyEventType);

          this.logger.debug(
            this.logger.keyEventPrefix(componentSearchIndex),
            `No matching actions found for '${this._describeCurrentCombination()}' ${eventName}.`
          );
        } else {
          this.logger.debug(
            this.logger.keyEventPrefix(componentSearchIndex),
            `Doesn't define a handler for '${this._describeCurrentCombination()}' ${describeKeyEventType(keyEventType)}.`
          );
        }
      }

      componentSearchIndex++;
    }
  }

  _stopEventPropagationAfterHandlingIfEnabled(event, componentId) {
    if (Configuration.option('stopEventPropagationAfterHandling')) {
      this._stopEventPropagation(event, componentId);

      return true;
    }

    return false;
  }

  _stopEventPropagation(event, componentId) {
    throw new Error('_stopEventPropagation must be overridden by a subclass');
  }

  /**
   * Synchronises the key combination history to match the modifier key flag attributes
   * on new key events
   * @param {KeyboardEvent} event - Event to check the modifier flags for
   * @param {string} key - Name of key that events relates to
   * @param {KeyEventType} keyEventType - The record index of the current
   *        key event type
   * @protected
   */
  _checkForModifierFlagDiscrepancies(event, key, keyEventType) {
    /**
     * If a new key event is received with modifier key flags that contradict the
     * key combination history we are maintaining, we can surmise that some keyup events
     * for those modifier keys have been lost (possibly because the window lost focus).
     * We update the key combination to match the modifier flags
     */
    Object.keys(ModifierFlagsDictionary).forEach((modifierKey) => {
      /**
       * When a modifier key is being released (keyup), it sets its own modifier flag
       * to false. (e.g. On the keyup event for Command, the metaKey attribute is false).
       * If this the case, we want to handle it using the main algorithm and skip the
       * reconciliation algorithm.
       */
      if (key === modifierKey && keyEventType === KeyEventType.keyup) {
        return;
      }

      const currentCombination = this.getCurrentCombination();
      const modifierStillPressed = currentCombination.isKeyStillPressed(modifierKey);

       ModifierFlagsDictionary[modifierKey].forEach((attributeName) => {
         if (event[attributeName] === false && modifierStillPressed) {

           currentCombination.setKeyState(
             modifierKey,
             KeyEventType.keyup,
             stateFromEvent(event)
           );
         }
       });
     })
  }

  _isIgnoringRepeatedEvent(event, key, eventType) {
    if (event.repeat && Configuration.option('ignoreRepeatedEventsWhenKeyHeldDown')) {
      this.logger.logIgnoredKeyEvent(event, key, eventType, 'it was a repeated event');

      return true;
    }

    return false;
  }
}

export default AbstractKeyEventStrategy;
