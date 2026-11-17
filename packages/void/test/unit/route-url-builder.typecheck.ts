import { describe, expectTypeOf, it } from 'vite-plus/test';
import { routeUrl, type RouteOptions, type RoutePath } from '../../src/routes-stub.ts';

declare module 'void/routes' {
  interface RoutePathMap {
    '/route-types': never;
    '/route-types/:id': 'id';
    '/route-types/:org/:id': 'org' | 'id';
    '/route-types/files/:path{.+}': 'path';
    '/route-types/files/*': '*';
  }
}

describe('routeUrl types', () => {
  it('accepts known patterns and returns a string', () => {
    expectTypeOf(routeUrl('/route-types')).toEqualTypeOf<string>();
    expectTypeOf<'/route-types/:id'>().toMatchTypeOf<RoutePath>();
    routeUrl('/route-types', { query: { page: 1, tags: ['one', 'two'] }, hash: 'heading' });
    routeUrl('/route-types/:id', { params: { id: '123' } });
    routeUrl('/route-types/:org/:id', { params: { org: 'void', id: 123 } });
    routeUrl('/route-types/files/:path{.+}', { params: { path: 'a/b' } });
    routeUrl('/route-types/files/*', { params: { '*': 'a/b' } });
    const options: RouteOptions<'/route-types/:id'> = { params: { id: '123' } };
    routeUrl('/route-types/:id', options);
  });

  it('rejects unknown paths and incorrect params', () => {
    // @ts-expect-error unknown route
    routeUrl('/route-types/typo');
    // @ts-expect-error require the pattern instead of a concrete dynamic URL
    routeUrl('/route-types/123');
    // @ts-expect-error params are required
    routeUrl('/route-types/:id');
    // @ts-expect-error params are required even when other options are provided
    routeUrl('/route-types/:id', { query: { page: 1 } });
    // @ts-expect-error param names must match
    routeUrl('/route-types/:id', { params: { wrong: '123' } });
    // @ts-expect-error all params are required
    routeUrl('/route-types/:org/:id', { params: { id: '123' } });
    // @ts-expect-error static routes do not accept params
    routeUrl('/route-types', { params: { id: '123' } });
    // @ts-expect-error extra params are rejected
    routeUrl('/route-types/:id', { params: { id: '123', extra: 'x' } });
    // @ts-expect-error param values must be strings or numbers
    routeUrl('/route-types/:id', { params: { id: true } });
    // @ts-expect-error only URL query values are supported
    routeUrl('/route-types', { query: { nested: { value: 'x' } } });
    // @ts-expect-error the hash must be a string
    routeUrl('/route-types', { hash: 123 });
    const unknown: string = '/route-types';
    // @ts-expect-error arbitrary strings must not bypass route checking
    routeUrl(unknown);
  });

  it('requires every possible param when a path is a union', () => {
    const path = '' as '/route-types' | '/route-types/:id';
    // @ts-expect-error one of the possible routes requires params
    routeUrl(path);
    routeUrl(path, { params: { id: '123' } });
  });

  it('accepts a generic route with its own options', () => {
    function link<P extends RoutePath>(path: P, options: RouteOptions<P>): string {
      return routeUrl(path, options);
    }
    link('/route-types/:id', { params: { id: '123' } });
    function bare<P extends RoutePath>(path: P): string {
      // @ts-expect-error a generic route may require params
      return routeUrl(path);
    }
    void bare;
  });

  it('accepts undefined options only for static routes', () => {
    const none = undefined as RouteOptions<'/route-types'> | undefined;
    routeUrl('/route-types', none);
    routeUrl('/route-types', undefined);
    routeUrl('/route-types', { params: undefined });
    const maybe = undefined as RouteOptions<'/route-types/:id'> | undefined;
    // @ts-expect-error params are required
    routeUrl('/route-types/:id', maybe);
    // @ts-expect-error params are required
    routeUrl('/route-types/:id', undefined);
  });

  it('rejects options typed for another route', () => {
    const options: RouteOptions<'/route-types/:id'> = { params: { id: '123' } };
    // @ts-expect-error static routes do not accept params
    routeUrl('/route-types', options);
    // @ts-expect-error param names must match
    routeUrl('/route-types/files/:path{.+}', options);
  });

  it('checks params that are not object literals', () => {
    const named = { id: '123' };
    routeUrl('/route-types/:id', { params: named });
    const options = { params: { id: 123 }, query: { page: 1 } };
    routeUrl('/route-types/:id', options);
    const wrong = { params: { wrong: '123' } };
    // @ts-expect-error param names must match
    routeUrl('/route-types/:id', wrong);
    const record: Record<string, string> = {};
    // @ts-expect-error a record may lack the param
    routeUrl('/route-types/:id', { params: record });
    // @ts-expect-error params must be an object
    routeUrl('/route-types/:id', { params: '123' });
    const optional: { id?: string } = {};
    // @ts-expect-error the param may be undefined
    routeUrl('/route-types/:id', { params: optional });
  });

  it('keeps error messages out of route completions', () => {
    // Completions for the path come from its parameter type: every known route before
    // a pattern is inferred, and no string literal once an unknown one is.
    expectTypeOf<Parameters<typeof routeUrl<string>>[0]>().toEqualTypeOf<RoutePath>();
    expectTypeOf<Parameters<typeof routeUrl<'/route-types/typo'>>[0]>().not.toBeString();
    expectTypeOf<Parameters<typeof routeUrl<'/route-types/:id'>>[0]>().not.toBeString();
  });
});
