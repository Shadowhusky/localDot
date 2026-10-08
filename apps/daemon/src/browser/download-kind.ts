import type { DownloadKind } from "../../../../packages/protocol/src/quarantine.ts";

export function downloadKind(name: string, head: Uint8Array): DownloadKind {
  const bytes = Buffer.from(head.subarray(0, 64));
  const magic = bytes.subarray(0, 4).toString("hex");
  const text = bytes.toString("latin1");
  if (
    magic === "7f454c46" ||
    text.startsWith("MZ") ||
    text.startsWith("#!") ||
    ["feedface", "feedfacf", "cefaedfe", "cffaedfe", "cafebabe", "bebafeca"].includes(magic) ||
    /\.(?:exe|msi|dll|com|bat|cmd|ps1|sh|bash|zsh|fish|py|js|mjs|cjs|app|dmg|pkg|deb|rpm|desktop|jar|wasm)$/iu.test(
      name,
    )
  )
    return "program";
  if (
    ["504b0304", "504b0506", "504b0708", "377abcaf", "52617221"].includes(magic) ||
    bytes.subarray(0, 2).toString("hex") === "1f8b" ||
    /\.(?:zip|tar|gz|tgz|bz2|xz|7z|rar)$/iu.test(name)
  )
    return "archive";
  if (
    magic === "89504e47" ||
    text.startsWith("GIF8") ||
    bytes.subarray(0, 3).toString("hex") === "ffd8ff" ||
    (text.startsWith("RIFF") && text.slice(8, 12) === "WEBP")
  )
    return "image";
  if (
    text.startsWith("%PDF-") ||
    /\.(?:txt|md|csv|tsv|json|pdf|docx?|xlsx?|pptx?|odt|ods)$/iu.test(name)
  )
    return "document";
  return "other";
}
