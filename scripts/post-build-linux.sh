#!/bin/bash
# Post-build script for Linux unpacked builds

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
UNPACKED_DIR="${PROJECT_ROOT}/dist/linux-unpacked"
RESOURCES_BIN_DIR="${UNPACKED_DIR}/resources/bin"

echo "[post-build-linux] Running post-build tasks..."

# Task 1: Generate and install .desktop file
echo "[post-build-linux] Generating .desktop file..."

# Create the .desktop file in unpacked directory
cat > "${UNPACKED_DIR}/open-whispr.desktop" << EOF
[Desktop Entry]
Name=OpenWhispr
Comment=Voice dictation and transcription
Exec=${UNPACKED_DIR}/open-whispr
Icon=${UNPACKED_DIR}/resources/appIcon.png
Type=Application
Categories=Utility;AudioVideo;
StartupWMClass=open-whispr
Terminal=false
EOF

echo "[post-build-linux] Created ${UNPACKED_DIR}/open-whispr.desktop"

# Install to local applications if directory exists
if [ -d "$HOME/.local/share/applications" ]; then
    echo "[post-build-linux] Installing .desktop file to ~/.local/share/applications/"
    cp "${UNPACKED_DIR}/open-whispr.desktop" "$HOME/.local/share/applications/"
    update-desktop-database "$HOME/.local/share/applications/" 2>/dev/null || true
else
    echo "[post-build-linux] Warning: ~/.local/share/applications/ not found, skipping install"
fi

# Task 2: Create wtype-based linux-fast-paste replacement
echo "[post-build-linux] Creating wtype-based linux-fast-paste..."

mkdir -p "${RESOURCES_BIN_DIR}"

cat > "${RESOURCES_BIN_DIR}/linux-fast-paste" << 'PASTE_EOF'
#!/bin/bash
# Minimal wtype-based paste for Wayland

# Check if we're in a terminal (simple check: common terminal env vars)
if [ -n "$TERM" ] && [ "$TERM" != "dumb" ] && [ "$TERM" != "linux" ]; then
    # Terminal detected - use Ctrl+Shift+V
    wtype -M ctrl -M shift -k v -m shift -m ctrl
else
    # Regular window - use Ctrl+V
    wtype -M ctrl -k v -m ctrl
fi
PASTE_EOF

chmod +x "${RESOURCES_BIN_DIR}/linux-fast-paste"

echo "[post-build-linux] Created ${RESOURCES_BIN_DIR}/linux-fast-paste (wtype-based)"

echo "[post-build-linux] Post-build tasks complete!"
echo "[post-build-linux] You can now launch OpenWhispr via: gtk-launch open-whispr"
