#!/bin/bash
# WType-based paste - types text passed as arguments
# Strips control characters (except newlines/tabs), converts \n to Shift+Enter

# Convert literal \n to actual newlines first
input="${*//\\n/$'\n'}"

# Strip other control characters (keep newlines and tabs)
input=$(echo "$input" | tr -d '\000-\010\013\014\016-\037\177')

# Split on newlines and type with Shift+Enter between lines
IFS=$'\n' read -ra lines <<< "$input"
for i in "${!lines[@]}"; do
	wtype "${lines[$i]}"
	# Add Shift+Enter after each line except the last
	if [[ $i -lt $((${#lines[@]} - 1)) ]]; then
		wtype -M shift -k Return -m shift
	fi
done
