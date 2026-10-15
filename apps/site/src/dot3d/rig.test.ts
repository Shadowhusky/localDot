import { type DirectionalLight, PerspectiveCamera, Scene, Vector3 } from "three";
import { describe, expect, it } from "vitest";
import { centreRig, studioLights } from "./rig.ts";

// The key panel's place in the plates' rig, in three.js axes.
const KEY = new Vector3(-3.2, 3.4, 4.2).normalize();

function keyDirection(cameraDistance: number, target: Vector3): Vector3 {
  const scene = new Scene();
  const camera = new PerspectiveCamera(30, 1, 0.05, 200);
  camera.position.set(0, 0, cameraDistance);
  camera.lookAt(0, 0, 0);
  scene.add(camera);
  const rig = studioLights();
  camera.add(rig);
  scene.updateMatrixWorld();
  centreRig(rig, camera, target);
  scene.updateMatrixWorld();
  const key = rig.children[0] as DirectionalLight;
  return key.getWorldPosition(new Vector3()).sub(target).normalize();
}

describe("centreRig", () => {
  it("lights dot from the plates' angle however far the camera stands", () => {
    for (const distance of [4, 12, 40]) {
      const direction = keyDirection(distance, new Vector3(0.6, -0.3, 0));
      expect(direction.distanceTo(KEY)).toBeLessThan(1e-6);
    }
  });
});
