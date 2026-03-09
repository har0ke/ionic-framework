import type { AnimationBuilder } from "@ionic/vue";
import type { Ref } from "vue";
import type { RouteLocationMatched, RouterOptions } from "vue-router";

// TODO(FW-2969): types

export interface VueComponentData {
  /**
   * The cached result of the props
   * function for a particular view instance.
   */
  propsFunctionResult?: any;
}

export interface IonicVueRouterOptions extends RouterOptions {
  tabsPrefix?: string;
}

export interface RouteInfo {
  id?: string;
  routerAction?: RouteAction;
  routerDirection?: RouteDirection;
  routerAnimation?: AnimationBuilder;

  /**
   * The previous route you were on if you were to
   * navigate backwards in a linear manner.
   * i.e. If you pressed the browser back button,
   * this is the route you would land on.
   */
  lastPathname?: string;
  prevRouteLastPathname?: string;
  pathname?: string;
  search?: string;
  params?: { [k: string]: any };

  /**
   * The route that pushed the current route.
   * This is used to determine if a route can swipe
   * to go back to a previous route. This is
   * usually the same as lastPathname when navigating
   * in a linear manner but is almost always different
   * when using tabs.
   */
  pushedByRoute?: string;
  tab?: string;
  position?: number;
  delta?: number;
}

export interface RouteParams {
  routerAction: RouteAction;
  routerDirection: RouteDirection;
  routerAnimation?: AnimationBuilder;
  tab?: string;
  id?: string;
}

export type RouteAction = "push" | "pop" | "replace";
export type RouteDirection = "forward" | "back" | "root" | "none";

export interface ViewItem {
  id: string;
  pathname: string;
  outletId: number;
  matchedRoute: RouteLocationMatched;
  ionPageElement?: HTMLElement;
  vueComponent: any;
  ionRoute: boolean;
  mount: boolean;
  exact: boolean;
  registerCallback?: () => void;
  vueComponentRef: Ref;
  params?: { [k: string]: any };
  vueComponentData: VueComponentData;
  routerAnimation?: AnimationBuilder;
}

export interface ViewStacks {
  [k: string]: ViewItem[];
}

export interface ExternalNavigationOptions {
  routerLink: string;
  routerDirection?: RouteDirection;
  routerAnimation?: AnimationBuilder;
  routerAction?: RouteAction;
}

export interface NavigationInformation {
  action?: RouteAction;
  direction?: RouteDirection;
  delta?: number;
}

/**
 * Phase 1 (router rewrite): internal types for context-based history.
 *
 * These types are package-internal and are not re-exported from `@ionic/vue-router`.
 * They are added additively so the existing router implementation can continue
 * to compile while the rewrite is developed in parallel.
 */

export interface PushOptions {
  // Navigation metadata
  routerAnimation?: AnimationBuilder;
}

export interface NavEntry {
  id: string;
  pathname: string;
  search: string;
  params: Record<string, any> | undefined;

  context: string;
  /** Context active when this entry was pushed (cross-context only). Inert historical metadata. */
  originContext: string | null;

  routerAnimation: AnimationBuilder | undefined;
}

export interface ContextStack {
  entries: NavEntry[];
  cursor: number;
  /**
   * The explicit root route for this context, sourced from IonTabButton.href.
   * Used as the fallback target when back reaches cursor 0. Only set for
   * tab contexts; default context has rootHref undefined.
   */
  rootHref: string | undefined;
}

export interface NavigationContext {
  animation?: AnimationBuilder;
  direction?: RouteDirection;
}

// Placeholder for now; kept separate from legacy RouteInfo.
export interface CurrentRouteInfo {
  id: string;
  pathname: string;
  search: string;
  params: Record<string, any> | undefined;

  pushedByRoute: string | undefined;

  routerAction: RouteAction;
  routerDirection: RouteDirection;
  routerAnimation: AnimationBuilder | undefined;
  lastPathname: string;
  prevRouteLastPathname: string | undefined;
  delta: number | undefined;

  tab: string;
}

/**
 * A prepared navigation plan computed by contextHistory without mutating state.
 *
 * The router integration calls `commit(resolved)` in afterEach after Vue Router
 * confirms the navigation succeeded, passing the resolved route payload so the
 * internal entry matches the final navigated URL.
 */
export interface PreparedPlan {
  /** The Vue Router call to make: 'replace' or 'push'. */
  transport: "replace" | "push";
  /** The target route to pass to router.replace() or router.push(). */
  target: string;
  /** The transition direction for outlet animations. */
  direction: RouteDirection;
  /** The semantic action for CurrentRouteInfo. */
  action: RouteAction;
  /**
   * The comparable path (pathname + query) that the plan expects Vue Router
   * to resolve to. Used by afterEach to verify the navigation landed where
   * expected; if it doesn't match, the plan is dropped.
   */
  expectedComparableTarget: string;
  /** Animation override for the transition. */
  animation?: AnimationBuilder;
  /**
   * Commit the prepared navigation. Mutates context history state to reflect
   * the navigation. Should only be called after Vue Router confirms success.
   *
   * @param resolved - The resolved route payload from Vue Router's `to` route
   * @returns The NavEntry that was created or moved to
   */
  commit(resolved: { pathname: string; search: string; params?: Record<string, any> }): NavEntry;
}

export interface ContextHistorySnapshot {
  activeContext: string;
  contexts: {
    [id: string]: {
      cursor: number;
      entries: {
        url: string;
        backTarget: { context: string; cursor: number } | null;
      }[];
    };
  };
}
