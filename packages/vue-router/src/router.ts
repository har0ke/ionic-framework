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

/**
 * Extract the search/query portion from a Vue Router fullPath,
 * stripping hash fragments. Hash changes do not trigger Ionic page
 * transitions, so they are excluded from route comparison.
 */
const getSearchFromFullPath = (fullPath: string): string => {
  const [pathAndSearch] = fullPath.split("#", 1);
  const [, search = ""] = pathAndSearch.split("?", 2);
  return search;
};

/**
 * Build a comparable path string (pathname + query, no hash) from a
 * Vue Router resolved route. Used for deduplication and plan matching.
 */
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

/**
 * Create the Ionic Vue Router integration layer.
 *
 * Wraps a Vue Router instance with context-aware navigation (tabs, back
 * fallback, prepare+commit lifecycle). Installs `beforeEach`/`afterEach`
 * hooks for browser-history interception and plan verification.
 *
 * Returned methods are injected as `"navManager"` for use by IonTabBar,
 * IonTabButton, IonBackButton, IonRouterOutlet, and the `useIonRouter` hook.
 */
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
   * Execute a prepared plan: store it as pending and dispatch the router call.
   */
  const executePlan = (plan: PreparedPlan, animation?: AnimationBuilder): void => {
    pendingPlan = { plan, animation: animation ?? plan.animation };

    // void: afterEach handles all navigation outcomes (success, failure,
    // redirect). The promise is intentionally not awaited.
    if (plan.transport === "replace") {
      void router.replace(plan.target);
    } else {
      void router.push(plan.target);
    }
  };

  /**
   * Navigate forward or backward by `delta` steps using context-aware
   * traversal. Negative = back, positive = forward. Dispatches via
   * prepare+commit pattern through Vue Router.
   */
  const go = (delta: number, routerAnimation?: AnimationBuilder) => {
    const plan = contextHistory.prepareGo(delta);
    if (plan === null) {
      return;
    }

    executePlan(plan, routerAnimation);
  };

  /**
   * Navigate one step back in the active context. At cursor 0, falls
   * back to rootHref (tab) or "/" (default). Uses replace semantics.
   * Called by `useIonRouter().back()` and the `ionBackButton` handler.
   */
  const goBack = (routerAnimation?: AnimationBuilder) => {
    const plan = contextHistory.prepareBack();
    if (plan === null) {
      return;
    }

    executePlan(plan, routerAnimation);
  };

  /**
   * Navigate one step forward in the active context. No-op if there
   * are no forward entries. Uses replace semantics.
   */
  const goForward = (routerAnimation?: AnimationBuilder) => {
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

  // ── afterEach: Vue Router redirect/cancellation behavior ──────────
  //
  // Vue Router 4 has two redirect mechanisms with different afterEach
  // implications:
  //
  // 1. Guard redirect (return "/other" or next("/other")):
  //    Vue Router handles this internally as NAVIGATION_GUARD_REDIRECT
  //    (error type 2, not publicly exposed). It recursively calls
  //    pushWithRedirect and fires afterEach ONLY ONCE for the final
  //    resolved destination, with failure = undefined (success).
  //    Our afterEach never sees the original navigation at all.
  //    The expectedComparableTarget mismatch catches this: the plan
  //    was for "/a" but we arrived at "/b", so the plan is dropped
  //    and the navigation is treated as external.
  //
  // 2. Imperative router.push/replace inside a guard:
  //    This starts a separate navigation. Vue Router detects the
  //    pendingLocation changed via checkCanceledNavigation and fires
  //    afterEach for the ORIGINAL navigation with failure.type ===
  //    NavigationFailureType.cancelled. Then the replacement
  //    navigation gets its own afterEach (success or failure).
  //    We preserve pendingPlan on cancelled so the replacement
  //    navigation's afterEach can consume it. This is safe because:
  //    - If the replacement is from user code (not executePlan),
  //      no new pendingPlan is set, and the stale plan's
  //      expectedComparableTarget will mismatch → plan dropped.
  //    - If the replacement IS from executePlan (rapid-fire,
  //      unsupported), executePlan already overwrote pendingPlan
  //      with the new plan before dispatching.
  //
  // 3. NavigationFailureType.duplicated:
  //    Navigating to the current URL. No state change needed.
  //    We clear pending.
  //
  // In all cases, the prepare+commit pattern guarantees no context
  // history state was mutated before afterEach confirms success.
  // ────────────────────────────────────────────────────────────────────

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

        // Always reset browser interception flag on any failure, even
        // if it wasn't the interception abort above. Prevents the flag
        // from staying true permanently if the re-dispatched navigation
        // itself fails with cancelled or duplicated.
        browserInterceptionInFlight = false;

        if (failure.type === NavigationFailureType.aborted) {
          // No rollback needed: prepare+commit means no state was mutated.
          clearPending();
        } else if (failure.type === NavigationFailureType.cancelled) {
          // Preserve pending — see comment block above for rationale.
        } else {
          // duplicated or unknown failure types.
          clearPending();
        }

        return;
      }

      browserInterceptionInFlight = false;

      const { plan: consumedPlan, hint: consumedHint } = clearPending();
      const leaving = currentRouteInfo;

      // Deduplicate: if the resolved URL matches the current route, skip.
      // This uses `leaving` (captured before clearPending) which is the
      // pre-commit state — correct because no plan has been committed yet.
      // The prepared-plan path below has its own dedup via expectedComparableTarget.
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

  /**
   * Navigate back using the IonBackButton / swipe-back contract.
   *
   * Uses `prepareBack(defaultHref)` which respects rootHref for tab
   * contexts and falls back to `defaultHref > "/"` for the default
   * context. Always uses replace semantics (no push-for-back).
   * No-op if back is fully blocked (already at effective default).
   *
   * @param defaultHref     - Fallback URL from `IonBackButton.defaultHref`
   * @param routerAnimation - Transition animation override
   */
  const handleNavigateBack = (
    defaultHref?: string,
    routerAnimation?: AnimationBuilder
  ) => {
    const plan = contextHistory.prepareBack(defaultHref, routerAnimation);

    if (plan !== null) {
      executePlan(plan, routerAnimation);
      return;
    }

    // Back is fully blocked (already at the effective default target).
    // Nothing to do.
  };

  /**
   * Navigate to a path with explicit action and direction hints.
   *
   * This is the "external navigation" entry point — it does NOT use the
   * prepare+commit pattern. Instead it stores a `pendingHint` with the
   * caller's direction/animation/action, and the afterEach classifies
   * the navigation via push/replace on the context history.
   *
   * Called by `useIonRouter().push/replace/navigate()` and IonRouterOutlet.
   *
   * @param path             - Vue Router route location (string or object)
   * @param routerAction     - "push" or "replace" (default "push")
   * @param routerDirection  - "forward", "back", "root", or "none" (default "forward")
   * @param routerAnimation  - Transition animation override
   */
  const handleNavigate = (
    path: RouteLocationRaw,
    routerAction: RouteAction = "push",
    routerDirection: RouteDirection = "forward",
    routerAnimation?: AnimationBuilder
  ) => {
    pendingHint = {
      direction: routerDirection,
      animation: routerAnimation,
      action: routerAction,
    };

    // void: afterEach handles all navigation outcomes.
    if (routerAction === "replace") {
      void router.replace(path);
    } else {
      void router.push(path);
    }
  };

  /**
   * Convenience wrapper over `handleNavigate` accepting an options object.
   * Destructures `ExternalNavigationOptions` and delegates.
   */
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

  /**
   * Switch to a tab context via prepare+commit. The plan navigates to the
   * tab's last-visited entry, or synthesizes one from `path` if the tab
   * stack is empty. No-op if `path` is falsy.
   *
   * Called by IonTabButton when the user taps a different tab.
   *
   * @param tab  - Tab context identifier
   * @param path - Fallback URL / current href for the tab
   */
  const changeTab = (tab: string, path?: string) => {
    if (!path) {
      return;
    }

    const plan = contextHistory.prepareChangeTab(tab, path);
    executePlan(plan);
  };

  /**
   * Reset a tab to its root entry via prepare+commit. Truncates child-page
   * history. No-op if the tab is not the active context.
   *
   * Called by IonTabButton when the user taps the already-active tab.
   *
   * @param tab         - Tab context identifier
   * @param defaultHref - Expected root URL for the tab
   */
  const resetTab = (tab: string, defaultHref?: string) => {
    const plan = contextHistory.prepareResetTab(tab, defaultHref);
    if (plan === null) {
      return;
    }

    executePlan(plan);
  };

  /**
   * Clear all navigation history across all contexts and navigate to
   * `redirectTo`. Used for hard-reset scenarios (e.g. logout).
   */
  const resetAll = (redirectTo: string) => {
    const plan = contextHistory.prepareResetAll(redirectTo);
    executePlan(plan);
  };

  /** Return the current route metadata, or undefined before first navigation. */
  const getCurrentRouteInfo = (): RouteInfo | undefined => currentRouteInfo;

  /**
   * Return the route info for the page being navigated away from.
   * Falls back to `currentRouteInfo` if no leaving info has been set yet
   * (i.e. before the first navigation completes).
   */
  const getLeavingRouteInfo = (): RouteInfo | undefined =>
    leavingRouteInfo ?? currentRouteInfo;

  /**
   * Check whether going back `deep` steps is possible in the active context.
   * Uses implicit defaults only (rootHref for tabs, "/" otherwise).
   * Does NOT accept a `defaultHref` — the public API is context-aware only.
   */
  const canGoBack = (deep = 1): boolean => contextHistory.canGoBack(deep);

  /**
   * Check whether going forward `deep` steps is possible in the active context.
   */
  const canGoForward = (deep = 1): boolean => contextHistory.canGoForward(deep);

  /**
   * Register a tab context and store its root href for back-fallback.
   *
   * @param tab - Tab context identifier
   * @param rootHref - The tab button's original href (source of truth for
   *   context matching prefix and back-fallback at cursor 0).
   */
  const handleSetCurrentTab = (tab: string, rootHref: string) => {
    contextHistory.handleSetCurrentTab(tab, rootHref);
  };

  /**
   * Register a callback that fires after every successful navigation.
   * Used by IonTabBar to re-check active tab state.
   */
  const registerHistoryChangeListener = (cb: () => void) => {
    historyChangeListeners.push(cb);
  };

  /**
   * Return a read-only snapshot of the context-history model for debugging
   * and devtools. Not part of the navigation correctness story.
   */
  const getContextSnapshot = () => contextHistory.snapshot();

  /**
   * Return the set of pathnames that should be retained in the DOM by
   * IonRouterOutlet (entries at or before cursor in every context).
   */
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
