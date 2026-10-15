import { Wearable } from "@localdot/protocol";
import {
  type Camera,
  type Group,
  type Material,
  type MeshPhysicalMaterial,
  type Object3D,
  Scene,
  type Texture,
  TextureLoader,
  type WebGLRenderer,
} from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";

// What sits on the face and turns with it, as the app's glasses and mustache do.
export const ON_FACE: ReadonlySet<Wearable> = new Set(["round-glasses", "sunglasses", "mustache"]);

const MODELS = `${import.meta.env.BASE_URL}models`;
const gltf = new GLTFLoader();
const textures = new TextureLoader();
const scenes = new Map<Wearable, Promise<Group | null>>();
const shadows = new Map<Wearable, Promise<Texture | null>>();
// What has arrived, so a dot can put it on within the frame that asks.
const loadedScenes = new Map<Wearable, Group>();
const loadedShadows = new Map<Wearable, Texture>();

// Each wearable's model, loaded once; every dot that wears it gets its own copy of the scene graph,
// sharing geometry and materials.
export function wearable(name: Wearable): Promise<Object3D | null> {
  let pending = scenes.get(name);
  if (!pending) {
    pending = gltf
      .loadAsync(`${MODELS}/wear-${name}.glb`)
      .then((loaded) => {
        const scene = clearGlass(loaded.scene);
        loadedScenes.set(name, scene);
        return scene;
      })
      .catch(() => null);
    scenes.set(name, pending);
  }
  return pending.then((scene) => scene?.clone(true) ?? null);
}

export function loadedWearable(name: Wearable): Object3D | null {
  return loadedScenes.get(name)?.clone(true) ?? null;
}

export function loadedShadow(name: Wearable): Texture | null {
  return loadedShadows.get(name) ?? null;
}

// Transmissive glass makes three.js draw the whole scene again every frame, untoned, which also needs
// a second shader for everything else in it. Over dot's white face a faint blend looks the same.
function clearGlass(scene: Group): Group {
  scene.traverse((node) => {
    const material = (node as { material?: MeshPhysicalMaterial }).material;
    if (!material?.transmission) return;
    material.transmission = 0;
    material.transparent = true;
    material.opacity = 0.14;
    material.depthWrite = false;
  });
  return scene;
}

// Every wearable's model and shade, loaded once.
export function loadWardrobe(): Promise<[Object3D | null, Texture | null][]> {
  return Promise.all(
    Wearable.options.map((name) => Promise.all([wearable(name), wearableShadow(name)])),
  );
}

// Loads every wearable and readies its textures and shaders for `target`'s lights, so a dot putting
// one on never stalls a frame.
export async function warmWardrobe(
  renderer: WebGLRenderer,
  camera: Camera,
  target: Scene,
): Promise<void> {
  const shelf = new Scene();
  const loaded = await loadWardrobe();
  for (const [item, shade] of loaded) {
    if (item) shelf.add(item);
    if (shade) renderer.initTexture(shade);
  }
  shelf.traverse((node) => {
    const material = (node as { material?: Material | Material[] }).material;
    for (const m of [material ?? []].flat())
      for (const value of Object.values(m))
        if ((value as Texture | null)?.isTexture) renderer.initTexture(value as Texture);
  });
  await renderer.compileAsync(shelf, camera, target);
}

// The shade a wearable casts on dot's body, in the body's longitude/latitude texture space.
export function wearableShadow(name: Wearable): Promise<Texture | null> {
  let pending = shadows.get(name);
  if (!pending) {
    pending = textures
      .loadAsync(`${MODELS}/shadow-${name}.webp`)
      // A linear factor, read as stored.
      .then((texture) => {
        loadedShadows.set(name, texture);
        return texture;
      })
      .catch(() => null);
    shadows.set(name, pending);
  }
  return pending;
}
