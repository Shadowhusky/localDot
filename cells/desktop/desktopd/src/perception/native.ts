import { execFile } from "node:child_process";
import type { Rect } from "@localdot/protocol";
import type { HelperWindow } from "./hit-test.ts";

export interface NativeElement {
  role: string;
  name: string;
  frame: Rect;
  ancestorRoles: string[];
  depth: number;
}

export interface NativeAccessibility {
  query(win: HelperWindow, mode: "focused" | "content" | "namebox"): Promise<NativeElement | null>;
}

// Separate from XTest's helper: a hung application must not block input or its raw timestamps.
export class AtspiAccessibility implements NativeAccessibility {
  constructor(private readonly script = "/opt/localdot/native.py") {}

  query(win: HelperWindow, mode: "focused" | "content" | "namebox"): Promise<NativeElement | null> {
    return new Promise((resolve, reject) => {
      execFile(
        "/usr/bin/python3",
        [this.script, JSON.stringify({ pid: win.pid, title: win.title, mode })],
        { timeout: 1500, maxBuffer: 64 * 1024, env: process.env },
        (error, stdout) => {
          if (error) return reject(error);
          try {
            resolve(JSON.parse(stdout) as NativeElement | null);
          } catch (err) {
            reject(err);
          }
        },
      );
    });
  }
}
