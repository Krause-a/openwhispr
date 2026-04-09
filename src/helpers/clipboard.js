const { clipboard, systemPreferences } = require("electron");
const { spawn, spawnSync } = require("child_process");
const { killProcess } = require("../utils/process");
const path = require("path");
const fs = require("fs");
const os = require("os");
const debugLogger = require("./debugLogger");

const CACHE_TTL_MS = 30000;

// isTrustedAccessibilityClient() is a cheap synchronous syscall, so the cache
// only exists to debounce the dialog shown on denial.
const ACCESSIBILITY_CHECK_TTL_MS = 5000;

const getLinuxDesktopEnv = () =>
  [process.env.XDG_CURRENT_DESKTOP, process.env.XDG_SESSION_DESKTOP, process.env.DESKTOP_SESSION]
    .filter(Boolean)
    .join(":")
    .toLowerCase();

const isGnomeDesktop = (desktopEnv) => desktopEnv.includes("gnome");

const isKdeDesktop = (desktopEnv) => desktopEnv.includes("kde");

const isWlrootsCompositor = (desktopEnv) => {
  const wlrootsDesktops = ["sway", "hyprland", "wayfire", "river", "dwl", "labwc", "cage"];
  return (
    wlrootsDesktops.some((wm) => desktopEnv.includes(wm)) ||
    !!process.env.SWAYSOCK ||
    !!process.env.HYPRLAND_INSTANCE_SIGNATURE
  );
};

const getLinuxSessionInfo = () => {
  const isWayland =
    (process.env.XDG_SESSION_TYPE || "").toLowerCase() === "wayland" ||
    !!process.env.WAYLAND_DISPLAY;
  const xwaylandAvailable = isWayland && !!process.env.DISPLAY;
  const desktopEnv = getLinuxDesktopEnv();
  const isGnome = isWayland && isGnomeDesktop(desktopEnv);
  const isKde = isWayland && isKdeDesktop(desktopEnv);
  const isWlroots = isWayland && isWlrootsCompositor(desktopEnv);

  return { isWayland, xwaylandAvailable, desktopEnv, isGnome, isKde, isWlroots };
};

const PASTE_DELAYS = {
  darwin: 120,
  win32_fast: 10,
  win32_nircmd: 30,
  win32_pwsh: 40,
  linux: 50,
};

const RESTORE_DELAYS = {
  darwin: 450,
  win32_nircmd: 80,
  win32_pwsh: 80,
  linux: 200,
  linux_kde_wayland: 600,
};

function writeClipboardInRenderer(webContents, text) {
  if (!webContents || !webContents.executeJavaScript) {
    return Promise.reject(new Error("Invalid webContents for clipboard write"));
  }
  const escaped = JSON.stringify(text);
  return webContents.executeJavaScript(`navigator.clipboard.writeText(${escaped})`);
}

class ClipboardManager {
  constructor() {
    this.accessibilityCache = { value: null, expiresAt: 0 };
    this.commandAvailabilityCache = new Map();
    this.nircmdPath = null;
    this.nircmdChecked = false;
    this.fastPastePath = null;
    this.fastPasteChecked = false;
    this.winFastPastePath = null;
    this.winFastPasteChecked = false;
    this.wtypeScriptPath = null;
    this.wtypeScriptChecked = false;
    this.portalDenied = false;
    this._kwinScriptPath = null;

    process.on("exit", () => {
      if (this._kwinScriptPath) {
        try {
          fs.unlinkSync(this._kwinScriptPath);
        } catch {}
      }
    });
  }

  _isWayland() {
    if (process.platform !== "linux") return false;
    const { isWayland } = getLinuxSessionInfo();
    return isWayland;
  }

  _writeClipboardWayland(text, webContents) {
    const { isKde } = getLinuxSessionInfo();

    // On KDE with XWayland, write to X11 clipboard directly because
    // wl-copy targets the Wayland clipboard which is desynced from X11
    if (isKde) {
      if (this.commandExists("xclip")) {
        try {
          const result = spawnSync("xclip", ["-selection", "clipboard"], {
            input: text,
            timeout: 200,
          });
          if (result.status === 0) {
            clipboard.writeText(text);
            return;
          }
        } catch {}
      }
      if (this.commandExists("xsel")) {
        try {
          const result = spawnSync("xsel", ["--clipboard", "--input"], {
            input: text,
            timeout: 200,
          });
          if (result.status === 0) {
            clipboard.writeText(text);
            return;
          }
        } catch {}
      }
      // Last resort: Electron's clipboard.writeText should work on XWayland
      clipboard.writeText(text);
      return;
    }

    if (this.commandExists("wl-copy")) {
      try {
        const result = spawnSync("wl-copy", ["--", text], { timeout: 50 });
        if (result.status === 0) {
          clipboard.writeText(text);
          return;
        }
      } catch {}
    }

    if (webContents && !webContents.isDestroyed()) {
      writeClipboardInRenderer(webContents, text).catch(() => {});
    }

    clipboard.writeText(text);
  }

  getNircmdPath() {
    if (this.nircmdChecked) {
      return this.nircmdPath;
    }

    this.nircmdChecked = true;

    if (process.platform !== "win32") {
      return null;
    }

    const possiblePaths = [
      ...(process.resourcesPath ? [path.join(process.resourcesPath, "bin", "nircmd.exe")] : []),
      path.join(__dirname, "..", "..", "resources", "bin", "nircmd.exe"),
      path.join(process.cwd(), "resources", "bin", "nircmd.exe"),
    ];

    for (const nircmdPath of possiblePaths) {
      try {
        if (fs.existsSync(nircmdPath)) {
          this.safeLog(`✅ Found nircmd.exe at: ${nircmdPath}`);
          this.nircmdPath = nircmdPath;
          return nircmdPath;
        }
      } catch (error) {}
    }

    this.safeLog("⚠️ nircmd.exe not found, will use PowerShell fallback");
    return null;
  }

  getNircmdStatus() {
    if (process.platform !== "win32") {
      return { available: false, reason: "Not Windows" };
    }
    const nircmdPath = this.getNircmdPath();
    return {
      available: !!nircmdPath,
      path: nircmdPath,
    };
  }

