import { homedir } from "node:os";
import { join } from "node:path";

export function localdotHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.LOCALDOT_HOME || join(homedir(), ".localdot");
}
