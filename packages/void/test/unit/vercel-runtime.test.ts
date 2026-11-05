import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import { createRoutingRuntime } from '../../src/runtime/routing.ts';
import {
  createExecutionContext,
  createFileAssets,
  createVercelHandler,
  type VercelHandlerOptions,
} from '../../src/runtime/vercel.ts';

const dirs: Array<string> = [];

afterEach(() => {
  vi.restoreAllMocks();
  delete (globalThis as Record<symbol, unknown>)[Symbol.for('@vercel/request-context')];
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function clientDir(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'void-vercel-runtime-'));
  dirs.push(root);
  for (const [path, contents] of Object.entries(files)) {
    mkdirSync(join(root, path, '..'), { recursive: true });
    writeFileSync(join(root, path), contents);
  }
  return root;
}

describe('createFileAssets', () => {
  const root = () =>
    clientDir({
      '.vite/manifest.json': '{"a":1}',
      'docs/index.html': '<h1>docs</h1>',
      'logo.svg': '<svg/>',
    });

  it('serves files with their content type', async () => {
    const assets = createFileAssets(root());
    const response = await assets.fetch(new Request('https://example.com/.vite/manifest.json'));
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('application/json');
    expect(await response.text()).toBe('{"a":1}');
  });

  it('serves a directory index and answers HEAD without a body', async () => {
    const assets = createFileAssets(root());
    expect(await (await assets.fetch(new Request('https://example.com/docs/'))).text()).toBe(
      '<h1>docs</h1>',
    );
    const head = await assets.fetch(
      new Request('https://example.com/logo.svg', { method: 'HEAD' }),
    );
    expect(head.status).toBe(200);
    expect(head.headers.get('content-length')).toBe('6');
    expect(await head.text()).toBe('');
  });

  it.each([
    ['a missing file', 'GET', '/missing.txt'],
    ['a traversal', 'GET', '/%2e%2e/%2e%2e/etc/passwd'],
    ['a malformed escape', 'GET', '/%E0%A4%A'],
    ['a POST', 'POST', '/logo.svg'],
  ])('answers %s with 404', async (_, method, path) => {
    const assets = createFileAssets(root());
    const response = await assets.fetch(new Request(`https://example.com${path}`, { method }));
    expect(response.status).toBe(404);
  });
});

describe('createExecutionContext', () => {
  it("passes work to the handler context's waitUntil", async () => {
    const waitUntil = vi.fn();
    createExecutionContext({ waitUntil }).waitUntil(Promise.resolve(1));
    expect(waitUntil).toHaveBeenCalledTimes(1);
  });

  it("falls back to Vercel's request context", () => {
    const waitUntil = vi.fn();
    (globalThis as Record<symbol, unknown>)[Symbol.for('@vercel/request-context')] = {
      get: () => ({ waitUntil }),
    };
    createExecutionContext(undefined).waitUntil(Promise.resolve());
    expect(waitUntil).toHaveBeenCalledTimes(1);
  });

  it('logs a failed task instead of rejecting unhandled', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    let task: Promise<unknown> | undefined;
    createExecutionContext({
      waitUntil: (promise: Promise<unknown>) => (task = promise),
    }).waitUntil(Promise.reject(new Error('boom')));
    await task;
    expect(error).toHaveBeenCalledWith('[void] A waitUntil task failed:', expect.any(Error));
  });
});

function handler(overrides: Partial<VercelHandlerOptions> = {}) {
  const app = { fetch: vi.fn(async () => new Response('app')) };
  const scheduled = vi.fn(async () => {});
  const options: VercelHandlerOptions = {
    app,
    scheduled,
    collectPrerenderPaths: async () => ['/', '/about'],
    clientRoot: clientDir({ 'assets/app.js': 'console.log(1)' }),
    assetsDir: 'assets',
    env: { CRON_SECRET: 'secret-value' },
    ...overrides,
  };
  return { fetch: createVercelHandler(options).fetch, app, scheduled };
}

