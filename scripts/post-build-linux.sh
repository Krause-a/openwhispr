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

# Task 2: Copy wtype-based linux-fast-paste binary
# Note: This runs AFTER electron-builder, so we copy directly to unpacked dir
echo "[post-build-linux] Installing wtype-based linux-fast-paste binary..."

# Source binary location (compiled by build-linux-fast-paste.js)
WTYPE_BINARY="${PROJECT_ROOT}/resources/bin/linux-fast-paste-wtype"
DEST_BINARY="${RESOURCES_BIN_DIR}/linux-fast-paste-wtype"

if [ ! -f "${WTYPE_BINARY}" ]; then
    echo "[post-build-linux] ERROR: Compiled binary not found at ${WTYPE_BINARY}"
    echo "[post-build-linux] Please run: npm run compile:linux-paste"
    exit 1
fi

# Create resources/bin if it doesn't exist
if [ ! -d "${RESOURCES_BIN_DIR}" ]; then
    echo "[post-build-linux] Creating resources/bin directory..."
    mkdir -p "${RESOURCES_BIN_DIR}"
fi

# Copy the binary
cp "${WTYPE_BINARY}" "${DEST_BINARY}"
chmod +x "${DEST_BINARY}"
echo "[post-build-linux] Installed ${DEST_BINARY}"

# Cleanup old files
if [ -f "${RESOURCES_BIN_DIR}/linux-fast-paste" ]; then
    echo "[post-build-linux] Removing old linux-fast-paste binary..."
    rm -f "${RESOURCES_BIN_DIR}/linux-fast-paste"
fi
if [ -f "${RESOURCES_BIN_DIR}/linux-fast-paste-wtype.sh" ]; then
    echo "[post-build-linux] Removing old linux-fast-paste-wtype.sh script..."
    rm -f "${RESOURCES_BIN_DIR}/linux-fast-paste-wtype.sh"
fi

echo "[post-build-linux] linux-fast-paste-wtype ready"

echo "[post-build-linux] Post-build tasks complete!"
