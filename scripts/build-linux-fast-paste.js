#!/usr/bin/env node
/**
 * Build script for Linux fast-paste wtype script
 * Compiles TypeScript to a standalone executable using Bun
 */

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const isLinux = process.platform === "linux";
if (!isLinux) {
  process.exit(0);
}

const projectRoot = path.resolve(__dirname, "..");
const sourceScript = path.join(projectRoot, "scripts", "linux-fast-paste-wtype.ts");
const outputDir = path.join(projectRoot, "resources", "bin");
const outputBinary = path.join(outputDir, "linux-fast-paste-wtype");

function log(message) {
  console.log(`[linux-fast-paste] ${message}`);
}

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

// Check if source exists
if (!fs.existsSync(sourceScript)) {
  console.error(`[linux-fast-paste] Source script not found at ${sourceScript}`);
  process.exit(1);
}

ensureDir(outputDir);

// Compile TypeScript to standalone executable using bun
log(`Compiling ${sourceScript} to standalone executable...`);

const result = spawnSync("bun", [
  "build",
  "--compile",
  "--target", "bun-linux-x64",
  "--outfile", outputBinary,
  sourceScript
], {
  cwd: projectRoot,
  stdio: "inherit",
  encoding: "utf8"
});

if (result.error) {
  console.error(`[linux-fast-paste] Failed to compile: ${result.error.message}`);
  console.error(`[linux-fast-paste] Make sure 'bun' is installed: https://bun.sh`);
  process.exit(1);
}

if (result.status !== 0) {
  console.error(`[linux-fast-paste] Compilation failed with exit code ${result.status}`);
  process.exit(1);
}

// Make executable
fs.chmodSync(outputBinary, 0o755);
log(`Compiled standalone binary to ${outputBinary}`);
log("Linux fast-paste ready (wtype-based).");