  _resolveNativeBinary(binaryName, platform, cacheKeyChecked, cacheKeyPath) {
    if (this[cacheKeyChecked]) {
      return this[cacheKeyPath];
    }
    this[cacheKeyChecked] = true;

    if (process.platform !== platform) {
      return null;
    }

    const candidates = new Set([
      path.join(__dirname, "..", "..", "resources", "bin", binaryName),
      path.join(__dirname, "..", "..", "resources", binaryName),
    ]);

    if (process.resourcesPath) {
      [
        path.join(process.resourcesPath, binaryName),
        path.join(process.resourcesPath, "bin", binaryName),
        path.join(process.resourcesPath, "resources", binaryName),
        path.join(process.resourcesPath, "resources", "bin", binaryName),
        path.join(process.resourcesPath, "app.asar.unpacked", "resources", binaryName),
        path.join(process.resourcesPath, "app.asar.unpacked", "resources", "bin", binaryName),
      ].forEach((candidate) => candidates.add(candidate));
    }

    for (const candidate of candidates) {
      try {
        const stats = fs.statSync(candidate);
        if (stats.isFile()) {
          try {
            fs.accessSync(candidate, fs.constants.X_OK);
          } catch {
            fs.chmodSync(candidate, 0o755);
          }
          this[cacheKeyPath] = candidate;
          return candidate;
        }
      } catch {
        continue;
      }
    }

    return null;
  }

  resolveFastPasteBinary() {
    return this._resolveNativeBinary(
      "macos-fast-paste",
      "darwin",
      "fastPasteChecked",
      "fastPastePath"
    );
  }

  resolveWindowsFastPasteBinary() {
    return this._resolveNativeBinary(
      "windows-fast-paste.exe",
      "win32",
      "winFastPasteChecked",
      "winFastPastePath"
    );
  }

  resolveWtypeScript() {
    if (this.wtypeScriptChecked) {
      return this.wtypeScriptPath;
    }
    this.wtypeScriptChecked = true;

    if (process.platform !== "linux") {
      return null;
    }

    // Look for compiled binary (not shell script)
    const candidates = new Set([
      path.join(__dirname, "..", "..", "resources", "bin", "linux-fast-paste-wtype"),
      path.join(__dirname, "..", "..", "..", "resources", "bin", "linux-fast-paste-wtype"),
    ]);

    // VERBOSE DEBUG: Log base path information
    debugLogger.debug("=== WTYPESCRIPT RESOLUTION DEBUG ===", {
      __dirname,
      processResourcesPath: process.resourcesPath,
      processPlatform: process.platform,
      processExecPath: process.execPath,
    }, "clipboard");

    if (process.resourcesPath) {
      const resourceCandidates = [
        path.join(process.resourcesPath, "bin", "linux-fast-paste-wtype"),
        path.join(process.resourcesPath, "resources", "bin", "linux-fast-paste-wtype"),
        path.join(process.resourcesPath, "app.asar.unpacked", "resources", "bin", "linux-fast-paste-wtype"),
        // Also check for old shell script name (backward compat)
        path.join(process.resourcesPath, "bin", "linux-fast-paste-wtype.sh"),
        path.join(process.resourcesPath, "resources", "bin", "linux-fast-paste-wtype.sh"),
        path.join(process.resourcesPath, "app.asar.unpacked", "resources", "bin", "linux-fast-paste-wtype.sh"),
      ];
      debugLogger.debug("Resource path candidates", {
        resourcePath: process.resourcesPath,
        candidates: resourceCandidates,
      }, "clipboard");
      resourceCandidates.forEach((candidate) => candidates.add(candidate));
    }

    const candidateArray = Array.from(candidates);
    debugLogger.debug("Checking wtype script candidates", { candidates: candidateArray }, "clipboard");

    for (const candidate of candidates) {
      try {
        const stats = fs.statSync(candidate);
        const isFile = stats.isFile();
        const isDirectory = stats.isDirectory();
        const mode = stats.mode;
        
        debugLogger.debug("Stat result", {
          path: candidate,
          exists: true,
          isFile,
          isDirectory,
          mode: mode.toString(8),
        }, "clipboard");

        if (isFile) {
          try {
            fs.accessSync(candidate, fs.constants.X_OK);
            debugLogger.debug("File is executable", { path: candidate }, "clipboard");
          } catch (accessErr) {
            debugLogger.debug("File not executable, attempting chmod", { path: candidate, error: accessErr.message }, "clipboard");
            try {
              fs.chmodSync(candidate, 0o755);
              debugLogger.debug("Chmod succeeded", { path: candidate }, "clipboard");
            } catch (chmodErr) {
              debugLogger.debug("Chmod failed", { path: candidate, error: chmodErr.message }, "clipboard");
            }
          }
          this.wtypeScriptPath = candidate;
          debugLogger.debug("Found wtype script", { path: candidate }, "clipboard");
          return candidate;
        } else {
          debugLogger.debug("Path exists but is not a file", { path: candidate, isDirectory }, "clipboard");
        }
      } catch (e) {
        debugLogger.debug("Wtype script candidate stat failed", { 
          path: candidate, 
          error: e.message,
          errorCode: e.code,
          errorType: e.constructor.name,
        }, "clipboard");
        continue;
      }
    }

    debugLogger.error("wtype script not found in any location", { 
      checked: candidateArray,
      __dirname,
      processResourcesPath: process.resourcesPath,
    }, "clipboard");
    return null;
  }