describe('createVercelHandler', () => {
  it('runs the app with the ASSETS provider and an execution context', async () => {
    const { fetch, app } = handler();
    const waitUntil = vi.fn();
    expect(await (await fetch(new Request('https://example.com/api'), { waitUntil })).text()).toBe(
      'app',
    );
    const [request, env, ctx] = app.fetch.mock.calls[0] as unknown as [
      Request,
      { ASSETS: { fetch: unknown } },
      { waitUntil(promise: Promise<unknown>): void },
    ];
    expect(request.url).toBe('https://example.com/api');
    expect(typeof env.ASSETS.fetch).toBe('function');
    ctx.waitUntil(Promise.resolve());
    expect(waitUntil).toHaveBeenCalledTimes(1);
  });

  it('serves hashed files before the app and falls through when one is missing', async () => {
    const { fetch, app } = handler();
    expect(await (await fetch(new Request('https://example.com/assets/app.js'))).text()).toBe(
      'console.log(1)',
    );
    expect(app.fetch).not.toHaveBeenCalled();
    await fetch(new Request('https://example.com/assets/other.js'));
    expect(app.fetch).toHaveBeenCalledTimes(1);
  });

  it('answers path discovery only for the prerender runner', async () => {
    const { fetch } = handler();
    const request = () =>
      new Request('https://example.com/__void/prerender-paths', { method: 'POST' });
    expect(await (await fetch(request(), { __VOID_PRERENDER: '1' })).json()).toEqual({
      paths: ['/', '/about'],
    });
    expect((await fetch(request(), { waitUntil() {} })).status).toBe(404);
  });

  it('validates the environment before handling requests', async () => {
    const validateEnv = vi.fn(async () => {
      throw new Error('Missing API_KEY');
    });
    const { fetch } = handler({ validateEnv });
    await expect(fetch(new Request('https://example.com/'))).rejects.toThrow('Missing API_KEY');
  });

  describe('cron jobs', () => {
    const cron = (headers: Record<string, string>) =>
      new Request('https://example.com/__void/cron', { headers });

    it('runs the jobs for the schedule Vercel sends', async () => {
      const { fetch, scheduled, app } = handler();
      const response = await fetch(
        cron({ authorization: 'Bearer secret-value', 'x-vercel-cron-schedule': '0 5 * * *' }),
      );
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ ok: true });
      expect(scheduled).toHaveBeenCalledWith(
        expect.objectContaining({ cron: '0 5 * * *', type: 'scheduled' }),
        expect.objectContaining({ ASSETS: expect.anything() }),
        expect.objectContaining({ waitUntil: expect.any(Function) }),
      );
      expect(app.fetch).not.toHaveBeenCalled();
    });

    it('refuses to run without CRON_SECRET', async () => {
      const error = vi.spyOn(console, 'error').mockImplementation(() => {});
      const { fetch, scheduled } = handler({ env: {} });
      const response = await fetch(cron({ 'x-vercel-cron-schedule': '0 5 * * *' }));
      expect(response.status).toBe(500);
      expect(scheduled).not.toHaveBeenCalled();
      expect(error.mock.calls[0]?.[0]).toContain('set a CRON_SECRET environment variable');
    });

    it.each([
      ['no authorization', {}],
      ['the wrong secret', { authorization: 'Bearer wrong' }],
      ['a longer secret', { authorization: 'Bearer secret-value-and-more' }],
    ])('rejects %s', async (_, headers: Record<string, string>) => {
      const { fetch, scheduled } = handler();
      const response = await fetch(cron({ ...headers, 'x-vercel-cron-schedule': '0 5 * * *' }));
      expect(response.status).toBe(401);
      expect(scheduled).not.toHaveBeenCalled();
    });

    it('needs the schedule header', async () => {
      const { fetch } = handler();
      expect((await fetch(cron({ authorization: 'Bearer secret-value' }))).status).toBe(400);
    });

    it('reports failed jobs with 500', async () => {
      vi.spyOn(console, 'error').mockImplementation(() => {});
      const { fetch } = handler({
        scheduled: async () => {
          throw new Error('job failed');
        },
      });
      const response = await fetch(
        cron({ authorization: 'Bearer secret-value', 'x-vercel-cron-schedule': '0 5 * * *' }),
      );
      expect(response.status).toBe(500);
    });
  });
});

describe('routing runtime with an execution context on a Node target', () => {
  function rewriteApp(executionContext: boolean): Hono {
    const app = new Hono();
    const runtime = createRoutingRuntime(app, { nodeTarget: true, executionContext });
    app.use(runtime.contextMiddleware);
    app.use(runtime.requestMiddleware);
    app.use(
      '*',
      runtime.routingMiddleware([
        { source: '/old', destination: '/new', status: 200, force: true },
      ]),
    );
    app.get('/new', (c) => {
      c.executionCtx.waitUntil(Promise.resolve());
      return c.text('new');
    });
    return app;
  }

  it('keeps executionCtx for rewritten requests', async () => {
    const ctx = createExecutionContext({ waitUntil: vi.fn() });
    const response = await rewriteApp(true).fetch(new Request('https://example.com/old'), {}, ctx);
    expect(await response.text()).toBe('new');
  });

  it('drops it without the option, as Node, Bun and Deno have none', async () => {
    const ctx = createExecutionContext({ waitUntil: vi.fn() });
    const response = await rewriteApp(false).fetch(new Request('https://example.com/old'), {}, ctx);
    expect(response.status).toBe(500);
  });
});
