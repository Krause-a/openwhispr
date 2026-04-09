#!/bin/zsh
# WType-based paste with debug logging
# Types text passed as arguments, logs to stderr for debugging

# Log raw arguments for debugging
echo "[wtype-script] Raw args count: $#" >&2
echo "[wtype-script] Raw args: $*" >&2

# Replace literal \n with real newlines
input="${*//\\n/$'\n'}"

# Log after newline conversion
echo "[wtype-script] After newline conversion (length: ${#input}):" >&2
echo "[wtype-script] '$input'" >&2

# Strip control chars (keep tabs/newlines)
input=$(echo "$input" | tr -d '\000-\010\013\014\016-\037\177')

# Log after control char stripping
echo "[wtype-script] After control char strip (length: ${#input}):" >&2
echo "[wtype-script] '$input'" >&2

# Split on newlines (preserves empty lines via zsh splitting)
lines=(${(s:\n:)input})

# Log line count
echo "[wtype-script] Split into $#lines lines" >&2

# Type each line, Shift+Enter between lines
for i in {1..$#lines}; do
    echo "[wtype-script] Typing line $i: '${lines[$i]}'" >&2
    wtype "${lines[$i]}"
    (( i < $#lines )) && {
        echo "[wtype-script] Sending Shift+Enter between lines" >&2
        wtype -M shift -k Return -m shift
    }
done

echo "[wtype-script] Complete" >&2