  spawnWtypeScript(text, label) {
    return new Promise((resolve, reject) => {
      const wtypeBinary = this.resolveWtypeScript();
      if (!wtypeBinary) {
        reject(new Error("wtype binary not found"));
        return;
      }

      debugLogger.debug(
        `=== SPAWNING WTYPE BINARY === (${label})`,
        { 
          wtypeBinary, 
          textLength: text?.length,
          spawnArgs: [wtypeBinary, text],
          fullText: text,
        },
        "clipboard"
      );

      const proc = spawn(wtypeBinary, [text]);
      let stderr = "";
      let stdout = "";

      proc.stdout?.on("data", (data) => {
        stdout += data.toString();
      });

      proc.stderr?.on("data", (data) => {
        stderr += data.toString();
        debugLogger.debug("wtype binary stderr", { data: data.toString() }, "clipboard");
      });

      let timedOut = false;
      const timeoutId = setTimeout(() => {
        timedOut = true;
        debugLogger.debug("wtype binary timeout reached, killing process", { wtypeBinary }, "clipboard");
        killProcess(proc, "SIGKILL");
      }, 5000);

      proc.on("close", (code) => {
        debugLogger.debug("wtype binary process closed", { 
          code, 
          timedOut, 
          stdout,
          stderr,
        }, "clipboard");
        if (timedOut) return reject(new Error("wtype binary timed out"));
        clearTimeout(timeoutId);
        if (code === 0) {
          debugLogger.debug("wtype binary succeeded", { wtypeBinary }, "clipboard");
          resolve();
        } else {
          reject(
            new Error(
              `wtype binary exited with code ${code}${stderr ? `: ${stderr.trim()}` : ""}`
            )
          );
        }
      });

      proc.on("error", (error) => {
        if (timedOut) return;
        clearTimeout(timeoutId);
        debugLogger.error("wtype binary process error", { error: error.message, code: error.code }, "clipboard");
        reject(error);
      });
    });
  }

  resolveWtypePasteScript() {
    if (this.wtypePasteChecked) {
      return this.wtypePastePath;
    }
    this.wtypePasteChecked = true;

    if (process.platform !== "linux") {
      return null;
    }

    const candidates = new Set([
      path.join(__dirname, "..", "..", "resources", "linux-wtype-paste.sh"),
      path.join(__dirname, "..", "..", "..", "resources", "linux-wtype-paste.sh"),
    ]);

    if (process.resourcesPath) {
      [
        path.join(process.resourcesPath, "linux-wtype-paste.sh"),
        path.join(process.resourcesPath, "resources", "linux-wtype-paste.sh"),
        path.join(process.resourcesPath, "app.asar.unpacked", "resources", "linux-wtype-paste.sh"),
      ].forEach((candidate) => candidates.add(candidate));
    }

    for (const candidate of candidates) {
      try {
        const stats = fs.statSync(candidate);
        if (stats.isFile()) {
          try {
            fs.accessSync(candidate, fs.constants.X_OK);
          } catch {
            fs.chmodSync(candidate, 0o755);
          }
          this.wtypePastePath = candidate;
          debugLogger.debug("Found wtype-paste script", { path: candidate }, "clipboard");
          return candidate;
        }
      } catch {
        continue;
      }
    }

    debugLogger.debug("wtype-paste script not found", {}, "clipboard");
    return null;
  }

  _isYdotoolDaemonRunning() {
    const uid = process.getuid?.();
    const socketPaths = [
      process.env.YDOTOOL_SOCKET,
      uid != null ? `/run/user/${uid}/.ydotool_socket` : null,
      "/tmp/.ydotool_socket",
    ].filter(Boolean);

    for (const socketPath of socketPaths) {
      try {
        if (fs.statSync(socketPath)) return true;
      } catch {}
    }

    try {
      return spawnSync("pidof", ["ydotoold"], { timeout: 1000 }).status === 0;
    } catch {
      return false;
    }
  }

  _isYdotoolLegacy() {
    if (this._ydotoolLegacyChecked !== undefined) return this._ydotoolLegacyChecked;
    try {
      const result = spawnSync("ydotool", ["help"], { stdio: "pipe", timeout: 2000 });
      const output = (result.stdout?.toString() || "") + (result.stderr?.toString() || "");
      // ydotool 1.0.x has 'bakers' subcommand that 0.1.x doesn't
      this._ydotoolLegacyChecked = !output.includes("bakers");
    } catch {
      this._ydotoolLegacyChecked = false;
    }
    debugLogger.debug(
      "ydotool version detection",
      { legacy: this._ydotoolLegacyChecked },
      "clipboard"
    );
    return this._ydotoolLegacyChecked;
  }

  _canAccessUinput() {
    if (process.platform !== "linux") return false;
    const now = Date.now();
    if (this._uinputCache && now < this._uinputCache.expiresAt) {
      return this._uinputCache.accessible;
    }
    let accessible = false;
    try {
      fs.accessSync("/dev/uinput", fs.constants.W_OK);
      accessible = true;
    } catch {}
    this._uinputCache = { accessible, expiresAt: now + 30000 };
    return accessible;
  }

  _getPortalTokenPath() {
    const cacheDir = path.join(
      process.env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache"),
      "openwhispr"
    );
    return path.join(cacheDir, "portal-paste-token");
  }

  _readPortalToken() {
    try {
      return fs.readFileSync(this._getPortalTokenPath(), "utf8").trim() || null;
    } catch {
      return null;
    }
  }

