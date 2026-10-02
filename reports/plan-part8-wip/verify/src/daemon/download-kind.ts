import type { DownloadKind } from "../protocol/quarantine.ts";

// What a quarantined file is, for the card the user releases it from: by its first bytes first,
// then by its name. A program is anything that runs when opened or executed; the card says so.
const PROGRAM_EXT = new Set([
  "sh", "bash", "zsh", "py", "pl", "rb", "js", "mjs", "php", "run", "bin", "appimage", "deb", "rpm",
  "snap", "flatpak", "desktop", "jar", "exe", "msi", "bat", "cmd", "ps1", "com", "scr", "apk", "dmg",
  "pkg", "app", "command", "elf", "so", "ko", "vbs", "wsf", "lnk",
]);
const ARCHIVE_EXT = new Set(["zip", "gz", "tgz", "xz", "bz2", "zst", "7z", "rar", "tar", "iso"]);
const DOCUMENT_EXT = new Set([
  "pdf", "txt", "md", "csv", "tsv", "json", "xml", "html", "htm", "rtf", "doc", "docx", "xls",
  "xlsx", "ppt", "pptx", "odt", "ods", "odp", "epub",
]);
const MEDIA_EXT = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg", "mp3", "wav", "ogg", "mp4", "mov", "webm", "m4a", "heic"]);
const OFFICE_ZIP = new Set(["docx", "xlsx", "pptx", "odt", "ods", "odp", "epub"]);

function startsWith(head: Buffer, bytes: number[]): boolean {
  return bytes.every((b, i) => head[i] === b);
}

export function downloadKind(name: string, head: Buffer): DownloadKind {
  const dot = name.lastIndexOf(".");
  const ext = dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
  if (
    startsWith(head, [0x7f, 0x45, 0x4c, 0x46]) || // ELF
    startsWith(head, [0x23, 0x21]) || // #!
    startsWith(head, [0x4d, 0x5a]) || // MZ (PE)
    startsWith(head, [0xcf, 0xfa, 0xed, 0xfe]) || // Mach-O 64
    startsWith(head, [0xca, 0xfe, 0xba, 0xbe]) || // Mach-O fat, Java class
    startsWith(head, [0x21, 0x3c, 0x61, 0x72, 0x63, 0x68, 0x3e]) || // !<arch> (.deb)
    PROGRAM_EXT.has(ext)
  )
    return "program";
  if (startsWith(head, [0x50, 0x4b, 0x03, 0x04])) return OFFICE_ZIP.has(ext) ? "document" : "archive";
  if (
    startsWith(head, [0x1f, 0x8b]) ||
    startsWith(head, [0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00]) ||
    startsWith(head, [0x42, 0x5a, 0x68]) ||
    startsWith(head, [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]) ||
    startsWith(head, [0x52, 0x61, 0x72, 0x21]) ||
    ARCHIVE_EXT.has(ext)
  )
    return "archive";
  if (startsWith(head, [0x25, 0x50, 0x44, 0x46]) || DOCUMENT_EXT.has(ext)) return "document";
  if (MEDIA_EXT.has(ext)) return "media";
  return "other";
}
