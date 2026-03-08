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

  const goBack = (routerAnimation?: AnimationBuilder) => {
    const snapshot = contextHistory.captureState();
    const target = contextHistory.performBack();

    if (target === null) {
      return;
    }

    setPending({
      direction: "back",
      animation: routerAnimation,
      snapshot,
    });

    router.replace(target);
  };

  const goForward = (routerAnimation?: AnimationBuilder) => {
    const snapshot = contextHistory.captureState();
    const target = contextHistory.performForward();

    if (target === null) {
      return;
    }

    setPending({
      direction: "forward",
      animation: routerAnimation,
      snapshot,
    });

    router.replace(target);
  };

  opts.history.listen((_to: any, _from: any, info: any) => {
    pendingBrowserDelta = typeof info?.delta === "number" ? info.delta : null;
  });

  router.beforeEach((_to, _from, next) => {
    const delta = pendingBrowserDelta;
    pendingBrowserDelta = null;

    if (delta !== null && delta < 0) {
      browserInterceptionInFlight = true;
      next(false);
      goBack();
      return;
    }

    if (delta !== null && delta > 0) {
      browserInterceptionInFlight = true;
      next(false);
      goForward();
      return;
    }

    next();
  });

  router.afterEach(
    (
      to: RouteLocationNormalized,
      from: RouteLocationNormalized,
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

      if (toComparablePath(to) === toComparablePath(from)) {
        notifyHistoryChange();
        return;
      }

      const leaving = currentRouteInfo;

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

  const handleSetCurrentTab = (tab: string) => {
    const currentPathname = currentRouteInfo?.pathname ?? router.currentRoute.value.path;
    contextHistory.handleSetCurrentTab(tab, currentPathname);
  };

  const registerHistoryChangeListener = (cb: () => void) => {
    historyChangeListeners.push(cb);
  };

  const getContextSnapshot = () => contextHistory.snapshot();

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
  };
};
