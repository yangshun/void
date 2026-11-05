import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import spawn from 'cross-spawn';
import { afterAll, beforeAll, describe, expect, it } from 'vite-plus/test';
import {
  createIsolatedPlayground,
  type IsolatedPlayground,
} from '../../../../test/integration-helpers.ts';

const ROOT = join(import.meta.dirname, '..', '..', '..', '..');

function build(root: string): void {
  const result = spawn.sync('vp', ['build'], {
    cwd: root,
    encoding: 'utf8',
    timeout: 90_000,
    maxBuffer: 10 * 1024 * 1024,
  });
  expect(result.status, `${result.stdout ?? ''}${result.stderr ?? ''}`).toBe(0);
}

function readJson<T = Record<string, unknown>>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

type FunctionResponse = { status: number; headers: Record<string, string>; body: string };

/**
 * Copy the function out of the workspace, so it cannot resolve the app's
 * node_modules, and send requests to its handler in a fresh Node process.
 */
function requestFunction(
  funcDir: string,
  requests: Array<{ path: string; method?: string; headers?: Record<string, string> }>,
  env: Record<string, string> = {},
): { responses: Array<FunctionResponse>; stdout: string } {
  const copy = mkdtempSync(join(tmpdir(), 'void-vercel-func-'));
  try {
    cpSync(funcDir, copy, { recursive: true });
    const { handler } = readJson<{ handler: string }>(join(copy, '.vc-config.json'));
    const script = `
const { default: handler } = await import(${JSON.stringify(`./${handler}`)});
const results = [];
for (const r of ${JSON.stringify(requests)}) {
  const tasks = [];
  const res = await handler.fetch(
    new Request('https://app.example.com' + r.path, { method: r.method ?? 'GET', headers: r.headers }),
    { waitUntil: (promise) => tasks.push(promise) },
  );
  await Promise.all(tasks);
  results.push({ status: res.status, headers: Object.fromEntries(res.headers), body: await res.text() });
}
process.stdout.write('\\n__RESULTS__' + JSON.stringify(results));
`;
    writeFileSync(join(copy, 'run.mjs'), script);
    const result = spawn.sync('node', ['run.mjs'], {
      cwd: copy,
      encoding: 'utf8',
      timeout: 30_000,
      env: { PATH: process.env.PATH ?? '', ...env },
    });
    expect(result.status, `${result.stdout ?? ''}${result.stderr ?? ''}`).toBe(0);
    const [stdout, json] = (result.stdout ?? '').split('\n__RESULTS__');
    return { responses: JSON.parse(json!) as Array<FunctionResponse>, stdout: stdout ?? '' };
  } finally {
    rmSync(copy, { recursive: true, force: true });
  }
}

