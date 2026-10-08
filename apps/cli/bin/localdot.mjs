#!/usr/bin/env node

const major = Number(process.versions.node.split(".")[0]);
if (!Number.isInteger(major) || major < 24) {
  console.error("localDot requires Node.js 24 or newer.");
  process.exitCode = 1;
} else {
  try {
    await import("../dist/cli.mjs");
  } catch {
    console.error("localDot could not start. Check that the application package is complete.");
    process.exitCode = 1;
  }
}
