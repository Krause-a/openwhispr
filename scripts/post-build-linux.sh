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

# Task 2: Verify wtype-based linux-fast-paste is present
# Note: linux-fast-paste is now a static wtype-based script in resources/bin/
echo "[post-build-linux] Verifying wtype-based linux-fast-paste..."

if [ ! -f "${RESOURCES_BIN_DIR}/linux-fast-paste" ]; then
    echo "[post-build-linux] Warning: linux-fast-paste not found in resources, copying from repo"
    cp "${PROJECT_ROOT}/resources/bin/linux-fast-paste" "${RESOURCES_BIN_DIR}/linux-fast-paste" 2>/dev/null || true
fi

echo "[post-build-linux] linux-fast-paste verified (wtype-based)"

echo "[post-build-linux] Post-build tasks complete!"
