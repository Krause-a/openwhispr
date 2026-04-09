#!/bin/bash
# WType-based paste script for Wayland compositors
# Types the text directly instead of using Ctrl+V
# Text is passed via stdin from the calling process

# Read the text from stdin
TEXT=$(cat)

# Type the text directly using wtype
if [ -n "$TEXT" ]; then
    wtype "$TEXT"
fi
