import type { AnimationBuilder } from "@ionic/vue";
import type {
  NavigationFailure,
  RouteLocationNormalized,
  RouteLocationRaw,
  Router,
} from "vue-router";
import { NavigationFailureType } from "vue-router";

import { createContextHistory } from "./contextHistory";
import type {
  CurrentRouteInfo,
  ExternalNavigationOptions,
  IonicVueRouterOptions,
  PreparedPlan,
  RouteAction,
  RouteDirection,
  RouteInfo,
} from "./types";

type PendingNavigation = {
  plan: PreparedPlan;
  animation?: AnimationBuilder;
};

type PendingExternalHint = {
  direction?: RouteDirection;
  animation?: AnimationBuilder;
  action?: RouteAction;
};

const getSearchFromFullPath = (fullPath: string): string => {
  const [pathAndSearch] = fullPath.split("#", 1);
  const [, search = ""] = pathAndSearch.split("?", 2);
  return search;
};

const toComparablePath = (route: RouteLocationNormalized): string => {
  const search = getSearchFromFullPath(route.fullPath);
  return search ? `${route.path}?${search}` : route.path;
};

const routeInfoToComparablePath = (routeInfo?: RouteInfo): string | undefined => {
  if (!routeInfo?.pathname) {
    return undefined;
  }

  return routeInfo.search
    ? `${routeInfo.pathname}?${routeInfo.search}`
    : routeInfo.pathname;
};

