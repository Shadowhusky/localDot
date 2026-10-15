import {
  type Camera,
  Color,
  DirectionalLight,
  DoubleSide,
  Group,
  Mesh,
  MeshBasicMaterial,
  PlaneGeometry,
  PMREMGenerator,
  Scene,
  type Texture,
  type Vector3,
  type WebGLRenderer,
} from "three";

// The plates' light rig (tools/dot-plates/plates.json), as glowing panels around dot for image-based
// light. Blender's (x, y, z) with z up and the camera toward -y is (x, z, -y) here.
interface Panel {
  at: [number, number, number];
  size: [number, number];
  power: number;
  color: [number, number, number];
}

const RIG: Record<string, Panel> = {
  key: { at: [-3.2, -4.2, 3.4], size: [7, 5], power: 560, color: [1, 1, 1] },
  fill: { at: [5, -3, 0.4], size: [6, 6], power: 170, color: [0.97, 0.985, 1] },
  rim: { at: [0, 7, 3.4], size: [9, 3], power: 1500, color: [0.96, 0.98, 1] },
  top: { at: [0, 0.6, 5], size: [4, 4], power: 40, color: [1, 1, 1] },
  bounce: { at: [0, -2.4, -3.6], size: [7, 2.5], power: 140, color: [0.96, 0.975, 1] },
};

// dot's xenon rim and kick while it has control, as lights from behind (the same Blender spots).
export const XENON_LIGHTS = [
  { at: [2.4, 1.2, -6.6] as const, power: 1700 },
  { at: [-2.6, -2.4, -5.6] as const, power: 500 },
];
export const XENON_COLOUR = new Color(0.05, 0.46, 0.73);

const WORLD = new Color(0.01, 0.0105, 0.012);

// Radiance per watt per square metre, tuned so the lit crown and the shaded foot match the plates.
const GAIN = 0.14;

function panels(scene: Scene, rig: Record<string, Panel>, gain: number): void {
  for (const panel of Object.values(rig)) {
    const [bx, by, bz] = panel.at;
    const area = panel.size[0] * panel.size[1];
    const radiance = (panel.power / area) * gain;
    const mesh = new Mesh(
      new PlaneGeometry(panel.size[0], panel.size[1]),
      new MeshBasicMaterial({
        color: new Color(...panel.color).multiplyScalar(radiance),
        side: DoubleSide,
      }),
    );
    mesh.position.set(bx, bz, -by);
    mesh.lookAt(0, 0, 0);
    scene.add(mesh);
  }
}

// The neutral rig, prefiltered for image-based light.
export function studioLight(
  renderer: WebGLRenderer,
  gain = GAIN,
): { texture: Texture; dispose(): void } {
  const pmrem = new PMREMGenerator(renderer);
  const scene = new Scene();
  scene.background = WORLD;
  panels(scene, RIG, gain);
  const target = pmrem.fromScene(scene, 0.02);
  for (const child of scene.children) {
    if (child instanceof Mesh) {
      child.geometry.dispose();
      (child.material as MeshBasicMaterial).dispose();
    }
  }
  pmrem.dispose();
  return { texture: target.texture, dispose: () => target.dispose() };
}

// The rig's panels as direct lights too, for the plates' modelling: light from the upper left and
// in front, a cool fill on the right, a rim from behind and a little bounce from below.
const DIRECT: Record<string, number> = { key: 3, fill: 1, rim: 1.8, top: 0.35, bounce: 1 };

export function studioLights(levels: Partial<Record<string, number>> = {}): Group {
  const group = new Group();
  for (const [name, panel] of Object.entries(RIG)) {
    const [bx, by, bz] = panel.at;
    const light = new DirectionalLight(
      new Color(...panel.color),
      levels[name] ?? DIRECT[name] ?? 0,
    );
    light.position.set(bx, bz, -by);
    group.add(light);
  }
  return group;
}

// Puts the rig, riding in `camera`, on `target`, so its lights fall on dot there from the angles of
// its portraits, however far away the camera is.
export function centreRig(rig: Group, camera: Camera, target: Vector3): void {
  rig.position.copy(camera.worldToLocal(target.clone()));
}
