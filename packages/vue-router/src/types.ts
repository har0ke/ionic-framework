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

export type ContextBackBehavior = "within-context" | "previous-context";
export type ContextRootBackBehavior = "block" | "previous-context";
export type UnmatchedBehavior = "default" | "active";

export interface ContextConfig {
  backBehavior: ContextBackBehavior;
  rootBackBehavior: ContextRootBackBehavior;
  clearOnExternalPush: boolean;
  unmatchedBehavior: UnmatchedBehavior;
}

export interface PushOptions {
  // Entry overrides (stored on created NavEntry)
  backBehavior?: ContextBackBehavior;
  rootBackBehavior?: ContextRootBackBehavior;

  // Push-time overrides (consumed, not stored)
  unmatchedBehavior?: UnmatchedBehavior;
  clearOnExternalPush?: boolean;

  // Navigation metadata
  routerAnimation?: AnimationBuilder;
}

export interface NavEntry {
  id: string;
  pathname: string;
  search: string;
  params: Record<string, any> | undefined;

  context: string;
  originContext: string | null;

  backBehavior: ContextBackBehavior | null;
  rootBackBehavior: ContextRootBackBehavior | null;

  routerAnimation: AnimationBuilder | undefined;
}

export interface ContextStack {
  entries: NavEntry[];
  cursor: number;
  config: ContextConfig;
}

export interface SavedEntries {
  context: string;
  entries: NavEntry[];
}

// Placeholder for now; may evolve as rewrite lands.
export interface StateSnapshot {
  activeContext: string;
  cursors: { [contextId: string]: number };
  savedEntries?: SavedEntries[];
}

export interface NavigationContext {
  animation?: AnimationBuilder;
  direction?: RouteDirection;
  snapshot?: StateSnapshot;
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