describe('target vercel: server app', () => {
  let playground: IsolatedPlayground;
  let output: string;

  beforeAll(() => {
    playground = createIsolatedPlayground(ROOT, 'playground/node-app');
    const { root } = playground;
    writeFileSync(
      join(root, 'void.config.ts'),
      `import { defineConfig } from 'void/config';

export default defineConfig({
  target: 'vercel',
  vercel: { regions: ['iad1'], maxDuration: 30 },
  head: { titleTemplate: '%s | Node App' },
  routing: {
    redirects: { '/old-about': { to: '/about', status: 308 } },
    rewrites: { '/brand': '/logo.svg' },
    headers: { '/*': ['X-Frame-Options: DENY'] },
  },
});
`,
    );
    mkdirSync(join(root, 'public'), { recursive: true });
    writeFileSync(join(root, 'public', 'logo.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
    writeFileSync(join(root, 'public', 'legal.html'), '<h1>Legal</h1>');
    mkdirSync(join(root, 'middleware'), { recursive: true });
    writeFileSync(
      join(root, 'middleware', '01.marker.ts'),
      `import { defineMiddleware } from 'void';

export default defineMiddleware(async (c, next) => {
  await next();
  c.res.headers.set('x-void-middleware', '1');
});
`,
    );
    writeFileSync(
      join(root, 'routes', 'api', 'later.ts'),
      `import { defineHandler } from 'void';

export const GET = defineHandler((c) => {
  c.executionCtx.waitUntil(Promise.resolve().then(() => console.log('VOID_WAIT_UNTIL_RAN')));
  return c.json({ queued: true });
});
`,
    );
    mkdirSync(join(root, 'crons'), { recursive: true });
    writeFileSync(
      join(root, 'crons', 'daily.ts'),
      `import { defineScheduled } from 'void';

export const cron = '0 5 * * *';

export default defineScheduled(async (controller) => {
  console.log('VOID_CRON_RAN ' + controller.cron);
});
`,
    );
    build(root);
    output = join(root, '.vercel', 'output');
  }, 120_000);

  afterAll(() => {
    playground?.cleanup();
  });

  it('writes static files without build metadata', () => {
    expect(existsSync(join(output, 'static', 'logo.svg'))).toBe(true);
    expect(existsSync(join(output, 'static', 'legal.html'))).toBe(true);
    expect(existsSync(join(output, 'static', '.vite'))).toBe(false);
  });

  it('writes routes for redirects, rewrites, static headers and the function', () => {
    const config = readJson<{
      routes: Array<Record<string, unknown>>;
      overrides: Record<string, { path: string }>;
      crons: Array<{ path: string; schedule: string }>;
    }>(join(output, 'config.json'));
    expect(config.routes).toContainEqual({
      src: '^/old-about$',
      status: 308,
      headers: { Location: '/about' },
      methods: ['GET', 'HEAD'],
    });
    expect(config.routes).toContainEqual({ src: '^/brand$', dest: '/logo.svg' });
    expect(config.routes).toContainEqual({ src: '^/.*$', dest: '/__void' });
    expect(config.overrides).toEqual({ 'legal.html': { path: 'legal' } });
    expect(config.crons).toEqual([{ path: '/__void/cron', schedule: '0 5 * * *' }]);

    const hit = config.routes.slice(config.routes.findIndex((route) => route.handle === 'hit'));
    const immutable = hit.find(
      (route) =>
        (route.headers as Record<string, string> | undefined)?.['cache-control'] ===
        'public, max-age=31536000, immutable',
    );
    expect(immutable?.src).toMatch(/assets\/pages-client-/);
    expect(hit).toContainEqual({
      src: '^(?:/legal|/logo\\.svg)$',
      headers: { 'x-frame-options': 'DENY' },
      continue: true,
    });
  });

  it('configures the function from the vercel settings', () => {
    const vcConfig = readJson(join(output, 'functions', '__void.func', '.vc-config.json'));
    expect(vcConfig).toMatchObject({
      launcherType: 'Nodejs',
      supportsResponseStreaming: true,
      regions: ['iad1'],
      maxDuration: 30,
    });
    expect(vcConfig.runtime).toMatch(/^nodejs\d+\.x$/);
  });

  it('runs routes, pages, middleware, waitUntil and crons without node_modules', () => {
    const { responses, stdout } = requestFunction(
      join(output, 'functions', '__void.func'),
      [
        { path: '/api/hello' },
        { path: '/', headers: { accept: 'text/html' } },
        { path: '/api/later' },
        {
          path: '/__void/cron',
          headers: { authorization: 'Bearer test-secret', 'x-vercel-cron-schedule': '0 5 * * *' },
        },
        { path: '/__void/cron', headers: { 'x-vercel-cron-schedule': '0 5 * * *' } },
      ],
      { CRON_SECRET: 'test-secret' },
    );
    const [hello, home, later, cron, unauthorized] = responses;

    expect(hello!.status).toBe(200);
    expect(JSON.parse(hello!.body)).toEqual({ message: 'Hello from Node.js!' });
    expect(hello!.headers['x-void-middleware']).toBe('1');
    expect(hello!.headers['x-frame-options']).toBe('DENY');

    expect(home!.status).toBe(200);
    expect(home!.body).toContain('<title>Home | Node App</title>');
    const script = /src="(\/assets\/[^"]+\.js)"/.exec(home!.body)?.[1];
    expect(script, home!.body).toBeDefined();
    // The CDN serves what the function's HTML points at.
    expect(existsSync(join(output, 'static', script!))).toBe(true);

    expect(JSON.parse(later!.body)).toEqual({ queued: true });
    expect(stdout).toContain('VOID_WAIT_UNTIL_RAN');

    expect(cron!.status).toBe(200);
    expect(stdout).toContain('VOID_CRON_RAN 0 5 * * *');
    expect(unauthorized!.status).toBe(401);
  });

  it('is refused by void deploy', () => {
    const result = spawn.sync('vp', ['exec', 'void', 'deploy', '--platform', 'cloudflare'], {
      cwd: playground.root,
      encoding: 'utf8',
      timeout: 30_000,
    });
    expect(result.status).not.toBe(0);
    // The CLI wraps its message to the terminal width.
    const message = `${result.stdout}${result.stderr}`.replace(/\s+/g, ' ');
    expect(message).toContain('`void deploy` does not deploy to Vercel');
    expect(message).toContain('vercel deploy --prebuilt');
  });
});

describe('target vercel: static output', () => {
  let playground: IsolatedPlayground;
  let output: string;

  beforeAll(() => {
    playground = createIsolatedPlayground(ROOT, 'playground/node-static');
    // node-static.test.ts edits the source playground's config while it runs, so
    // write this copy's config instead of editing the copied one.
    writeFileSync(
      join(playground.root, 'void.config.ts'),
      `import { defineConfig } from 'void/config';

export default defineConfig({ target: 'vercel', output: 'static' });
`,
    );
    build(playground.root);
    output = join(playground.root, '.vercel', 'output');
    expect(existsSync(join(output, 'config.json')), 'the build wrote no Vercel output').toBe(true);
  }, 120_000);

  afterAll(() => {
    playground?.cleanup();
  });

  it('serves prerendered pages from static files at clean URLs', () => {
    expect(existsSync(join(output, 'static', 'index.html'))).toBe(true);
    expect(existsSync(join(output, 'static', 'about.html'))).toBe(true);
    const config = readJson<{ overrides: Record<string, { path: string }> }>(
      join(output, 'config.json'),
    );
    expect(config.overrides['about.html']).toEqual({ path: 'about' });
  });

  it('keeps a function for page actions and unprerendered requests', () => {
    expect(existsSync(join(output, 'functions', '__void.func', '.vc-config.json'))).toBe(true);
  });
});