  _savePortalToken(token) {
    try {
      const tokenPath = this._getPortalTokenPath();
      const dir = path.dirname(tokenPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(tokenPath, token);
    } catch (err) {
      debugLogger.warn("Failed to save portal-paste token", { error: err.message }, "clipboard");
    }
  }

  _runPortalPaste(fastPasteBinary, text) {
    return new Promise((resolve, reject) => {
      const args = text ? [text] : [];

      debugLogger.debug(
        "Attempting linux-fast-paste wtype direct text",
        { binary: fastPasteBinary, textLength: text?.length },
        "clipboard"
      );

      const proc = spawn(fastPasteBinary, args);
      let stdout = "";
      let stderr = "";

      proc.stdout?.on("data", (data) => {
        stdout += data.toString();
      });

      proc.stderr?.on("data", (data) => {
        stderr += data.toString();
      });

      let timedOut = false;
      const timeoutId = setTimeout(() => {
        timedOut = true;
        killProcess(proc, "SIGKILL");
      }, 15000); // Portal may show a user dialog, allow more time

      proc.on("close", (code) => {
        if (timedOut) return reject(new Error("linux-fast-paste wtype timed out"));
        clearTimeout(timeoutId);
        if (code === 0) {
          resolve();
        } else {
          reject(
            new Error(
              `linux-fast-paste exited with code ${code}${stderr ? `: ${stderr.trim()}` : ""}`
            )
          );
        }
      });

      proc.on("error", (error) => {
        if (timedOut) return;
        clearTimeout(timeoutId);
        reject(error);
      });
    });
  }

  _detectKdeWindowClass() {
    if (this.commandExists("kdotool")) {
      try {
        const idResult = spawnSync("kdotool", ["getactivewindow"], { timeout: 1000 });
        if (idResult.status === 0) {
          const winId = idResult.stdout.toString().trim();
          const classResult = spawnSync("kdotool", ["getwindowclassname", winId], {
            timeout: 1000,
          });
          if (classResult.status === 0) {
            const cls = classResult.stdout.toString().toLowerCase().trim();
            if (cls) return cls;
          }
        }
      } catch {}
    }

    // Fallback (KDE 5 and 6): load a tiny script into KWin via D-Bus that
    // prints the active window's resourceClass to the journal, read it back.
    const qdbus = ["qdbus6", "qdbus"].find((cmd) => this.commandExists(cmd));
    if (qdbus) {
      const journalMarker = `OW_CLASS_${process.pid}`;
      try {
        if (!this._kwinScriptPath) {
          this._kwinScriptPath = path.join(os.tmpdir(), `kwin-active-class-${process.pid}.js`);
          fs.writeFileSync(
            this._kwinScriptPath,
            `print("${journalMarker}:" + (workspace.activeWindow ? workspace.activeWindow.resourceClass : ""))`
          );
        }
        const loadResult = spawnSync(
          qdbus,
          ["org.kde.KWin", "/Scripting", "loadScript", this._kwinScriptPath],
          { timeout: 1000, stdio: "pipe" }
        );
        if (loadResult.status === 0) {
          const scriptId = loadResult.stdout.toString().trim();
          spawnSync(qdbus, ["org.kde.KWin", `/Scripting/Script${scriptId}`, "run"], {
            timeout: 1000,
            stdio: "pipe",
          });
          // KWin script executes in the compositor; brief pause lets the journal flush.
          spawnSync("sleep", ["0.03"], { timeout: 100 });

          const journalResult = spawnSync(
            "journalctl",
            [
              "--user",
              // KDE 6 logs KWin output under this identifier
              "--identifier=kwin_wayland_wrapper",
              "--since=3 seconds ago",
              "-n",
              "5",
              "--no-pager",
              "-o",
              "cat",
            ],
            { timeout: 1000, stdio: "pipe" }
          );
          spawnSync(qdbus, ["org.kde.KWin", `/Scripting/Script${scriptId}`, "stop"], {
            timeout: 1000,
            stdio: "pipe",
          });

          if (journalResult.status === 0) {
            const lines = journalResult.stdout.toString().split("\n");
            for (let i = lines.length - 1; i >= 0; i--) {
              const idx = lines[i].indexOf(`${journalMarker}:`);
              if (idx !== -1) {
                const cls = lines[i]
                  .slice(idx + journalMarker.length + 1)
                  .trim()
                  .toLowerCase();
                if (cls) return cls;
              }
            }
          }
        }
      } catch (err) {
        debugLogger.warn("KWin script fallback failed", { error: err?.message }, "clipboard");
      }
    }

    return null;
  }

  _saveClipboard() {
    const formats = clipboard.availableFormats();
    if (formats.some((f) => f.startsWith("image/"))) {
      return { type: "image", data: clipboard.readImage() };
    } else if (formats.includes("text/html")) {
      return { type: "html", text: clipboard.readText(), html: clipboard.readHTML() };
    } else {
      return { type: "text", data: clipboard.readText() };
    }
  }

  _restoreClipboard(original) {
    if (!original) return;
    if (original.type === "image") {
      if (!original.data.isEmpty()) clipboard.writeImage(original.data);
    } else if (original.type === "html") {
      clipboard.write({ text: original.text, html: original.html });
    } else {
      clipboard.writeText(original.data);
    }
    this.safeLog("🔄 Clipboard restored");
  }

  safeLog(...args) {
    if (process.env.NODE_ENV === "development") {
      try {
        console.log(...args);
      } catch (error) {
        // Silently ignore EPIPE errors in logging
        if (error.code !== "EPIPE") {
          process.stderr.write(`Log error: ${error.message}\n`);
        }
      }
    }
  }

  commandExists(cmd) {
    const now = Date.now();
    const cached = this.commandAvailabilityCache.get(cmd);
    if (cached && now < cached.expiresAt) {
      return cached.exists;
    }
    try {
      const res = spawnSync("sh", ["-c", `command -v ${cmd}`], {
        stdio: "ignore",
      });
      const exists = res.status === 0;
      this.commandAvailabilityCache.set(cmd, {
        exists,
        expiresAt: now + CACHE_TTL_MS,
      });
      return exists;
    } catch {
      this.commandAvailabilityCache.set(cmd, {
        exists: false,
        expiresAt: now + CACHE_TTL_MS,
      });
      return false;
    }
  }

  async pasteText(text, options = {}) {
    const startTime = Date.now();
    const platform = process.platform;
    let method = "unknown";
    const webContents = options.webContents;

    // Check if we can use wtype for direct typing without clipboard
    const canUseWtype = platform === "linux" && this._isWayland() && this.resolveWtypeScript();
    const skipClipboardWrite = options.skipClipboardBackup || canUseWtype;

    try {
      const shouldRestore = options.restoreClipboard !== false && !skipClipboardWrite;
      const originalClipboard = shouldRestore ? this._saveClipboard() : null;
      if (shouldRestore) {
        this.safeLog("💾 Saved original clipboard:", originalClipboard.type);
      }

      // Only write to clipboard if not using wtype (direct typing) or if explicitly requested
      if (!skipClipboardWrite) {
        if (platform === "linux" && this._isWayland()) {
          this._writeClipboardWayland(text, webContents);
        } else {
          clipboard.writeText(text);
        }
        this.safeLog("📋 Text copied to clipboard:", text.substring(0, 50) + "...");
      } else {
        debugLogger.debug("Skipping clipboard write - using direct typing (wtype)", {}, "clipboard");
      }

      if (platform === "darwin") {
        method = this.resolveFastPasteBinary() ? "cgevent" : "applescript";
        this.safeLog("🔍 Checking accessibility permissions for paste operation...");
        const hasPermissions = await this.checkAccessibilityPermissions();

        if (!hasPermissions) {
          this.safeLog("⚠️ No accessibility permissions - text copied to clipboard only");
          const errorMsg =
            "Accessibility permissions required for automatic pasting. Text has been copied to clipboard - please paste manually with Cmd+V.";
          throw new Error(errorMsg);
        }

        this.safeLog("✅ Permissions granted, attempting to paste...");
        try {
          await this.pasteMacOS(originalClipboard, options);
        } catch (firstError) {
          this.safeLog("⚠️ First paste attempt failed, retrying...", firstError?.message);
          clipboard.writeText(text);
          await new Promise((r) => setTimeout(r, 200));
          await this.pasteMacOS(originalClipboard, options);
        }
      } else if (platform === "win32") {
        const winFastPaste = this.resolveWindowsFastPasteBinary();
        if (winFastPaste) {
          method = "sendinput";
        } else {
          const nircmdPath = this.getNircmdPath();
          method = nircmdPath ? "nircmd" : "powershell";
        }
        await this.pasteWindows(originalClipboard);
      } else {
        // For Linux, try wtype first (no clipboard needed), fallback to clipboard if it fails
        const linuxMethod = await this.pasteLinux(originalClipboard, options, text, skipClipboardWrite);
        if (linuxMethod) {
          method = linuxMethod;
        } else if (skipClipboardWrite) {
          // Wtype failed/not available, fallback to clipboard
          debugLogger.debug("Wtype unavailable/failed, falling back to clipboard", {}, "clipboard");
          this._writeClipboardWayland(text, webContents);
          this.safeLog("📋 Text copied to clipboard (wtype fallback):", text.substring(0, 50) + "...");
          method = "clipboard-fallback";
        } else {
          method = "linux-tools";
        }
      }

      this.safeLog("✅ Paste operation complete", {
        platform,
        method,
        usedClipboard: !skipClipboardWrite || method === "clipboard-fallback",
        elapsedMs: Date.now() - startTime,
        textLength: text.length,
      });
    } catch (error) {
      this.safeLog("❌ Paste operation failed", {
        platform,
        method,
        usedClipboard: !skipClipboardWrite,
        elapsedMs: Date.now() - startTime,
        error: error.message,
      });
      
      // If wtype failed and we skipped clipboard, write to clipboard now as fallback
      if (skipClipboardWrite && canUseWtype && method !== "clipboard-fallback") {
        debugLogger.debug("Paste failed, attempting clipboard fallback", { error: error.message }, "clipboard");
        try {
          this._writeClipboardWayland(text, webContents);
          this.safeLog("📋 Text copied to clipboard (error fallback):", text.substring(0, 50) + "...");
        } catch (clipboardError) {
          debugLogger.error("Failed to write to clipboard fallback", { error: clipboardError.message }, "clipboard");
        }
      }
      
      throw error;
    }
  }

  async pasteMacOS(originalClipboard, options = {}) {
    const fastPasteBinary = this.resolveFastPasteBinary();
    const useFastPaste = !!fastPasteBinary;
    const pasteDelay = options.fromStreaming ? (useFastPaste ? 15 : 50) : PASTE_DELAYS.darwin;

    return new Promise((resolve, reject) => {
      setTimeout(() => {
        const pasteProcess = useFastPaste
          ? spawn(fastPasteBinary)
          : spawn("osascript", [
              "-e",
              'tell application "System Events" to key code 9 using command down',
            ]);

        let errorOutput = "";
        let hasTimedOut = false;

        pasteProcess.stderr.on("data", (data) => {
          errorOutput += data.toString();
        });

        pasteProcess.on("close", (code) => {
          if (hasTimedOut) return;
          clearTimeout(timeoutId);
          pasteProcess.removeAllListeners();

          if (code === 0) {
            this.safeLog(`Text pasted successfully via ${useFastPaste ? "CGEvent" : "osascript"}`);
            if (originalClipboard != null) {
              setTimeout(() => {
                this._restoreClipboard(originalClipboard);
              }, RESTORE_DELAYS.darwin);
            }
            resolve();
          } else if (useFastPaste) {
            this.safeLog(
              code === 2
                ? "CGEvent binary lacks accessibility trust, falling back to osascript"
                : `CGEvent paste failed (code ${code}), falling back to osascript`
            );
            this.fastPasteChecked = true;
            this.fastPastePath = null;
            this.pasteMacOSWithOsascript(originalClipboard).then(resolve).catch(reject);
          } else {
            this.accessibilityCache = { value: null, expiresAt: 0 };
            const errorMsg = `Paste failed (code ${code}). Text is copied to clipboard - please paste manually with Cmd+V.`;
            reject(new Error(errorMsg));
          }
        });

        pasteProcess.on("error", (error) => {
          if (hasTimedOut) return;
          clearTimeout(timeoutId);
          pasteProcess.removeAllListeners();

          if (useFastPaste) {
            this.safeLog("CGEvent paste error, falling back to osascript");
            this.fastPasteChecked = true;
            this.fastPastePath = null;
            this.pasteMacOSWithOsascript(originalClipboard).then(resolve).catch(reject);
          } else {
            const errorMsg = `Paste command failed: ${error.message}. Text is copied to clipboard - please paste manually with Cmd+V.`;
            reject(new Error(errorMsg));
          }
        });

        const timeoutId = setTimeout(() => {
          hasTimedOut = true;
          killProcess(pasteProcess, "SIGKILL");
          pasteProcess.removeAllListeners();
          const errorMsg =
            "Paste operation timed out. Text is copied to clipboard - please paste manually with Cmd+V.";
          reject(new Error(errorMsg));
        }, 3000);
      }, pasteDelay);
    });
  }

  async pasteMacOSWithOsascript(originalClipboard) {
    return new Promise((resolve, reject) => {
      const pasteProcess = spawn("osascript", [
        "-e",
        'tell application "System Events" to key code 9 using command down',
      ]);

      let hasTimedOut = false;

      pasteProcess.on("close", (code) => {
        if (hasTimedOut) return;
        clearTimeout(timeoutId);
        pasteProcess.removeAllListeners();

        if (code === 0) {
          this.safeLog("Text pasted successfully via osascript fallback");
          if (originalClipboard != null) {
            setTimeout(() => {
              this._restoreClipboard(originalClipboard);
            }, RESTORE_DELAYS.darwin);
          }
          resolve();
        } else {
          this.accessibilityCache = { value: null, expiresAt: 0 };
          const errorMsg = `Paste failed (code ${code}). Text is copied to clipboard - please paste manually with Cmd+V.`;
          reject(new Error(errorMsg));
        }
      });

      pasteProcess.on("error", (error) => {
        if (hasTimedOut) return;
        clearTimeout(timeoutId);
        pasteProcess.removeAllListeners();
        const errorMsg = `Paste command failed: ${error.message}. Text is copied to clipboard - please paste manually with Cmd+V.`;
        reject(new Error(errorMsg));
      });

      const timeoutId = setTimeout(() => {
        hasTimedOut = true;
        killProcess(pasteProcess, "SIGKILL");
        pasteProcess.removeAllListeners();
        reject(
          new Error(
            "Paste operation timed out. Text is copied to clipboard - please paste manually with Cmd+V."
          )
        );
      }, 3000);
    });
  }

  async pasteWindows(originalClipboard) {
    const fastPastePath = this.resolveWindowsFastPasteBinary();

    if (fastPastePath) {
      return this.pasteWithFastPaste(fastPastePath, originalClipboard);
    }

    return this.pasteWithNircmdOrPowerShell(originalClipboard);
  }

  async pasteWithFastPaste(fastPastePath, originalClipboard) {
    return new Promise((resolve, reject) => {
      setTimeout(() => {
        let hasTimedOut = false;
        const startTime = Date.now();

        this.safeLog("⚡ Windows fast-paste starting");

        const pasteProcess = spawn(fastPastePath, [], {
          stdio: ["ignore", "pipe", "pipe"],
          windowsHide: true,
        });

        let stdoutData = "";
        let stderrData = "";

        pasteProcess.stdout.on("data", (data) => {
          stdoutData += data.toString();
        });

        pasteProcess.stderr.on("data", (data) => {
          stderrData += data.toString();
        });

        pasteProcess.on("close", (code) => {
          if (hasTimedOut) return;
          clearTimeout(timeoutId);

          const elapsed = Date.now() - startTime;
          const output = stdoutData.trim();

          if (code === 0) {
            this.safeLog("✅ Windows fast-paste success", {
              elapsedMs: elapsed,
              output,
            });
            if (originalClipboard != null) {
              setTimeout(() => {
                this._restoreClipboard(originalClipboard);
              }, RESTORE_DELAYS.win32_nircmd);
            }
            resolve();
          } else {
            this.safeLog(
              `❌ Windows fast-paste failed (code ${code}), falling back to nircmd/PowerShell`,
              { elapsedMs: elapsed, stderr: stderrData.trim() }
            );
            this.pasteWithNircmdOrPowerShell(originalClipboard).then(resolve).catch(reject);
          }
        });

        pasteProcess.on("error", (error) => {
          if (hasTimedOut) return;
          clearTimeout(timeoutId);
          this.safeLog("❌ Windows fast-paste error, falling back to nircmd/PowerShell", {
            elapsedMs: Date.now() - startTime,
            error: error.message,
          });
          this.pasteWithNircmdOrPowerShell(originalClipboard).then(resolve).catch(reject);
        });

        const timeoutId = setTimeout(() => {
          hasTimedOut = true;
          this.safeLog("⏱️ Windows fast-paste timeout, falling back to nircmd/PowerShell");
          killProcess(pasteProcess, "SIGKILL");
          pasteProcess.removeAllListeners();
          this.pasteWithNircmdOrPowerShell(originalClipboard).then(resolve).catch(reject);
        }, 2000);
      }, PASTE_DELAYS.win32_fast);
    });
  }

  async pasteWithNircmdOrPowerShell(originalClipboard) {
    const nircmdPath = this.getNircmdPath();
    if (nircmdPath) {
      return this.pasteWithNircmd(nircmdPath, originalClipboard);
    }
    return this.pasteWithPowerShell(originalClipboard);
  }

  async pasteWithNircmd(nircmdPath, originalClipboard) {
    return new Promise((resolve, reject) => {
      const pasteDelay = PASTE_DELAYS.win32_nircmd;
      const restoreDelay = RESTORE_DELAYS.win32_nircmd;

      setTimeout(() => {
        let hasTimedOut = false;
        const startTime = Date.now();

        this.safeLog(`⚡ nircmd paste starting (delay: ${pasteDelay}ms)`);

        const pasteProcess = spawn(nircmdPath, ["sendkeypress", "ctrl+v"]);

        let errorOutput = "";

        pasteProcess.stderr.on("data", (data) => {
          errorOutput += data.toString();
        });

        pasteProcess.on("close", (code) => {
          if (hasTimedOut) return;
          clearTimeout(timeoutId);

          const elapsed = Date.now() - startTime;

          if (code === 0) {
            this.safeLog(`✅ nircmd paste success`, {
              elapsedMs: elapsed,
              restoreDelayMs: restoreDelay,
            });
            if (originalClipboard != null) {
              setTimeout(() => {
                this._restoreClipboard(originalClipboard);
              }, restoreDelay);
            }
            resolve();
          } else {
            this.safeLog(`❌ nircmd failed (code ${code}), falling back to PowerShell`, {
              elapsedMs: elapsed,
              stderr: errorOutput,
            });
            this.pasteWithPowerShell(originalClipboard).then(resolve).catch(reject);
          }
        });

        pasteProcess.on("error", (error) => {
          if (hasTimedOut) return;
          clearTimeout(timeoutId);
          const elapsed = Date.now() - startTime;
          this.safeLog(`❌ nircmd error, falling back to PowerShell`, {
            elapsedMs: elapsed,
            error: error.message,
          });
          this.pasteWithPowerShell(originalClipboard).then(resolve).catch(reject);
        });

        const timeoutId = setTimeout(() => {
          hasTimedOut = true;
          const elapsed = Date.now() - startTime;
          this.safeLog(`⏱️ nircmd timeout, falling back to PowerShell`, { elapsedMs: elapsed });
          killProcess(pasteProcess, "SIGKILL");
          pasteProcess.removeAllListeners();
          this.pasteWithPowerShell(originalClipboard).then(resolve).catch(reject);
        }, 2000);
      }, pasteDelay);
    });
  }

  async pasteWithPowerShell(originalClipboard) {
    return new Promise((resolve, reject) => {
      const pasteDelay = PASTE_DELAYS.win32_pwsh;
      const restoreDelay = RESTORE_DELAYS.win32_pwsh;

      setTimeout(() => {
        let hasTimedOut = false;
        const startTime = Date.now();

        this.safeLog(`🪟 PowerShell paste starting (delay: ${pasteDelay}ms)`);

        const pasteProcess = spawn("powershell.exe", [
          "-NoProfile",
          "-NonInteractive",
          "-WindowStyle",
          "Hidden",
          "-ExecutionPolicy",
          "Bypass",
          "-Command",
          "[void][System.Reflection.Assembly]::LoadWithPartialName('System.Windows.Forms');[System.Windows.Forms.SendKeys]::SendWait('^v')",
        ]);

        let errorOutput = "";

        pasteProcess.stderr.on("data", (data) => {
          errorOutput += data.toString();
        });

        pasteProcess.on("close", (code) => {
          if (hasTimedOut) return;
          clearTimeout(timeoutId);

          const elapsed = Date.now() - startTime;

          if (code === 0) {
            this.safeLog(`✅ PowerShell paste success`, {
              elapsedMs: elapsed,
              restoreDelayMs: restoreDelay,
            });
            if (originalClipboard != null) {
              setTimeout(() => {
                this._restoreClipboard(originalClipboard);
              }, restoreDelay);
            }
            resolve();
          } else {
            this.safeLog(`❌ PowerShell paste failed`, {
              code,
              elapsedMs: elapsed,
              stderr: errorOutput,
            });
            reject(
              new Error(
                `Windows paste failed with code ${code}. Text is copied to clipboard - please paste manually with Ctrl+V.`
              )
            );
          }
        });

        pasteProcess.on("error", (error) => {
          if (hasTimedOut) return;
          clearTimeout(timeoutId);
          const elapsed = Date.now() - startTime;
          this.safeLog(`❌ PowerShell paste error`, {
            elapsedMs: elapsed,
            error: error.message,
          });
          reject(
            new Error(
              `Windows paste failed: ${error.message}. Text is copied to clipboard - please paste manually with Ctrl+V.`
            )
          );
        });

        const timeoutId = setTimeout(() => {
          hasTimedOut = true;
          const elapsed = Date.now() - startTime;
          this.safeLog(`⏱️ PowerShell paste timeout`, { elapsedMs: elapsed });
          killProcess(pasteProcess, "SIGKILL");
          pasteProcess.removeAllListeners();
          reject(
            new Error(
              "Paste operation timed out. Text is copied to clipboard - please paste manually with Ctrl+V."
            )
          );
        }, 5000);
      }, pasteDelay);
    });
  }

  async pasteLinux(originalClipboard, options = {}, text = null, skipClipboardWrite = false) {
    const { isWayland, isWlroots } = getLinuxSessionInfo();
    const wtypeBinary = this.resolveWtypeScript();

    debugLogger.debug(
      "=== LINUX PASTE START ===",
      {
        isWayland,
        isWlroots,
        wtypeBinaryPath: wtypeBinary,
        wtypeBinaryExists: !!wtypeBinary,
        textProvided: !!text,
        textLength: text?.length,
        textPreview: text?.substring(0, 50),
        skipClipboardWrite,
        waylandDisplay: process.env.WAYLAND_DISPLAY,
        xdgSessionType: process.env.XDG_SESSION_TYPE,
        xdgCurrentDesktop: process.env.XDG_CURRENT_DESKTOP,
      },
      "clipboard"
    );

    // Try wtype binary (direct text typing without clipboard)
    if (wtypeBinary && text) {
      debugLogger.debug("Wtype binary path valid and text provided, attempting paste", {
        binary: wtypeBinary,
        textLength: text.length,
        skipClipboardWrite,
      }, "clipboard");
      try {
        await this.spawnWtypeScript(text, "wtype");
        this.safeLog("✅ Paste successful using wtype binary (no clipboard touched)");
        debugLogger.info(
          "Paste successful",
          { tool: "wtype-binary", usedClipboard: false },
          "clipboard"
        );
        return "wtype-binary";
      } catch (error) {
        debugLogger.error("wtype binary failed", { error: error.message, skipClipboardWrite }, "clipboard");
        this.safeLog("❌ Wtype binary failed");
        
        // If wtype failed and we skipped clipboard, don't throw - let caller handle clipboard fallback
        if (skipClipboardWrite) {
          debugLogger.debug("Wtype failed with skipClipboardWrite=true, allowing fallback", {}, "clipboard");
          // Return null to indicate we should try clipboard fallback
          return null;
        }
        
        const err = new Error(`Paste failed: ${error.message}`);
        err.code = "PASTE_SIMULATION_FAILED";
        throw err;
      }
    }

    // No wtype binary available or no text
    const failReason = !wtypeBinary ? "binary_not_found" : !text ? "no_text" : "unknown";
    debugLogger.error("Wtype binary not available for paste", {
      wtypeBinaryPath: wtypeBinary,
      textProvided: !!text,
      textLength: text?.length,
      reason: failReason,
      skipClipboardWrite,
      __dirname,
      processResourcesPath: process.resourcesPath,
    }, "clipboard");
    
    if (skipClipboardWrite) {
      // Let caller handle clipboard fallback
      return null;
    }
    
    const err = new Error(`wtype binary not found - paste unavailable (${failReason})`);
    err.code = "PASTE_SIMULATION_FAILED";
    throw err;
  }

  async checkAccessibilityPermissions(silent = false) {
    if (process.platform !== "darwin") return true;

    if (!silent) {
      const now = Date.now();
      if (now < this.accessibilityCache.expiresAt && this.accessibilityCache.value !== null) {
        return this.accessibilityCache.value;
      }
    }

    const allowed = systemPreferences.isTrustedAccessibilityClient(false);

    if (!silent) {
      this.accessibilityCache = {
        value: allowed,
        expiresAt: Date.now() + ACCESSIBILITY_CHECK_TTL_MS,
      };

      if (!allowed) {
        this.showAccessibilityDialog("not allowed assistive access");
      }
    }

    return allowed;
  }

  showAccessibilityDialog(testError) {
    const isStuckPermission =
      testError.includes("not allowed assistive access") ||
      testError.includes("(-1719)") ||
      testError.includes("(-25006)");

    let dialogMessage;
    if (isStuckPermission) {
      dialogMessage = `🔒 OpenWhispr needs Accessibility permissions, but it looks like you may have OLD PERMISSIONS from a previous version.

❗ COMMON ISSUE: If you've rebuilt/reinstalled OpenWhispr, the old permissions may be "stuck" and preventing new ones.

🔧 To fix this:
1. Open System Settings → Privacy & Security → Accessibility
2. Look for ANY old "OpenWhispr" entries and REMOVE them (click the - button)
3. Also remove any entries that say "Electron" or have unclear names
4. Click the + button and manually add the NEW OpenWhispr app
5. Make sure the checkbox is enabled
6. Restart OpenWhispr

⚠️ This is especially common during development when rebuilding the app.

📝 Without this permission, text will only copy to clipboard (no automatic pasting).

Would you like to open System Settings now?`;
    } else {
      dialogMessage = `🔒 OpenWhispr needs Accessibility permissions to paste text into other applications.

📋 Current status: Clipboard copy works, but pasting (Cmd+V simulation) fails.

🔧 To fix this:
1. Open System Settings (or System Preferences on older macOS)
2. Go to Privacy & Security → Accessibility
3. Click the lock icon and enter your password
4. Add OpenWhispr to the list and check the box
5. Restart OpenWhispr

⚠️ Without this permission, dictated text will only be copied to clipboard but won't paste automatically.

💡 In production builds, this permission is required for full functionality.

Would you like to open System Settings now?`;
    }

    const permissionDialog = spawn("osascript", [
      "-e",
      `display dialog "${dialogMessage}" buttons {"Cancel", "Open System Settings"} default button "Open System Settings"`,
    ]);

    permissionDialog.on("close", (dialogCode) => {
      if (dialogCode === 0) {
        this.openSystemSettings();
      }
    });

    permissionDialog.on("error", () => {});
  }

  openSystemSettings() {
    const settingsCommands = [
      ["open", ["x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility"]],
      ["open", ["-b", "com.apple.systempreferences"]],
      ["open", ["/System/Library/PreferencePanes/Security.prefPane"]],
    ];

    let commandIndex = 0;
    const tryNextCommand = () => {
      if (commandIndex < settingsCommands.length) {
        const [cmd, args] = settingsCommands[commandIndex];
        const settingsProcess = spawn(cmd, args);

        settingsProcess.on("error", (error) => {
          commandIndex++;
          tryNextCommand();
        });

        settingsProcess.on("close", (settingsCode) => {
          if (settingsCode !== 0) {
            commandIndex++;
            tryNextCommand();
          }
        });
      } else {
        spawn("open", ["-a", "System Preferences"]).on("error", () => {
          spawn("open", ["-a", "System Settings"]).on("error", () => {});
        });
      }
    };

    tryNextCommand();
  }

  preWarmAccessibility() {
    if (process.platform === "linux") {
      this.resolveWtypeScript();
      return;
    }
    if (process.platform !== "darwin") return;
    this.checkAccessibilityPermissions().catch(() => {});
    this.resolveFastPasteBinary();
  }

  async readClipboard() {
    return clipboard.readText();
  }

  async writeClipboard(text, webContents = null) {
    if (process.platform === "linux" && this._isWayland()) {
      this._writeClipboardWayland(text, webContents);
    } else {
      clipboard.writeText(text);
    }
    return { success: true };
  }

  checkPasteTools() {
    const platform = process.platform;

    if (platform === "darwin") {
      const fastPaste = this.resolveFastPasteBinary();
      return {
        platform: "darwin",
        available: true,
        method: fastPaste ? "cgevent" : "applescript",
        requiresPermission: true,
        tools: [],
      };
    }

    if (platform === "win32") {
      const winFastPaste = this.resolveWindowsFastPasteBinary();
      return {
        platform: "win32",
        available: true,
        method: winFastPaste ? "sendinput" : "powershell",
        requiresPermission: false,
        terminalAware: !!winFastPaste,
        tools: [],
      };
    }

    const { isWayland, isWlroots } = getLinuxSessionInfo();
    const wtypeScript = this.resolveWtypeScript();
    const hasWtypeScript = !!wtypeScript;

    const tools = [];
    const canUseWtype = isWayland && isWlroots;

    const available = tools.length > 0;
    let recommendedInstall;
    if (!available) {
      if (isWlroots) {
        recommendedInstall = "wtype";
      } else {
        recommendedInstall = "xdotool";
      }
    }

    return {
      platform: "linux",
      available,
      method: available ? tools[0] : null,
      requiresPermission: false,
      isWayland,
      tools,
      recommendedInstall,
    };
  }
}

module.exports = ClipboardManager;
