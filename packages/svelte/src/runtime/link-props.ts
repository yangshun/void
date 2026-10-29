import type { Snippet } from 'svelte';
import type { LinkHrefProps } from 'void/pages-client';

type PrefetchStrategy = 'hover' | 'click' | 'mount' | 'visible';
type LinkMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
type NavigateEvent = { preventDefault(): void };
type EventHandler<T extends Event> = (event: T) => void;

export type LinkProps = {
  method?: LinkMethod | Lowercase<LinkMethod>;
  preserveScroll?: boolean;
  preserveState?: boolean;
  replace?: boolean;
  reloadDocument?: boolean;
  viewTransition?: boolean;
  prefetch?: boolean | PrefetchStrategy | Array<PrefetchStrategy>;
  cacheFor?: number | string | [string, string];
  onNavigate?: (event: NavigateEvent) => void;
  children?: Snippet;
  onclick?: EventHandler<MouseEvent>;
  onmouseenter?: EventHandler<MouseEvent>;
  onmouseleave?: EventHandler<MouseEvent>;
  onfocus?: EventHandler<FocusEvent>;
  onmousedown?: EventHandler<MouseEvent>;
  ontouchstart?: EventHandler<TouchEvent>;
  style?: string;
  [key: string]: unknown;
} & LinkHrefProps;
