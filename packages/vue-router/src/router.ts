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
  NavigationContext,
  RouteAction,
  RouteDirection,
  RouteInfo,
} from "./types";

type PendingNavigationContext = NavigationContext & {
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
  let pending: PendingNavigationContext | null = null;

  let currentRouteInfo: CurrentRouteInfo | undefined;
  let leavingRouteInfo: CurrentRouteInfo | undefined;

  const historyChangeListeners: Array<() => void> = [];
  const warnedTraversalMethods = new Set<string>();

  const setPending = (ctx: PendingNavigationContext): void => {
    pending = ctx;
  };

  const readAndClearPending = (): PendingNavigationContext | null => {
    const value = pending;
    pending = null;
    return value;
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

  const go = (delta: number, routerAnimation?: AnimationBuilder) => {
    const snapshot = contextHistory.captureState();
    const target = contextHistory.go(delta);

    if (target === null) {
      return;
    }

    setPending({
      direction: delta < 0 ? "back" : "forward",
      animation: routerAnimation,
      snapshot,
    });

    router.replace(target);
  };

  const goBack = (routerAnimation?: AnimationBuilder) => {
    go(-1, routerAnimation);
  };

  const goForward = (routerAnimation?: AnimationBuilder) => {
    go(1, routerAnimation);
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
    go(-1);
  };

  router.forward = () => {
    warnPatchedTraversalMethod("forward");
    go(1);
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
          browserInterceptionInFlight = false;
          return;
        }

        if (failure.type === NavigationFailureType.aborted) {
          const failedPending = readAndClearPending();
          if (failedPending?.snapshot) {
            contextHistory.restoreState(failedPending.snapshot);
          }
        } else if (failure.type !== NavigationFailureType.cancelled) {
          readAndClearPending();
        }

        return;
      }

      browserInterceptionInFlight = false;

      const navContext = readAndClearPending();
      const leaving = currentRouteInfo;

      if (
        leaving !== undefined &&
        routeInfoToComparablePath(leaving) === toComparablePath(to)
      ) {
        notifyHistoryChange();
        return;
      }

      if (navContext?.snapshot) {
        const entering = contextHistory.currentEntry();
        if (!entering) {
          notifyHistoryChange();
          return;
        }

        currentRouteInfo = contextHistory.produceCurrentRouteInfo(
          entering,
          leaving,
          navContext
        );
        leavingRouteInfo = leaving;
        notifyHistoryChange();
        return;
      }

      const routerAction: RouteAction = opts.history.state.replaced
        ? "replace"
        : "push";

      const routePayload = {
        pathname: to.path,
        search: getSearchFromFullPath(to.fullPath),
        params: to.params,
      };

      const entering =
        routerAction === "replace"
          ? contextHistory.replace(routePayload, {
              routerAnimation: navContext?.animation,
            })
          : contextHistory.push(routePayload, {
              routerAnimation: navContext?.animation,
            });

      currentRouteInfo = contextHistory.produceCurrentRouteInfo(entering, leaving, {
        ...navContext,
        action: routerAction,
      });

      leavingRouteInfo = leaving;
      notifyHistoryChange();
    }
  );

  const handleNavigateBack = (
    defaultHref?: string,
    routerAnimation?: AnimationBuilder
  ) => {
    const snapshot = contextHistory.captureState();
    const target = contextHistory.performBack();

    if (target !== null) {
      setPending({
        direction: "back",
        animation: routerAnimation,
        snapshot,
      });

      router.replace(target);
      return;
    }

    if (defaultHref) {
      setPending({
        direction: "back",
        animation: routerAnimation,
      });

      router.push(defaultHref);
    }
  };

  const handleNavigate = (
    path: RouteLocationRaw,
    routerAction: RouteAction = "push",
    routerDirection: RouteDirection = "forward",
    routerAnimation?: AnimationBuilder,
    _tab?: string
  ) => {
    setPending({
      direction: routerDirection,
      animation: routerAnimation,
    });

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

    const snapshot = contextHistory.captureState();
    const target = contextHistory.changeTab(tab, path);

    setPending({
      direction: "none",
      snapshot,
    });

    router.push(target);
  };

  const resetTab = (tab: string, defaultHref?: string) => {
    const snapshot = contextHistory.captureState();
    const target = contextHistory.resetTab(tab, defaultHref);

    if (target === null) {
      return;
    }

    setPending({
      direction: "back",
      snapshot,
    });

    router.replace(target);
  };

  const resetAll = (redirectTo: string) => {
    const snapshot = contextHistory.captureState();
    const target = contextHistory.resetAll(redirectTo);

    setPending({
      direction: "root",
      snapshot,
    });

    router.replace(target);
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
