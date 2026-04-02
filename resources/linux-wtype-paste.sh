#!/bin/bash
# linux-wtype-paste.sh - Paste text using wl-copy and wtype on Wayland
#
# This script replaces the functionality of linux-fast-paste.c binary for Wayland environments.
# It uses wl-copy (from wl-clipboard) to copy text to the clipboard and wtype to simulate
# keystrokes for pasting.
#
# Usage:
#   echo "hello world" | ./linux-wtype-paste.sh
#   ./linux-wtype-paste.sh "hello world"
#   ./linux-wtype-paste.sh --terminal "hello world"  # Uses Ctrl+Shift+V for terminal

set -euo pipefail

# Exit codes
EXIT_SUCCESS=0
EXIT_MISSING_WTYPE=1
EXIT_MISSING_WLCOPY=2
EXIT_NOT_WAYLAND=3
EXIT_NO_TEXT=4
EXIT_PASTE_FAILED=5

# Parse arguments
TERMINAL_MODE=false
TEXT=""

while [[ $# -gt 0 ]]; do
    case $1 in
        --terminal)
            TERMINAL_MODE=true
            shift
            ;;
        --help|-h)
            echo "Usage: $0 [--terminal] [text]"
            echo ""
            echo "Options:"
            echo "  --terminal    Use Ctrl+Shift+V instead of Ctrl+V (for terminal windows)"
            echo "  --help, -h    Show this help message"
            echo ""
            echo "Text can be provided as an argument or via stdin."
            exit $EXIT_SUCCESS
            ;;
        -*)
            echo "Error: Unknown option $1" >&2
            echo "Use --help for usage information" >&2
            exit $EXIT_NO_TEXT
            ;;
        *)
            TEXT="$1"
            shift
            ;;
    esac
done

# If no text argument, read from stdin
if [[ -z "$TEXT" ]]; then
    if [[ ! -t 0 ]]; then
        # stdin has data
        TEXT=$(cat)
    else
        echo "Error: No text provided. Provide text as an argument or via stdin." >&2
        echo "Use --help for usage information" >&2
        exit $EXIT_NO_TEXT
    fi
fi

# Check for Wayland
if [[ -z "${WAYLAND_DISPLAY:-}" ]]; then
    echo "Error: WAYLAND_DISPLAY environment variable not set. This script requires a Wayland session." >&2
    exit $EXIT_NOT_WAYLAND
fi

# Check if wl-copy is installed
if ! command -v wl-copy &> /dev/null; then
    echo "Error: wl-copy is not installed. Please install wl-clipboard package." >&2
    echo "  Debian/Ubuntu: sudo apt install wl-clipboard" >&2
    echo "  Fedora: sudo dnf install wl-clipboard" >&2
    echo "  Arch: sudo pacman -S wl-clipboard" >&2
    exit $EXIT_MISSING_WLCOPY
fi

# Check if wtype is installed
if ! command -v wtype &> /dev/null; then
    echo "Error: wtype is not installed. Please install wtype package." >&2
    echo "  Debian/Ubuntu: sudo apt install wtype" >&2
    echo "  Fedora: sudo dnf install wtype" >&2
    echo "  Arch: sudo pacman -S wtype" >&2
    exit $EXIT_MISSING_WTYPE
fi

# Copy text to clipboard using wl-copy
echo "$TEXT" | wl-copy --type text/plain

if [[ $? -ne 0 ]]; then
    echo "Error: Failed to copy text to clipboard using wl-copy" >&2
    exit $EXIT_PASTE_FAILED
fi

# Wait a moment for clipboard to update
sleep 0.05

# Send paste keystroke using wtype
if [[ "$TERMINAL_MODE" == true ]]; then
    # Terminal: Ctrl+Shift+V
    wtype -M ctrl -M shift -k v -m shift -m ctrl
else
    # Normal: Ctrl+V
    wtype -M ctrl -k v -m ctrl
fi

if [[ $? -ne 0 ]]; then
    echo "Error: Failed to send paste keystroke using wtype" >&2
    exit $EXIT_PASTE_FAILED
fi

exit $EXIT_SUCCESS
