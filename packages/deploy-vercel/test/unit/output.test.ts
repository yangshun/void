import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vite-plus/test';
import { listStaticFiles, writeVercelOutput, type VercelConfig } from '../../src/index.ts';

const dirs: Array<string> = [];

function fixture(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'void-vercel-output-'));
  dirs.push(root);
  for (const [path, contents] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), contents);
  }
  return root;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

const config: VercelConfig = { version: 3, routes: [{ handle: 'filesystem' }] };

describe('listStaticFiles', () => {
  it('lists public files and leaves out build metadata and Void routing files', () => {
    const root = fixture({
      'dist/client/index.html': '',
      'dist/client/assets/app.js': '',
      'dist/client/.vite/manifest.json': '{}',
      'dist/client/_headers': '',
      'dist/client/_redirects': '',
    });
    expect(listStaticFiles(join(root, 'dist/client'))).toEqual(['/assets/app.js', '/index.html']);
  });
});

describe('writeVercelOutput', () => {
  it('writes static files, config.json and a self-contained function', async () => {
    const root = fixture({
      'dist/client/index.html': '<h1>home</h1>',
      'dist/client/404.html': '<h1>missing</h1>',
      'dist/client/.vite/manifest.json': '{"entry":{"file":"assets/app.js"}}',
      'dist/client/_redirects': '/a /b',
      'dist/ssr/app.js': [
        "import { readFileSync } from 'node:fs';",
        "import { message } from './assets/shared.js';",
        // The trace reads this as the whole client build, which must stay out.
        "const clientRoot = new URL('../client/', import.meta.url);",
        "const manifest = new URL('.vite/manifest.json', clientRoot);",
        'export default { fetch: () => new Response(message + readFileSync(manifest, "utf8")) };',
      ].join('\n'),
      'dist/ssr/assets/shared.js': "export const message = 'hello ';",
      'dist/ssr/assets/lazy.js': 'export const lazy = 1;',
      // The app's own package.json says CommonJS; the function must still load ESM.
      'package.json': '{ "name": "app" }',
    });
    const outputDir = join(root, '.vercel/output');
    // A stale file from an earlier build must not survive.
    mkdirSync(join(outputDir, 'static'), { recursive: true });
    writeFileSync(join(outputDir, 'static/stale.txt'), 'old');

    await writeVercelOutput({
      outputDir,
      clientDir: join(root, 'dist/client'),
      config,
      function: {
        entry: join(root, 'dist/ssr/app.js'),
        serverDir: join(root, 'dist/ssr'),
        clientDir: join(root, 'dist/client'),
        clientFiles: ['.vite/manifest.json', '404.html'],
        runtime: 'nodejs24.x',
        regions: ['iad1'],
        maxDuration: 60,
      },
    });

    expect(listStaticFiles(join(outputDir, 'static'))).toEqual(['/404.html', '/index.html']);
    expect(existsSync(join(outputDir, 'static/.vite'))).toBe(false);
    expect(JSON.parse(readFileSync(join(outputDir, 'config.json'), 'utf8'))).toEqual(config);

    const funcDir = join(outputDir, 'functions/__void.func');
    const vcConfig = JSON.parse(readFileSync(join(funcDir, '.vc-config.json'), 'utf8'));
    expect(vcConfig).toEqual({
      runtime: 'nodejs24.x',
      // Paths keep their layout under the files' common directory (the app root,
      // since the trace includes its package.json).
      handler: 'dist/ssr/app.js',
      launcherType: 'Nodejs',
      shouldAddHelpers: false,
      supportsResponseStreaming: true,
      maxDuration: 60,
      regions: ['iad1'],
    });
    expect(existsSync(join(funcDir, 'dist/ssr/assets/lazy.js'))).toBe(true);
    expect(existsSync(join(funcDir, 'dist/client/404.html'))).toBe(true);
    expect(existsSync(join(funcDir, 'dist/client/index.html'))).toBe(false);

    // Load the function from a copy outside the fixture, as Vercel does.
    const copy = mkdtempSync(join(tmpdir(), 'void-vercel-func-'));
    dirs.push(copy);
    const { cpSync } = await import('node:fs');
    cpSync(funcDir, copy, { recursive: true });
    const handler = await import(pathToFileURL(join(copy, vcConfig.handler)).href);
    const response: Response = await handler.default.fetch(new Request('https://example.com/'));
    expect(await response.text()).toBe('hello {"entry":{"file":"assets/app.js"}}');
  });

  it('writes static output without a function', async () => {
    const root = fixture({ 'dist/client/index.html': '' });
    const outputDir = join(root, '.vercel/output');
    await writeVercelOutput({ outputDir, clientDir: join(root, 'dist/client'), config });
    expect(existsSync(join(outputDir, 'functions'))).toBe(false);
    expect(existsSync(join(outputDir, 'static/index.html'))).toBe(true);
  });
});
