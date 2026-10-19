// Zips the extension (manifest + src/) into dist/ for sharing or Chrome Web Store upload.
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';

const { version } = JSON.parse(readFileSync('manifest.json', 'utf8'));
const out = `dist/seo-lens-${version}.zip`;
mkdirSync('dist', { recursive: true });
rmSync(out, { force: true });
execFileSync('zip', ['-rq', out, 'manifest.json', 'src', '-x', '*.DS_Store'], { stdio: 'inherit' });
console.log(`wrote ${out}`);