export const createIonRouter = (
  opts: IonicVueRouterOptions,
  router: Router
) => {
  const contextHistory = createContextHistory();

  let pendingBrowserDelta: number | null = null;
  let browserInterceptionInFlight = false;

  // Pending state: either a prepared plan (Ionic-initiated) or an external
  // hint (handleNavigate direction/animation).
  let pendingPlan: PendingNavigation | null = null;
  let pendingHint: PendingExternalHint | null = null;

  let currentRouteInfo: CurrentRouteInfo | undefined;
  let leavingRouteInfo: CurrentRouteInfo | undefined;

  const historyChangeListeners: Array<() => void> = [];
  const warnedTraversalMethods = new Set<string>();

  const clearPending = (): { plan: PendingNavigation | null; hint: PendingExternalHint | null } => {
    const result = { plan: pendingPlan, hint: pendingHint };
    pendingPlan = null;
    pendingHint = null;
    return result;
  };

  const notifyHistoryChange = (): void => {
    historyChangeListeners.forEach((cb) => cb());
  };

  const warnPatchedTraversalMethod = (
    method: "go" | "back" | "forward",
    delta?: number
  ): void => {
    if (warnedTraversalMethods.has(method)) {
      return;
    }

    warnedTraversalMethods.add(method);

    if (typeof console === "undefined" || typeof console.warn !== "function") {
      return;
    }

    const invocation =
      method === "go" ? `router.go(${delta ?? 0})` : `router.${method}()`;

    console.warn(
      `[Ionic Vue Router] ${invocation} is overridden to use Ionic context history instead of native browser history. This is a compatibility hack; prefer Ionic navigation APIs such as useIonRouter() and IonBackButton. Calls to these raw Vue Router traversal methods should be rare in production.`
    );
  };

  /**
   * If a prepared plan is already pending (from a previous navigation that
   * hasn't been confirmed by afterEach yet), speculatively commit it so that
   * subsequent prepare calls see the mutated state.
   *
   * This handles rapid-fire navigations (e.g. goBack() called twice before
   * the first afterEach fires). The speculative commit uses the plan's own
   * target as the resolved payload since the actual resolved route isn't
   * available yet.
   */
  const speculativelyCommitPending = (): void => {
    if (pendingPlan === null) {
      return;
    }

    const { plan } = pendingPlan;
    const [pathname, query = ""] = plan.target.split("?", 2);
    plan.commit({ pathname, search: query });

    // Produce route info from the speculative commit so currentRouteInfo
    // stays consistent.
    const entering = contextHistory.currentEntry();
    if (entering) {
      const leaving = currentRouteInfo;
      currentRouteInfo = contextHistory.produceCurrentRouteInfo(
        entering,
        leaving,
        {
          direction: plan.direction,
          action: plan.action,
          animation: pendingPlan.animation ?? plan.animation,
        }
      );
      leavingRouteInfo = leaving;
    }

    pendingPlan = null;
  };

  /**
   * Execute a prepared plan: store it as pending and dispatch the router call.
   */
  const executePlan = (plan: PreparedPlan, animation?: AnimationBuilder): void => {
    pendingPlan = { plan, animation: animation ?? plan.animation };

    if (plan.transport === "replace") {
      router.replace(plan.target);
    } else {
      router.push(plan.target);
    }
  };

  const go = (delta: number, routerAnimation?: AnimationBuilder) => {
    speculativelyCommitPending();
    const plan = contextHistory.prepareGo(delta);
    if (plan === null) {
      return;
    }

    executePlan(plan, routerAnimation);
  };

  const goBack = (routerAnimation?: AnimationBuilder) => {
    speculativelyCommitPending();
    const plan = contextHistory.prepareBack();
    if (plan === null) {
      return;
    }

    executePlan(plan, routerAnimation);
  };

  const goForward = (routerAnimation?: AnimationBuilder) => {
    speculativelyCommitPending();
    const plan = contextHistory.prepareForward();
    if (plan === null) {
      return;
    }

    executePlan(plan, routerAnimation);
  };

  // HACK: Vue Router's raw history traversal methods use the native session
  // history as transport. Once Ionic intercepts a pop navigation and re-syncs
  // the URL with router.replace(), the browser's own forward/back transport no
  // longer matches the context-history cursor model. Patch the imperative
  // router methods here so explicit router.go()/back()/forward() replay
  // context-aware steps directly. Keep this localized and revisit if the hack
  // can be moved down to the history transport layer instead.
  router.go = (delta: number) => {
    if (!Number.isFinite(delta)) {
      return;
    }

    warnPatchedTraversalMethod("go", delta);
    go(Math.trunc(delta));
  };

  router.back = () => {
    warnPatchedTraversalMethod("back");
    goBack();
  };

  router.forward = () => {
    warnPatchedTraversalMethod("forward");
    goForward();
  };

  opts.history.listen((_to: any, _from: any, info: any) => {
    pendingBrowserDelta = typeof info?.delta === "number" ? info.delta : null;
  });

  router.beforeEach((_to, _from, next) => {
    const delta = pendingBrowserDelta;
    pendingBrowserDelta = null;

    if (delta !== null && delta !== 0) {
      browserInterceptionInFlight = true;
      next(false);
      go(delta);
      return;
    }

    next();
  });

  router.afterEach(
    (
      to: RouteLocationNormalized,
      _from: RouteLocationNormalized,
      failure?: NavigationFailure
    ) => {
      if (failure) {
        if (
          browserInterceptionInFlight &&
          failure.type === NavigationFailureType.aborted
        ) {
          // Browser interception abort: the beforeEach already called
          // next(false) and re-dispatched via go(delta). The pending plan
          // was set by go() AFTER next(false), so do NOT clear it — the
          // next successful afterEach will consume it.
          browserInterceptionInFlight = false;
          return;
        }

        if (failure.type === NavigationFailureType.aborted) {
          // No rollback needed: prepare+commit means no state was mutated.
          clearPending();
        } else if (failure.type === NavigationFailureType.cancelled) {
          // Cancelled navigations may be followed by the navigation that
          // replaced them; keep pending state so it can be consumed by the
          // next afterEach.
        } else {
          clearPending();
        }

        return;
      }

      browserInterceptionInFlight = false;

      const { plan: consumedPlan, hint: consumedHint } = clearPending();
      const leaving = currentRouteInfo;

      // Deduplicate: if the resolved URL matches the current route, skip.
      if (
        leaving !== undefined &&
        routeInfoToComparablePath(leaving) === toComparablePath(to)
      ) {
        notifyHistoryChange();
        return;
      }

      // ── Prepared plan path ──────────────────────────────────────────
      if (consumedPlan !== null) {
        const resolvedPath = toComparablePath(to);

        if (resolvedPath === consumedPlan.plan.expectedComparableTarget) {
          // Plan matches: commit to mutate context history state.
          const resolvedPayload = {
            pathname: to.path,
            search: getSearchFromFullPath(to.fullPath),
            params: to.params as Record<string, any> | undefined,
          };

          const entering = consumedPlan.plan.commit(resolvedPayload);
          currentRouteInfo = contextHistory.produceCurrentRouteInfo(
            entering,
            leaving,
            {
              direction: consumedPlan.plan.direction,
              action: consumedPlan.plan.action,
              animation: consumedPlan.animation ?? consumedPlan.plan.animation,
            }
          );
          leavingRouteInfo = leaving;
          notifyHistoryChange();
          return;
        }

        // Plan does not match resolved route (e.g. guard redirect).
        // Fall through to external navigation path below.
      }

      // ── External / unplanned navigation path ────────────────────────
      const inferredAction: RouteAction = opts.history.state.replaced
        ? "replace"
        : "push";

      const routePayload = {
        pathname: to.path,
        search: getSearchFromFullPath(to.fullPath),
        params: to.params,
      };

      const entering =
        inferredAction === "replace"
          ? contextHistory.replace(routePayload, {
              routerAnimation: consumedHint?.animation,
            })
          : contextHistory.push(routePayload, {
              routerAnimation: consumedHint?.animation,
            });

      currentRouteInfo = contextHistory.produceCurrentRouteInfo(entering, leaving, {
        direction: consumedHint?.direction,
        animation: consumedHint?.animation,
        action: consumedHint?.action ?? inferredAction,
      });

      leavingRouteInfo = leaving;
      notifyHistoryChange();
    }
  );

  const handleNavigateBack = (
    defaultHref?: string,
    routerAnimation?: AnimationBuilder
  ) => {
    speculativelyCommitPending();
    const plan = contextHistory.prepareBack(defaultHref, routerAnimation);

    if (plan !== null) {
      executePlan(plan, routerAnimation);
      return;
    }

    // Back is fully blocked (already at the effective default target).
    // Nothing to do.
  };

  const handleNavigate = (
    path: RouteLocationRaw,
    routerAction: RouteAction = "push",
    routerDirection: RouteDirection = "forward",
    routerAnimation?: AnimationBuilder,
    _tab?: string
  ) => {
    speculativelyCommitPending();
    pendingHint = {
      direction: routerDirection,
      animation: routerAnimation,
    };

    if (routerAction === "replace") {
      router.replace(path);
    } else {
      router.push(path);
    }
  };

  const navigate = (navigationOptions: ExternalNavigationOptions) => {
    const { routerAnimation, routerDirection, routerLink, routerAction } =
      navigationOptions;

    handleNavigate(
      routerLink,
      routerAction ?? "push",
      routerDirection,
      routerAnimation
    );
  };

  const changeTab = (tab: string, path?: string) => {
    if (!path) {
      return;
    }

    speculativelyCommitPending();
    const plan = contextHistory.prepareChangeTab(tab, path);
    executePlan(plan);
  };

  const resetTab = (tab: string, defaultHref?: string) => {
    speculativelyCommitPending();
    const plan = contextHistory.prepareResetTab(tab, defaultHref);
    if (plan === null) {
      return;
    }

    executePlan(plan);
  };

  const resetAll = (redirectTo: string) => {
    speculativelyCommitPending();
    const plan = contextHistory.prepareResetAll(redirectTo);
    executePlan(plan);
  };

  const getCurrentRouteInfo = (): RouteInfo | undefined => currentRouteInfo;

  const getLeavingRouteInfo = (): RouteInfo | undefined =>
    leavingRouteInfo ?? currentRouteInfo;

  const canGoBack = (deep = 1): boolean => contextHistory.canGoBack(deep);

  const canGoForward = (deep = 1): boolean => contextHistory.canGoForward(deep);

  /**
   * Register a tab context and store its root href for back-fallback.
   *
   * @param tab - Tab context identifier
   * @param rootHref - Optional: the tab button's original href (source of
   *   truth for where back falls back to at cursor 0). Passed from IonTabBar.
   */
  const handleSetCurrentTab = (tab: string, rootHref?: string) => {
    const currentPathname = currentRouteInfo?.pathname ?? router.currentRoute.value.path;
    contextHistory.handleSetCurrentTab(tab, currentPathname, rootHref);
  };

  const registerHistoryChangeListener = (cb: () => void) => {
    historyChangeListeners.push(cb);
  };

  const getContextSnapshot = () => contextHistory.snapshot();

  const getRetainedPathnames = () => contextHistory.getRetainedPathnames();

  if (typeof document !== "undefined") {
    document.addEventListener("ionBackButton", (ev: Event) => {
      (ev as any).detail.register(0, (processNextHandler: () => void) => {
        goBack();
        processNextHandler();
      });
    });
  }

  return {
    handleNavigate,
    getLeavingRouteInfo,
    handleNavigateBack,
    handleSetCurrentTab,
    getCurrentRouteInfo,
    canGoBack,
    canGoForward,
    navigate,
    resetTab,
    resetAll,
    changeTab,
    registerHistoryChangeListener,
    goBack,
    goForward,
    getContextSnapshot,
    getRetainedPathnames,
  };
};
