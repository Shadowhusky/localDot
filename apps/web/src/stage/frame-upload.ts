import {
  ExtensionType,
  type GlRenderingContext,
  type GlTexture,
  glUploadImageResource,
  type TextureSource,
} from "pixi.js";

export const FRAME_UPLOAD = "video-frame";

// Uploads a decoded frame into its texture. WebKit copies a VideoFrame on the GPU only when
// texImage2D respecifies the texture; texSubImage2D, Pixi's update of a texture of the same size,
// converts it on the CPU (2560x1600 at 30 fps: about 40 % of a core). Elsewhere the update is the
// cheaper call.
export function frameUploader(reallocate: boolean) {
  return {
    extension: { type: ExtensionType.TextureUploaderWebGL, name: FRAME_UPLOAD },
    id: FRAME_UPLOAD,
    upload(source: TextureSource, glTexture: GlTexture, gl: GlRenderingContext, version: number) {
      glUploadImageResource.upload(source, glTexture, gl, version, undefined, reallocate);
    },
  };
}
