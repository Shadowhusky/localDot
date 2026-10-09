import type { GlRenderingContext, GlTexture, TextureSource } from "pixi.js";
import { describe, expect, it, vi } from "vitest";
import { frameUploader } from "./frame-upload.ts";

function upload(reallocate: boolean) {
  const gl = { TEXTURE_2D: 3553, texImage2D: vi.fn(), texSubImage2D: vi.fn() };
  const glTexture = {
    width: 2560,
    height: 1600,
    target: 3553,
    format: 1,
    type: 2,
    internalFormat: 3,
  };
  const frame = {};
  const source = {
    pixelWidth: 2560,
    pixelHeight: 1600,
    resourceWidth: 2560,
    resourceHeight: 1600,
    resource: frame,
  };
  frameUploader(reallocate).upload(
    source as unknown as TextureSource,
    glTexture as unknown as GlTexture,
    gl as unknown as GlRenderingContext,
    2,
  );
  return { gl, frame };
}

describe("frameUploader", () => {
  it("respecifies the texture with each frame where WebKit copies only that way on the GPU", () => {
    const { gl, frame } = upload(true);
    expect(gl.texSubImage2D).not.toHaveBeenCalled();
    expect(gl.texImage2D).toHaveBeenCalledWith(3553, 0, 3, 2560, 1600, 0, 1, 2, frame);
  });

  it("updates a texture of the same size in place elsewhere", () => {
    const { gl, frame } = upload(false);
    expect(gl.texImage2D).not.toHaveBeenCalled();
    expect(gl.texSubImage2D).toHaveBeenCalledWith(3553, 0, 0, 0, 1, 2, frame);
  });
});
