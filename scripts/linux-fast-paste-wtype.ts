#!/usr/bin/env bun
/**
 * Linux fast paste using wtype - TypeScript implementation
 * Types text passed as arguments, handling newlines and special characters
 */

import { spawnSync } from "child_process";

// Log to stderr for debugging
function log(...args: any[]) {
  console.error("[wtype-script]", ...args);
}

function main() {
  const args = process.argv.slice(2);
  const rawInput = args.join(" ");

  log("Raw args count:", args.length);
  log("Raw input length:", rawInput.length);
  log("Raw input preview:", rawInput.substring(0, 100));

  // Replace literal \n with actual newlines
  let input = rawInput.replace(/\\n/g, "\n");
  log("After newline conversion, length:", input.length);

  // Strip control characters (keep tabs \t and newlines \n)
  // ASCII 0-8 (null-backspace), 11-12 (vertical tab, form feed), 14-31, 127 (DEL)
  input = input.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "");
  log("After control char strip, length:", input.length);

  // Split on newlines
  const lines = input.split("\n");
  log("Split into", lines.length, "lines");

  // Type each line - first line has no prefix, subsequent lines get newline first
  let isFirst = true;
  for (const line of lines) {
    let textToType = line;
    
    if (!isFirst) {
      // Add newline before subsequent lines
      textToType = "\n" + line;
      log("Adding newline prefix for subsequent line");
    }
    
    log(`Typing line (${isFirst ? "first" : "subsequent"}):`, textToType.substring(0, 50) + (textToType.length > 50 ? "..." : ""));

    // Type the text using wtype
    const result = spawnSync("wtype", [textToType], { encoding: "utf8" });
    
    if (result.error) {
      log("ERROR spawning wtype:", result.error.message);
      process.exit(1);
    }
    
    if (result.status !== 0) {
      log("wtype exited with code:", result.status);
      if (result.stderr) log("wtype stderr:", result.stderr);
    }

    isFirst = false;
  }

  log("Complete");
}

main();
