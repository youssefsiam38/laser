#!/usr/bin/env node
/**
 * The piorbit mark, drawn once and emitted as PNGs.
 *
 * The mark is an orbit: a ring with one body on it and a filled core. It is the
 * same shape as the rail's project ring in `packages/ui/DESIGN.md`, so the app
 * icon, the tray and the UI all say the same thing.
 *
 * Two outputs, because they have different lives:
 *   build/icon.png          the app icon electron-builder turns into .icns/.ico
 *   src/assets/icons.generated.ts  the tray images, base64 in source
 *
 * The tray images are in source rather than on disk because the tray is created
 * before anything else and must work identically in dev, inside `app.asar`, and
 * from a directory build. A path that resolves three different ways is three
 * bugs; a string is none.
 *
 * Colours come from DESIGN.md. macOS tray images are template images: pure
 * black plus alpha, which macOS re-tints for light, dark, and the highlighted
 * menu. So the tray never encodes state as colour on macOS — state is the badge
 * notch plus `tray.setTitle`.
 *
 * No canvas dependency: this rasterises with signed distance fields at 4x and
 * box-filters down, which is a page of maths and zero supply chain.
 */
import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));

const SS = 4; // supersampling factor

/** #RRGGBB -> [r,g,b]. */
function rgb(hex) {
  return [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)];
}

/**
 * Coverage of the mark at one supersampled pixel, as three layers:
 * ring, body, core. Coordinates are normalised to a unit square.
 */
function markCoverage(rawU, rawV, geometry) {
  const { ringRadius, ringWidth, bodyRadius, bodyAngle, coreRadius, gap } = geometry;
  // The mark can be scaled and nudged inside the canvas so a badge has room.
  const scale = geometry.scale ?? 1;
  const u = (rawU - (geometry.cx ?? 0.5)) / scale + 0.5;
  const v = (rawV - (geometry.cy ?? 0.5)) / scale + 0.5;
  const dx = u - 0.5;
  const dy = v - 0.5;
  const distance = Math.hypot(dx, dy);

  const bodyX = 0.5 + Math.cos(bodyAngle) * ringRadius;
  const bodyY = 0.5 + Math.sin(bodyAngle) * ringRadius;
  const bodyDistance = Math.hypot(u - bodyX, v - bodyY);

  // The ring opens up around the body so the two never merge into a blob.
  const ring =
    Math.abs(distance - ringRadius) <= ringWidth / 2 && bodyDistance > bodyRadius + gap ? 1 : 0;
  const body = bodyDistance <= bodyRadius ? 1 : 0;
  const core = distance <= coreRadius ? 1 : 0;
  return { ring, body, core };
}

/**
 * Render `size` x `size` RGBA. `palette` supplies the colour of each layer and
 * of the ground; a null ground is transparent.
 */
function render(size, palette, geometry) {
  const pixels = Buffer.alloc(size * size * 4);
  const ground = palette.ground ? rgb(palette.ground) : null;
  const layers = [
    { color: rgb(palette.ring), key: "ring", alpha: palette.ringAlpha ?? 1 },
    { color: rgb(palette.core), key: "core", alpha: palette.coreAlpha ?? 1 },
    { color: rgb(palette.body), key: "body", alpha: palette.bodyAlpha ?? 1 },
  ];

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      // Accumulate premultiplied colour so an anti-aliased edge over
      // transparency keeps its hue instead of darkening towards black.
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      let groundCoverage = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const u = (x + (sx + 0.5) / SS) / size;
          const v = (y + (sy + 0.5) / SS) / size;
          const coverage = markCoverage(u, v, geometry);
          let sampleR = 0;
          let sampleG = 0;
          let sampleB = 0;
          let sampleA = 0;
          if (ground && insideSquircle(u, v, geometry.squircle)) {
            sampleR = ground[0];
            sampleG = ground[1];
            sampleB = ground[2];
            sampleA = 1;
            groundCoverage++;
          }
          for (const layer of layers) {
            if (!coverage[layer.key]) continue;
            const la = layer.alpha;
            sampleR = layer.color[0] * la + sampleR * (1 - la);
            sampleG = layer.color[1] * la + sampleG * (1 - la);
            sampleB = layer.color[2] * la + sampleB * (1 - la);
            sampleA = la + sampleA * (1 - la);
          }
          r += sampleR * sampleA;
          g += sampleG * sampleA;
          b += sampleB * sampleA;
          a += sampleA;
        }
      }
      const samples = SS * SS;
      const alpha = a / samples;
      const offset = (y * size + x) * 4;
      pixels[offset] = alpha > 0 ? Math.round(r / samples / alpha) : 0;
      pixels[offset + 1] = alpha > 0 ? Math.round(g / samples / alpha) : 0;
      pixels[offset + 2] = alpha > 0 ? Math.round(b / samples / alpha) : 0;
      pixels[offset + 3] = Math.round(alpha * 255);
      void groundCoverage;
    }
  }
  return pixels;
}

/** A rounded square in the Apple manner: |x|^n + |y|^n <= r^n. */
function insideSquircle(u, v, squircle) {
  if (!squircle) return true;
  const dx = Math.abs(u - 0.5) / squircle.radius;
  const dy = Math.abs(v - 0.5) / squircle.radius;
  return dx ** squircle.exponent + dy ** squircle.exponent <= 1;
}

