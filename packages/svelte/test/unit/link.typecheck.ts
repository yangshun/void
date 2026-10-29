import type { RouteHref } from 'void/routes';
import type { LinkProps } from '../../src/runtime/link-props.ts';

declare module 'void/routes' {
  interface RoutePathMap {
    '/typed-link': never;
    '/typed-link/:id': 'id';
  }
}

export function checkTypedLinks(): void {
  const legacy: LinkProps = { href: '/unregistered', data: { page: 1 }, method: 'POST' };
  const typed: LinkProps = {
    href: { pathname: '/typed-link/:id', params: { id: 123 }, query: { page: 1 }, hash: 'details' },
  };
  const staticLink: LinkProps = { href: { pathname: '/typed-link' } };
  const href: RouteHref = Math.random() < 0.5 ? '/typed-link' : { pathname: '/typed-link' };
  const routeHrefLink: LinkProps = { href };
  void legacy;
  void typed;
  void staticLink;
  void routeHrefLink;
  // @ts-expect-error typed patterns must exist
  const unknown: LinkProps = { href: { pathname: '/typed-link-typo' } };
  void unknown;
  // @ts-expect-error dynamic destinations require params
  const missing: LinkProps = { href: { pathname: '/typed-link/:id' } };
  void missing;
  // @ts-expect-error parameter names are checked
  const wrong: LinkProps = { href: { pathname: '/typed-link/:id', params: { wrong: '123' } } };
  void wrong;
}
