import { cp, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * `tsc` emits JavaScript and nothing else, so the window's HTML and CSS and the tray icons have to be
 * carried into `dist/` separately. Node rather than `cp -r`, because a contributor on Windows should be
 * able to run `npm run build`.
 */
const root = join(dirname(fileURLToPath(import.meta.url)), '..');

await mkdir(join(root, 'dist/renderer'), { recursive: true });

await Promise.all([
  cp(join(root, 'src/renderer/index.html'), join(root, 'dist/renderer/index.html')),
  cp(join(root, 'src/renderer/styles.css'), join(root, 'dist/renderer/styles.css')),
  cp(join(root, 'assets'), join(root, 'dist/assets'), { recursive: true }),
]);
