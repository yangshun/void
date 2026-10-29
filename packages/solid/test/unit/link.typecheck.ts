import type { RouteUrlInput } from 'void/routes';
import type { LinkProps } from '../../src/runtime/link.tsx';

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
  const href: RouteUrlInput = Math.random() < 0.5 ? '/typed-link' : { pathname: '/typed-link' };
  const routeHrefLink: LinkProps = { href };
  const forwardLinkProps = (props: Omit<LinkProps, 'className'>): LinkProps => props;
  const forwarded = forwardLinkProps({ href: '/typed-link', data: { page: 1 } });
  void legacy;
  void typed;
  void staticLink;
  void routeHrefLink;
  void forwarded;
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
