#!/usr/bin/env node
import { run } from "./cli.ts";

process.exitCode = run(process.argv.slice(2));
