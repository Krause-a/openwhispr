const debugLogger = require("./debugLogger");

const DBUS_SERVICE_NAME = "com.openwhispr.App";
const DBUS_OBJECT_PATH = "/com/openwhispr/App";
const DBUS_INTERFACE = "com.openwhispr.App";

let dbus = null;

function getDBus() {
  if (dbus) return dbus;
  try {
    dbus = require("dbus-next");
    return dbus;
  } catch (err) {
    debugLogger.log("[WaylandShortcut] Failed to load dbus-next:", err.message);
    return null;
  }
}

/**
 * Generic Wayland D-Bus shortcut manager.
 *
 * Unlike GNOME, KDE, or Hyprland managers, this does NOT attempt to automatically
 * bind keys via compositor-specific tools. Instead, it:
 *
 * 1. Initializes the D-Bus service so users CAN manually bind keys to call it
 * 2. Falls back to regular globalShortcut for hotkeys (may work via XWayland)
 * 3. Logs instructions for manual configuration
 *
 * This enables OpenWhispr to work on ANY Wayland compositor (sway, river,
 * wayfire, etc.) by providing the D-Bus service for manual keybinding setup.
 */
class WaylandShortcutManager {
  constructor() {
    this.bus = null;
    this.dictationCallback = null;
    this.agentCallback = null;
  }

  /**
   * Check if running on any Wayland session.
   * Unlike isGnome()/isKDE()/isHyprland(), this is generic.
   */
  static isWayland() {
    return process.env.XDG_SESSION_TYPE === "wayland";
  }

  /**
   * Initialize a D-Bus service to receive Toggle() and ToggleAgent() calls.
   * This is the same service as GNOME/Hyprland use, enabling users to manually
   * configure their compositor to call it.
   *
   * Users can bind keys in their compositor config to:
   *   dbus-send --session --type=method_call --dest=com.openwhispr.App /com/openwhispr/App com.openwhispr.App.Toggle
   */
  async initDBusService(dictationCallback) {
    this.dictationCallback = dictationCallback;

    const dbusModule = getDBus();
    if (!dbusModule) {
      debugLogger.log("[WaylandShortcut] D-Bus module not available, skipping generic Wayland D-Bus init");
      return false;
    }

    try {
      this.bus = dbusModule.sessionBus();
      await this.bus.requestName(DBUS_SERVICE_NAME, 0);

      const InterfaceClass = this._createInterfaceClass(dbusModule);
      const iface = new InterfaceClass(dictationCallback, this.agentCallback);
      this._ifaceRef = iface;
      this.bus.export(DBUS_OBJECT_PATH, iface);

      debugLogger.log("[WaylandShortcut] D-Bus service initialized for generic Wayland");
      debugLogger.log("[WaylandShortcut] Manual configuration required - add to your compositor config:");
      debugLogger.log(`[WaylandShortcut]   bind = Control, Super_L, exec, dbus-send --session --type=method_call --dest=${DBUS_SERVICE_NAME} ${DBUS_OBJECT_PATH} ${DBUS_INTERFACE}.Toggle`);

      return true;
    } catch (err) {
      debugLogger.log("[WaylandShortcut] Failed to initialize D-Bus service:", err.message);
      if (this.bus) {
        this.bus.disconnect();
        this.bus = null;
      }
      return false;
    }
  }

  _createInterfaceClass(dbusModule) {
    class OpenWhisprInterface extends dbusModule.interface.Interface {
      constructor(dictationCallback, agentCallback) {
        super(DBUS_INTERFACE);
        this._dictationCallback = dictationCallback;
        this._agentCallback = agentCallback || null;
      }

      Toggle() {
        if (this._dictationCallback) {
          this._dictationCallback();
        }
      }

      ToggleAgent() {
        if (this._agentCallback) {
          this._agentCallback();
        }
      }
    }

    OpenWhisprInterface.configureMembers({
      methods: {
        Toggle: { inSignature: "", outSignature: "" },
        ToggleAgent: { inSignature: "", outSignature: "" },
      },
    });

    return OpenWhisprInterface;
  }

  /**
   * Set or update the agent callback after initial D-Bus service initialization.
   */
  setAgentCallback(callback) {
    this.agentCallback = callback;
    if (this._ifaceRef) {
      this._ifaceRef._agentCallback = callback;
    }
    debugLogger.log("[WaylandShortcut] Agent callback registered");
  }

  /**
   * Get instructions for manually configuring the compositor.
   */
  getManualConfigurationInstructions() {
    return {
      dbusCommand: `dbus-send --session --type=method_call --dest=${DBUS_SERVICE_NAME} ${DBUS_OBJECT_PATH} ${DBUS_INTERFACE}.Toggle`,
      dbusAgentCommand: `dbus-send --session --type=method_call --dest=${DBUS_SERVICE_NAME} ${DBUS_OBJECT_PATH} ${DBUS_INTERFACE}.ToggleAgent`,
      examples: {
        sway: `bindsym Ctrl+Super exec dbus-send --session --type=method_call --dest=${DBUS_SERVICE_NAME} ${DBUS_OBJECT_PATH} ${DBUS_INTERFACE}.Toggle`,
        river: `riverctl map normal Control Super spawn 'dbus-send --session --type=method_call --dest=${DBUS_SERVICE_NAME} ${DBUS_OBJECT_PATH} ${DBUS_INTERFACE}.Toggle'`,
        wayfire: `[command]\nbinding_openwhispr = <ctrl> <super>\ncommand_openwhispr = dbus-send --session --type=method_call --dest=${DBUS_SERVICE_NAME} ${DBUS_OBJECT_PATH} ${DBUS_INTERFACE}.Toggle`,
      },
    };
  }

  /**
   * Generic Wayland manager doesn't auto-register keybindings.
   * This always returns false - users must manually configure their compositor.
   */
  async registerKeybinding(hotkey, slotName = "dictation") {
    debugLogger.log(`[WaylandShortcut] Auto-registration not available for generic Wayland`);
    debugLogger.log(`[WaylandShortcut] To use "${hotkey}" for ${slotName}, manually add to your compositor config:`);

    const instructions = this.getManualConfigurationInstructions();
    debugLogger.log(`[WaylandShortcut]   ${instructions.dbusCommand}`);

    return false;
  }

  /**
   * Generic Wayland manager doesn't auto-unregister keybindings.
   */
  async unregisterKeybinding(slotName = "dictation") {
    debugLogger.log(`[WaylandShortcut] Auto-unregistration not available for generic Wayland (slot: ${slotName})`);
    debugLogger.log(`[WaylandShortcut] Please manually remove the keybinding from your compositor config`);
    return true;
  }

  /**
   * Clean up D-Bus connection.
   */
  close() {
    if (this.bus) {
      try {
        this.bus.disconnect();
      } catch (err) {
        debugLogger.log("[WaylandShortcut] Error disconnecting D-Bus:", err.message);
      }
      this.bus = null;
    }
    this._ifaceRef = null;
  }
}

module.exports = WaylandShortcutManager;
