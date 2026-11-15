import type { DockerClient } from "./docker.ts";
import { SYSTEM_BASE } from "./system-migration.ts";
import { tar, untar } from "./tar.ts";

type Docker = Pick<DockerClient, "request" | "putArchive">;

const DIR = "/usr/bin";
const NAME = "Xvfb";
// The option only localDot's build of the display server has; the desktop's start script asks for
// it too. Ubuntu's own build has no such option.
const OURS = Buffer.from("-glamor");

const route = (id: string) => `/containers/${encodeURIComponent(id)}`;
const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

// The desktop draws its screen with a build of Xvfb made for localDot, which can grow to the
// computer's size. An app's install can upgrade it to Ubuntu's, which can't, and the computer then
// never starts. Before a desktop starts, a replaced one is put back from the image the computer was
// made from, or else the installed one.
export class DisplayServer {
  readonly #docker: Docker;
  readonly #installed: string;
  // Each image's build, read once; null when an image has none of localDot's.
  readonly #builds = new Map<string, Buffer | null>();

  constructor(docker: Docker, installed: string) {
    this.#docker = docker;
    this.#installed = installed;
  }

  // Never throws: a desktop whose display server can't be checked starts as it is.
  async keep(desktop: string): Promise<void> {
    try {
      if ((await this.#read(desktop))?.includes(OURS)) return;
      const container = await this.#docker.request<{
        Config?: { Labels?: Record<string, string> };
      }>({ method: "GET", path: `${route(desktop)}/json` });
      const base = container.Config?.Labels?.[SYSTEM_BASE];
      for (const image of new Set([...(base ? [base] : []), this.#installed])) {
        const build = await this.#build(image);
        if (!build) continue;
        await this.#docker.putArchive(
          desktop,
          DIR,
          tar([{ name: NAME, data: build, mode: 0o755 }]),
        );
        console.error(
          `desktop ${desktop}: an app had replaced its display server; localDot's is back`,
        );
        return;
      }
      console.error(`desktop ${desktop}: no image holds localDot's display server to put back`);
    } catch (error) {
      console.error(`desktop ${desktop}: its display server was not checked (${messageOf(error)})`);
    }
  }

  async #read(container: string): Promise<Buffer | undefined> {
    const archive = await this.#docker
      .request<Buffer>({
        method: "GET",
        path: `${route(container)}/archive`,
        query: { path: `${DIR}/${NAME}` },
        response: "buffer",
      })
      .catch(() => undefined);
    return archive && untar(archive, NAME);
  }

  async #build(image: string): Promise<Buffer | null> {
    const known = this.#builds.get(image);
    if (known !== undefined) return known;
    let build: Buffer | null = null;
    try {
      // A container made and never started: the image's own file, with nothing run.
      const made = await this.#docker.request<{ Id: string }>({
        method: "POST",
        path: "/containers/create",
        body: {
          Image: image,
          Entrypoint: ["/bin/true"],
          Cmd: [],
          NetworkDisabled: true,
          Labels: { "localdot.role": "display-server-source" },
          HostConfig: { NetworkMode: "none" },
        },
      });
      try {
        const file = await this.#read(made.Id);
        build = file?.includes(OURS) ? Buffer.from(file) : null;
      } finally {
        await this.#docker
          .request({ method: "DELETE", path: route(made.Id), query: { force: "true", v: "true" } })
          .catch(() => {});
      }
    } catch (error) {
      console.error(`image ${image}: its display server could not be read (${messageOf(error)})`);
      return null;
    }
    this.#builds.set(image, build);
    return build;
  }
}
