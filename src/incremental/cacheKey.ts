import fs from 'fs';
import path from 'path';
import { createHash } from 'crypto';
import { CACHE_FORMAT } from './CacheStore';

export function fileStamp(file: string): string {
  const stat = fs.statSync(file);
  return `${stat.size}:${stat.mtimeMs}`;
}

function listFiles(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      listFiles(full, out);
    } else if (/\.(c|m)?(js|ts)$/.test(entry.name)) {
      // compiled files, or sources when run with a TypeScript loader
      out.push(full);
    }
  }
  return out.sort();
}

/**
 * Identifies the SUSHI build that is running: its version, the files it is made of (compiled, or
 * TypeScript sources when it runs from them), and the Node.js version running it. Parsed FSH is
 * reusable only by the same build.
 */
export function toolKey(sushiVersion: string): string {
  const hash = createHash('sha256');
  hash.update(`${CACHE_FORMAT}\n${sushiVersion}\n${process.version}\n`);
  const distDir = path.resolve(__dirname, '..');
  for (const file of listFiles(distDir)) {
    hash.update(`${path.relative(distDir, file)}:${fileStamp(file)}\n`);
  }
  return hash.digest('base64url');
}
