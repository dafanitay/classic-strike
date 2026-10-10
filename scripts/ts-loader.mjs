import { transform } from 'esbuild';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export async function resolve(specifier, context, next) {
  if ((specifier.startsWith('.') || specifier.startsWith('/')) && !/\.[cm]?[jt]s$/.test(specifier) && context.parentURL?.startsWith('file:')) {
    const url = new URL(specifier + '.ts', context.parentURL);
    if (existsSync(fileURLToPath(url))) return { url: url.href, shortCircuit: true };
  }
  return next(specifier, context);
}

export async function load(url, context, next) {
  if (url.endsWith('.ts')) {
    const src = await readFile(fileURLToPath(url), 'utf8');
    const out = await transform(src, { loader: 'ts', format: 'esm', target: 'node22', sourcemap: 'inline', sourcefile: fileURLToPath(url) });
    return { format: 'module', source: out.code, shortCircuit: true };
  }
  return next(url, context);
}
