// Where everything stands in each cover, in the cover's own pixels. A dot's x and y are the middle of its
// foot; z orders the layers, the laptop at 5 and the phone at 8.
const PHONE = "ui/phone-list.png";
const STUDIO = "ui/studio-landlord.png";
const SHINE = { o: 0.14, b: 3, fade: "38%" };
const GLASS = { o: 0.08, b: 5, fade: "16%" };

const shift = (items, dx, dy) => items.map((i) => ({ ...i, x: i.x + dx, y: i.y + dy }));

// The phone stands over Studio's chat, which it shows itself, so Postbox on the stage is left whole.
const DOUYIN = [
  { kind: "shadow", x: 508, y: 1360, w: 940, h: 50, blur: 12 },
  { kind: "laptop", x: 110, y: 770, w: 760, z: 5, src: STUDIO },
  { kind: "dot", name: "researcher", x: 578, y: 820, k: 0.19, r: -5, z: 3 },
  { kind: "dot", name: "everyday", x: 704, y: 836, k: 0.2, r: -3, z: 3 },
  { kind: "dot", name: "video", x: 824, y: 824, k: 0.19, r: 7, z: 3 },
  { kind: "shadow", x: 808, y: 1494, w: 360, h: 34, blur: 8, z: 6 },
  { kind: "phone", x: 656, y: 862, w: 280, z: 8, src: PHONE, mirror: GLASS },
  { kind: "shadow", x: 566, y: 1522, w: 200, h: 30, z: 7 },
  { kind: "dot", name: "designer", x: 566, y: 1526, k: 0.245, r: 11, z: 9 },
  { kind: "shadow", x: 390, y: 1550, w: 220, h: 32, z: 9 },
  { kind: "dot", name: "coder", x: 390, y: 1552, k: 0.26, z: 10, mirror: SHINE },
  { kind: "shadow", x: 214, y: 1534, w: 210, h: 30, z: 8 },
  { kind: "dot", name: "finance", x: 214, y: 1536, k: 0.25, r: -3, z: 9, mirror: SHINE },
];

export const FORMATS = {
  douyin: {
    w: 1080,
    h: 1920,
    vars: {
      "--horizon": "1180px",
      "--floor-fade": "200px",
      "--pool-x": "520px",
      "--pool-y": "360px",
      "--pool-w": "820px",
      "--pool-h": "300px",
      "--glow-x": "600px",
      "--glow-y": "780px",
      "--glow-w": "640px",
      "--glow-h": "420px",
    },
    type: { zh: { x: 120, y: 330, mark: 48, gap: 24, size: 118 } },
    items: DOUYIN,
    guides: [[108, 326, 972, 1498]],
  },
  rednote: {
    w: 1080,
    h: 1440,
    vars: {
      "--horizon": "915px",
      "--floor-fade": "200px",
      "--pool-x": "520px",
      "--pool-y": "360px",
      "--pool-w": "820px",
      "--pool-h": "280px",
      "--glow-x": "600px",
      "--glow-y": "515px",
      "--glow-w": "640px",
      "--glow-h": "420px",
    },
    type: { zh: { x: 120, y: 100, mark: 48, gap: 24, size: 118 } },
    items: shift(DOUYIN, 0, -265),
  },
  landscape: {
    w: 1920,
    h: 1080,
    vars: {
      "--horizon": "700px",
      "--floor-fade": "150px",
      "--pool-x": "1340px",
      "--pool-y": "250px",
      "--pool-w": "900px",
      "--pool-h": "230px",
      "--glow-x": "1360px",
      "--glow-y": "320px",
      "--glow-w": "720px",
      "--glow-h": "400px",
    },
    type: {
      zh: { x: 128, y: 362, mark: 48, gap: 22, size: 120 },
      en: { x: 128, y: 384, mark: 48, gap: 24, size: 86 },
    },
    items: [
      { kind: "shadow", x: 1368, y: 832, w: 960, h: 46, blur: 12 },
      { kind: "laptop", x: 970, y: 232, w: 760, z: 5, src: STUDIO },
      { kind: "dot", name: "researcher", x: 1250, y: 284, k: 0.18, r: -5, z: 3 },
      { kind: "dot", name: "everyday", x: 1388, y: 300, k: 0.19, r: -3, z: 3 },
      { kind: "dot", name: "video", x: 1524, y: 288, k: 0.19, r: 7, z: 3 },
      { kind: "shadow", x: 1668, y: 932, w: 340, h: 30, blur: 8, z: 6 },
      { kind: "phone", x: 1516, y: 300, w: 280, z: 8, src: PHONE, mirror: GLASS },
      { kind: "shadow", x: 1446, y: 946, w: 186, h: 28, z: 7 },
      { kind: "dot", name: "designer", x: 1446, y: 950, k: 0.22, r: 11, z: 9 },
      { kind: "shadow", x: 1286, y: 960, w: 204, h: 30, z: 9 },
      { kind: "dot", name: "coder", x: 1286, y: 962, k: 0.235, z: 10, mirror: SHINE },
      { kind: "shadow", x: 1104, y: 950, w: 196, h: 28, z: 8 },
      { kind: "dot", name: "finance", x: 1104, y: 952, k: 0.225, r: -3, z: 9, mirror: SHINE },
    ],
  },
};
