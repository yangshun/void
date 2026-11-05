import { describe, expect, it } from 'vite-plus/test';
import {
  createVercelConfig,
  type CreateVercelConfigInput,
  type VercelSourceRoute,
} from '../../src/index.ts';

function input(overrides: Partial<CreateVercelConfigInput> = {}): CreateVercelConfigInput {
  return {
    redirectRules: [],
    fallbackRules: [],
    headerRules: [],
    staticFiles: [],
    immutableFiles: [],
    assetsDir: 'assets',
    guardMissingAssets: false,
    hasFunction: true,
    cronSchedules: [],
    ...overrides,
  };
}

function routesOf(overrides: Partial<CreateVercelConfigInput>) {
  return createVercelConfig(input(overrides)).config.routes;
}

describe('createVercelConfig with a function', () => {
  it('sends everything the CDN does not serve to the function', () => {
    expect(routesOf({})).toEqual([{ handle: 'filesystem' }, { src: '^/.*$', dest: '/__void' }]);
  });

  it('redirects GET and HEAD at the edge and leaves other methods to the function', () => {
    const routes = routesOf({
      redirectRules: [{ source: '/old/:slug', destination: '/new/:slug', status: 308 }],
    });
    expect(routes.slice(0, 2)).toEqual([
      {
        src: '^/old/(?<slug>[^/]+)$',
        status: 308,
        headers: { Location: '/new/$slug' },
        methods: ['GET', 'HEAD'],
      },
      { src: '^/old/(?<slug>[^/]+)$', dest: '/__void' },
    ]);
  });

  it('rewrites at the edge so a rewrite to a static file is served by the CDN', () => {
    const routes = routesOf({
      redirectRules: [{ source: '/docs/*', destination: '/en/docs/:splat', status: 200 }],
    });
    expect(routes[0]).toEqual({ src: '^/docs/(?<splat>.*)$', dest: '/en/docs/$splat' });
  });

  it('keeps rule order, so an earlier rule the edge cannot apply still wins', () => {
    const routes = routesOf({
      redirectRules: [
        { source: '/a', destination: '/b?x=1', status: 302 },
        { source: '/a', destination: '/c', status: 302 },
      ],
    });
    expect(routes.slice(0, 2)).toEqual([
      { src: '^/a$', dest: '/__void' },
      { src: '^/a$', status: 302, headers: { Location: '/c' }, methods: ['GET', 'HEAD'] },
    ]);
  });

  it.each([
    ['a query', '/b?x=1'],
    ['a fragment', '/b#top'],
    ['a literal $', '/b$'],
    ['a leading multi-segment capture', '/:splat'],
  ])('leaves a destination with %s to the function', (_, destination) => {
    const routes = routesOf({ redirectRules: [{ source: '/*', destination, status: 301 }] });
    expect(routes[0]).toEqual({ src: '^/(?<splat>.*)$', dest: '/__void' });
  });

  it('redirects a leading single-segment capture at the edge', () => {
    const routes = routesOf({
      redirectRules: [{ source: '/u/:name', destination: '/:name/profile', status: 302 }],
    });
    expect((routes[0] as VercelSourceRoute).headers).toEqual({ Location: '/$name/profile' });
  });

  it('limits host rules to their host', () => {
    const routes = routesOf({
      redirectRules: [
        {
          source: '/*',
          destination: 'https://example.com/:splat',
          status: 301,
          host: 'www.example.com',
        },
      ],
    });
    expect(routes.slice(0, 2)).toEqual([
      {
        src: '^/(?<splat>.*)$',
        status: 301,
        headers: { Location: 'https://example.com/$splat' },
        methods: ['GET', 'HEAD'],
        has: [{ type: 'host', value: 'www.example.com' }],
      },
      {
        src: '^/(?<splat>.*)$',
        dest: '/__void',
        has: [{ type: 'host', value: 'www.example.com' }],
      },
    ]);
  });

  it('skips a malformed rule, as Void does at runtime', () => {
    expect(
      routesOf({ redirectRules: [{ source: '/:id/:id', destination: '/x', status: 302 }] }),
    ).toEqual(routesOf({}));
  });

  it('applies fallbacks in the function only', () => {
    const routes = routesOf({
      fallbackRules: [{ source: '/*', destination: '/index.html', status: 200 }],
    });
    expect(routes).toEqual([{ handle: 'filesystem' }, { src: '^/.*$', dest: '/__void' }]);
  });

  it('answers missing hashed assets with 404 when no route can reach them', () => {
    const routes = routesOf({ guardMissingAssets: true });
    expect(routes[1]).toEqual({
      src: '^/assets/.+$',
      status: 404,
      headers: { 'cache-control': 'no-store' },
    });
  });

  it('lists the static files the function reads', () => {
    const { functionStaticFiles } = createVercelConfig(
      input({
        redirectRules: [{ source: '/hero', destination: '/img/:name', status: 200 }],
        fallbackRules: [{ source: '/*', destination: '/shell.html?v=1', status: 200 }],
        staticFiles: ['/404.html', '/img/a.png', '/other.png', '/shell.html', '/500.html'],
      }),
    );
    expect(functionStaticFiles).toEqual(['/404.html', '/500.html', '/img/a.png', '/shell.html']);
  });
});

