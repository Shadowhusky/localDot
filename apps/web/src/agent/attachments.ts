export { splitAttachments, withAttachments } from "@localdot/protocol";

export function fileName(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1) || path;
}
