import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vite-plus/test';
import { Link } from '../../src/runtime/link.tsx';

declare module 'void/routes' {
  interface RoutePathMap {
    '/link-test/:id': 'id';
  }
}

describe('Link', () => {
  it('renders an encoded typed destination without leaking its fields into HTML', () => {
    const markup = renderToStaticMarkup(
      createElement(
        Link,
        {
          href: {
            pathname: '/link-test/:id',
            params: { id: 'a/b' },
            query: { tab: 'activity' },
            hash: 'details',
          },
        },
        'User',
      ),
    );
    expect(markup).toContain('href="/link-test/a%2Fb?tab=activity#details"');
    expect(markup).not.toMatch(/pathname=|params=|query=/);
  });

  it('rejects object hrefs with legacy data for JavaScript callers', () => {
    expect(() =>
      renderToStaticMarkup(
        createElement(
          Link,
          { href: { pathname: '/link-test/:id', params: { id: '123' } }, data: {} },
          'User',
        ),
      ),
    ).toThrow('data is only supported with a string href');
  });

  it('preserves dot-segment relative hrefs when merging GET data', () => {
    const markup = renderToStaticMarkup(
      createElement(
        Link,
        {
          href: '../users?sort=name#team',
          data: {
            page: 2,
          },
        },
        'Users',
      ),
    );

    expect(markup).toContain('href="../users?sort=name&amp;page=2#team"');
  });

  it('preserves hrefs when GET data does not add query params', () => {
    const markup = renderToStaticMarkup(
      createElement(
        Link,
        {
          href: '../users',
          data: {
            empty: [],
            skip: null,
            missing: undefined,
          },
        },
        'Users',
      ),
    );

    expect(markup).toContain('href="../users"');
  });

  it('rejects nested GET data', () => {
    expect(() =>
      renderToStaticMarkup(
        createElement(Link, { href: '/users', data: { filters: { status: 'open' } } }, 'Users'),
      ),
    ).toThrow('Link: GET data only supports primitive values and arrays');
  });

  it('rejects prefetch on non-GET links', () => {
    expect(() =>
      renderToStaticMarkup(
        createElement(Link, { href: '/users', method: 'POST', prefetch: true }, 'Create'),
      ),
    ).toThrow('Link: prefetch only supports GET links');
  });

  it('rejects reloadDocument on non-GET links', () => {
    expect(() =>
      renderToStaticMarkup(
        createElement(Link, { href: '/users', method: 'POST', reloadDocument: true }, 'Create'),
      ),
    ).toThrow('Link: reloadDocument only supports GET links');
  });
});