describe('createVercelConfig without a function', () => {
  it('redirects every method and appends fallbacks and the 404 page after static files', () => {
    const routes = routesOf({
      hasFunction: false,
      redirectRules: [{ source: '/old', destination: '/new?ref=old', status: 301 }],
      fallbackRules: [{ source: '/app/*', destination: '/app.html', status: 200 }],
      staticFiles: ['/404.html', '/app.html'],
    });
    expect(routes).toEqual([
      { src: '^/old$', status: 301, headers: { Location: '/new?ref=old' } },
      { src: '^/(?<path>app)/$', status: 307, headers: { Location: '/$path' } },
      { src: '^/(?<path>app)\\.html$', status: 307, headers: { Location: '/$path' } },
      { handle: 'filesystem' },
      { src: '^/app/(?<splat>.*)$', dest: '/app.html', check: true },
      { src: '^/.*$', dest: '/404.html', status: 404, check: true },
    ]);
  });

  it('fails on rules the edge cannot apply safely', () => {
    const { errors } = createVercelConfig(
      input({
        hasFunction: false,
        redirectRules: [{ source: '/*', destination: '/:splat', status: 301 }],
        fallbackRules: [{ source: '/x', destination: '/$y', status: 200 }],
      }),
    );
    expect(errors).toHaveLength(2);
    expect(errors[0]).toContain('redirect "/*" -> "/:splat"');
    expect(errors[1]).toContain('fallback "/x" -> "/$y"');
  });

  it('fails on cron jobs, which need a function', () => {
    const { errors } = createVercelConfig(
      input({ hasFunction: false, cronSchedules: ['0 5 * * *'] }),
    );
    expect(errors).toEqual(['Cron jobs need a server function, but this build has none.']);
  });
});

describe('createVercelConfig static files', () => {
  it('serves HTML files at clean URLs and redirects the other forms', () => {
    const { config } = createVercelConfig(
      input({ staticFiles: ['/about.html', '/docs/index.html', '/index.html', '/404.html'] }),
    );
    expect(config.overrides).toEqual({ 'about.html': { path: 'about' } });
    expect(config.routes.filter((route) => 'status' in route)).toEqual([
      { src: '^/(?<path>about)/$', status: 307, headers: { Location: '/$path' } },
      { src: '^/(?<path>about)\\.html$', status: 307, headers: { Location: '/$path' } },
      { src: '^/(?<path>docs)$', status: 307, headers: { Location: '/$path/' } },
      { src: '^/(?<path>docs)/index\\.html$', status: 307, headers: { Location: '/$path/' } },
      { src: '^/index\\.html$', status: 307, headers: { Location: '/' } },
    ]);
  });

  it('keeps an HTML file at its own path when a clean URL would collide', () => {
    const { config } = createVercelConfig(
      input({ staticFiles: ['/guide.html', '/guide/index.html'] }),
    );
    expect(config.overrides).toBeUndefined();
  });

  it('applies header rules to static files with last match winning', () => {
    const routes = routesOf({
      staticFiles: ['/robots.txt', '/about.html', '/logo.png'],
      headerRules: [
        { pattern: '/*', headers: [['X-Frame-Options', 'DENY']] },
        { pattern: '/about', headers: [['X-Frame-Options', 'SAMEORIGIN']] },
      ],
    });
    const hit = routes.slice(
      routes.findIndex((route) => 'handle' in route && route.handle === 'hit'),
    );
    expect(hit).toEqual([
      { handle: 'hit' },
      { src: '^(?:/about)$', headers: { 'x-frame-options': 'SAMEORIGIN' }, continue: true },
      {
        src: '^(?:/logo\\.png|/robots\\.txt)$',
        headers: { 'x-frame-options': 'DENY' },
        continue: true,
      },
    ]);
  });

  it('caches hashed files forever, whatever the header rules say', () => {
    const routes = routesOf({
      staticFiles: ['/assets/app-1a2b.js', '/assets/logo.svg'],
      immutableFiles: ['/assets/app-1a2b.js'],
      headerRules: [
        {
          pattern: '/assets/*',
          headers: [
            ['Cache-Control', 'no-cache'],
            ['X-Asset', '1'],
          ],
        },
      ],
    });
    expect(routes.slice(-2)).toEqual([
      {
        src: '^(?:/assets/app-1a2b\\.js)$',
        headers: { 'cache-control': 'public, max-age=31536000, immutable', 'x-asset': '1' },
        continue: true,
      },
      {
        src: '^(?:/assets/logo\\.svg)$',
        headers: { 'cache-control': 'no-cache', 'x-asset': '1' },
        continue: true,
      },
    ]);
  });

  it('splits long path lists across routes', () => {
    const staticFiles = Array.from({ length: 400 }, (_, i) => `/files/document-${i}.pdf`);
    const routes = routesOf({
      staticFiles,
      headerRules: [{ pattern: '/*', headers: [['X-A', '1']] }],
    });
    const headerRoutes = routes.filter((route) => 'continue' in route) as Array<VercelSourceRoute>;
    expect(headerRoutes.length).toBeGreaterThan(1);
    expect(headerRoutes.every((route) => route.src.length <= 4100)).toBe(true);
  });
});

describe('createVercelConfig crons and metadata', () => {
  it('registers each distinct schedule once', () => {
    const { config, errors } = createVercelConfig(
      input({
        cronSchedules: ['0 5 * * *', '0 5 * * *', '*/15 * * * *'],
        frameworkVersion: '1.6.1',
      }),
    );
    expect(errors).toEqual([]);
    expect(config.crons).toEqual([
      { path: '/__void/cron', schedule: '0 5 * * *' },
      { path: '/__void/cron', schedule: '*/15 * * * *' },
    ]);
    expect(config.framework).toEqual({ version: '1.6.1' });
  });

  it('reports schedules Vercel rejects', () => {
    const { errors } = createVercelConfig(input({ cronSchedules: ['0 9 * * MON'] }));
    expect(errors).toEqual([
      'cron "0 9 * * MON" isn\'t supported by Vercel Cron Jobs: invalid day of week "MON": use numbers from 0 to 6 with *, ",", "-" or "/".',
    ]);
  });
});