// ---------------------------------------------------------------- PNG ----

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

function encodePng(size, pixels) {
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // filter: none
    pixels.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// ------------------------------------------------------------ recipes ----

const APP_GEOMETRY = {
  ringRadius: 0.3,
  ringWidth: 0.052,
  bodyRadius: 0.082,
  bodyAngle: -Math.PI / 3.2,
  coreRadius: 0.086,
  gap: 0.026,
  squircle: { radius: 0.5, exponent: 5 },
};

// The tray mark is heavier: at 16 px a hairline ring disappears.
const TRAY_GEOMETRY = {
  ringRadius: 0.29,
  ringWidth: 0.11,
  bodyRadius: 0.13,
  bodyAngle: -Math.PI / 3.2,
  coreRadius: 0.1,
  gap: 0.04,
  squircle: null,
};

const APP_PALETTE = { ground: "#0B0F14", ring: "#4DA3FF", core: "#4DA3FF", body: "#4DA3FF", ringAlpha: 0.55 };
/** macOS template: black + alpha only; the system tints it. */
const TEMPLATE_PALETTE = { ground: null, ring: "#000000", core: "#000000", body: "#000000", ringAlpha: 0.62 };

const outputs = [];

// App icon. 1024 so electron-builder can make every .icns/.ico size from it.
outputs.push({ path: join(packageRoot, "build", "icon.png"), size: 1024, palette: APP_PALETTE, geometry: APP_GEOMETRY });
// Linux wants a size set; electron-builder picks these up from build/icons.
for (const size of [512, 256, 128, 64, 48, 32, 16]) {
  outputs.push({
    path: join(packageRoot, "build", "icons", `${size}x${size}.png`),
    size,
    palette: APP_PALETTE,
    geometry: APP_GEOMETRY,
  });
}

for (const output of outputs) {
  mkdirSync(dirname(output.path), { recursive: true });
  writeFileSync(output.path, encodePng(output.size, render(output.size, output.palette, output.geometry)));
}

/**
 * Tray images. `idle` is the mark; `attention` adds a notch out of the
 * lower-right so a badge can sit there without the mark showing through — the
 * same trick a macOS badge uses, and the only state a template image can carry.
 */
function trayImage(size, palette, badge) {
  // With a badge the mark steps back and up-left so the badge sits clear of it
  // instead of eating the ring.
  const geometry = badge ? { ...TRAY_GEOMETRY, scale: 0.84, cx: 0.44, cy: 0.44 } : { ...TRAY_GEOMETRY };
  const pixels = render(size, palette, geometry);
  if (!badge) return pixels;
  const cx = size * 0.78;
  const cy = size * 0.78;
  const cut = size * 0.29;
  const dot = size * 0.2;
  const [r, g, b] = rgb(palette.badge ?? palette.body);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const distance = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
      const offset = (y * size + x) * 4;
      if (distance <= cut) pixels[offset + 3] = 0;
      if (distance <= dot) {
        pixels[offset] = r;
        pixels[offset + 1] = g;
        pixels[offset + 2] = b;
        pixels[offset + 3] = 255;
      }
    }
  }
  return pixels;
}

/**
 * macOS gets template images and re-tints them. Windows and Linux do not: a
 * black mark disappears on a dark taskbar, so those platforms get the coloured
 * mark, with the badge in DESIGN.md's `--attention` amber — which means the
 * tray says "needs you" in the same hue as everything else in the app.
 */
const COLOUR_PALETTE = {
  ground: null,
  ring: "#4DA3FF",
  core: "#4DA3FF",
  body: "#4DA3FF",
  badge: "#F5B849",
  ringAlpha: 0.72,
};

const trayVariants = {
  trayIdle: { palette: TEMPLATE_PALETTE, badge: false },
  trayAttention: { palette: TEMPLATE_PALETTE, badge: true },
  trayColourIdle: { palette: COLOUR_PALETTE, badge: false },
  trayColourAttention: { palette: COLOUR_PALETTE, badge: true },
};

const lines = [];
lines.push("/**");
lines.push(" * Generated by scripts/make-icons.mjs — do not edit by hand.");
lines.push(" *");
lines.push(" * Tray images as base64 PNGs, 1x and 2x. They live in source so the tray");
lines.push(" * behaves identically in dev, inside app.asar, and in a directory build:");
lines.push(" * a string has no path to resolve. macOS treats these as template images");
lines.push(" * (black + alpha) and tints them itself.");
lines.push(" */");
for (const [name, variant] of Object.entries(trayVariants)) {
  for (const [suffix, size] of [
    ["", 16],
    ["2x", 32],
    ["3x", 48],
  ]) {
    const png = encodePng(size, trayImage(size, variant.palette, variant.badge));
    lines.push(`export const ${name}${suffix} = ${JSON.stringify(png.toString("base64"))};`);
  }
}
lines.push("");

const generated = join(packageRoot, "src", "assets", "icons.generated.ts");
mkdirSync(dirname(generated), { recursive: true });
writeFileSync(generated, `${lines.join("\n")}\n`);

process.stdout.write(
  `piorbit icons: build/icon.png, build/icons/*.png, src/assets/icons.generated.ts\n`,
);
