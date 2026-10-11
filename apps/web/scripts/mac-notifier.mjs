import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// Ship a native helper with Mac builds. End users need no compiler or notification utility.
export function buildMacNotifier(webDir, outDir) {
  if (process.platform !== "darwin") return;
  const bundle = join(outDir, "native/localDot.app/Contents");
  mkdirSync(join(bundle, "MacOS"), { recursive: true });
  mkdirSync(join(bundle, "Resources"), { recursive: true });
  const png = readFileSync(join(webDir, "public/icons/icon-512.png"));
  const icon = Buffer.alloc(16 + png.length);
  icon.write("icns", 0);
  icon.writeUInt32BE(icon.length, 4);
  icon.write("ic09", 8); // PNG-encoded 512 px mascot, the same artwork as the installed web app.
  icon.writeUInt32BE(png.length + 8, 12);
  png.copy(icon, 16);
  writeFileSync(join(bundle, "Resources/dot.icns"), icon);
  writeFileSync(
    join(bundle, "Info.plist"),
    `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>dev.localdot.notifications</string>
<key>CFBundleName</key><string>localDot</string>
<key>CFBundleDisplayName</key><string>localDot</string>
<key>CFBundleExecutable</key><string>localdot-notify</string>
<key>CFBundleIconFile</key><string>dot.icns</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleVersion</key><string>1</string>
<key>LSUIElement</key><true/>
<key>LSMinimumSystemVersion</key><string>11.0</string>
</dict></plist>`,
  );
  execFileSync(
    "/usr/bin/xcrun",
    [
      "swiftc",
      "-O",
      "-framework",
      "AppKit",
      "-framework",
      "UserNotifications",
      join(webDir, "../daemon/native/notify.swift"),
      "-o",
      join(bundle, "MacOS/localdot-notify"),
    ],
    { timeout: 120_000, stdio: "inherit" },
  );
  execFileSync("/usr/bin/codesign", ["--force", "--sign", "-", join(bundle, "..")], {
    timeout: 30_000,
    stdio: "inherit",
  });
}
