#!/usr/bin/env node

const fs = require("fs");
const path = require("path");

const isLinux = process.platform === "linux";
if (!isLinux) {
  process.exit(0);
}

const projectRoot = path.resolve(__dirname, "..");
const wtypeScript = path.join(projectRoot, "scripts", "linux-fast-paste-wtype.sh");
const outputDir = path.join(projectRoot, "resources", "bin");
const outputScript = path.join(outputDir, "linux-fast-paste");

function log(message) {
  console.log(`[linux-fast-paste] ${message}`);
}

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

// Always use the wtype-based script
if (!fs.existsSync(wtypeScript)) {
  console.error(`[linux-fast-paste] WType script not found at ${wtypeScript}`);
  process.exit(1);
}

ensureDir(outputDir);

// Copy the wtype script to resources/bin/
try {
  fs.copyFileSync(wtypeScript, outputScript);
  fs.chmodSync(outputScript, 0o755);
  log(`Copied wtype-based paste script to ${outputScript}`);
} catch (error) {
  console.error(`[linux-fast-paste] Failed to copy script: ${error.message}`);
  process.exit(1);
}

log("Linux fast-paste ready (wtype-based).");
