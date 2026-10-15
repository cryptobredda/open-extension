import { build } from 'esbuild';
import { mkdir, cp, writeFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
await rm('dist', { recursive: true, force: true });
await mkdir('dist/icons', { recursive: true });
await cp('public', 'dist', { recursive: true });
await build({
  entryPoints: {
    panel: 'src/panel/index.tsx',
    background: 'src/background/index.ts',
  },
  outdir: 'dist',
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'chrome138',
  minify: true,
  legalComments: 'eof',
  define: { 'process.env.NODE_ENV': '"production"' },
});
await build({
  entryPoints: ['src/content/index.ts'],
  outfile: 'dist/content.js',
  bundle: true,
  format: 'iife',
  target: 'chrome138',
  minify: true,
});
await build({
  entryPoints: ['bridge/index.ts'],
  outfile: 'dist/bridge.mjs',
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node22',
  packages: 'external',
});
// Tiny generated PNG icons, no external artwork or build-time network dependencies.
const { deflateSync } = await import('node:zlib');
const crc32 = (data) => {
  let c = 0xffffffff;
  for (const byte of data) {
    c ^= byte;
    for (let i = 0; i < 8; i++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const t = Buffer.from(type),
    size = Buffer.alloc(4),
    crc = Buffer.alloc(4);
  size.writeUInt32BE(data.length);
  crc.writeUInt32BE(crc32(Buffer.concat([t, data])));
  return Buffer.concat([size, t, data, crc]);
};
for (const size of [16, 32, 48, 128]) {
  const data = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const px = x / size,
        py = y / size;
      const a = px > 0.2 && px < 0.58 && py > 0.23 && py < 0.75 && (px < 0.29 || py < 0.32),
        b = px > 0.44 && px < 0.8 && py > 0.23 && py < 0.75 && (px > 0.7 || py > 0.66),
        dot = px > 0.2 && px < 0.29 && py > 0.66 && py < 0.75;
      const index = y * (size * 4 + 1) + 1 + x * 4;
      const color = a || b || dot ? [225, 207, 248, 255] : [29, 24, 35, 255];
      data.set(color, index);
    }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8;
  header[9] = 6;
  await writeFile(
    `dist/icons/${size}.png`,
    Buffer.concat([
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
      chunk('IHDR', header),
      chunk('IDAT', deflateSync(data)),
      chunk('IEND', Buffer.alloc(0)),
    ]),
  );
}
console.log('Built extension in dist/ and bridge at dist/bridge.mjs');
