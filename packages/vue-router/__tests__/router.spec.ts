/** @jest-environment jsdom */

import { NavigationFailureType } from "vue-router";

import { createIonRouter } from "../src/router";

type MockRoute = {
  path: string;
  fullPath: string;
  params: Record<string, any>;
};

const createRoute = (url: string): MockRoute => {
  const [pathWithSearchAndHash] = url.split("#", 1);
  const [path] = pathWithSearchAndHash.split("?", 1);

  return {
    path,
    fullPath: url,
    params: {},
  };
};

const createRouterHarness = (initialPath = "/") => {
  let beforeEachGuard:
    | ((to: any, from: any, next: (value?: any) => void) => void)
    | undefined;
  let afterEachHook:
    | ((to: any, from: any, failure?: any) => void)
    | undefined;
  let historyListener: ((to: any, from: any, info: any) => void) | undefined;

  const history = {
    state: {
      replaced: false,
    },
    listen: jest.fn((cb: any) => {
      historyListener = cb;
    }),
  };

  const router = {
    currentRoute: {
      value: createRoute(initialPath),
    },
    beforeEach: jest.fn((cb: any) => {
      beforeEachGuard = cb;
    }),
    afterEach: jest.fn((cb: any) => {
      afterEachHook = cb;
    }),
    push: jest.fn(),
    replace: jest.fn(),
    go: jest.fn(),
    back: jest.fn(),
    forward: jest.fn(),
  };

  const nav = createIonRouter({ history } as any, router as any);

  const commitNavigation = (
    toUrl: string,
    options?: {
      replaced?: boolean;
      failureType?: NavigationFailureType;
    }
  ) => {
    const to = createRoute(toUrl);
    const from = router.currentRoute.value;

    let nextArg: any = undefined;
    beforeEachGuard?.(to, from, (value?: any) => {
      nextArg = value;
    });

    if (nextArg === false) {
      afterEachHook?.(to, from, { type: NavigationFailureType.aborted });
      return;
    }

    if (options?.failureType !== undefined) {
      afterEachHook?.(to, from, { type: options.failureType });
      return;
    }

    history.state.replaced = Boolean(options?.replaced);
    router.currentRoute.value = to;
    afterEachHook?.(to, from);
  };

  const emitBrowserDelta = (delta: number) => {
    historyListener?.(undefined, undefined, { delta });
  };

  const runBeforeEachOnly = (toUrl: string) => {
    const to = createRoute(toUrl);
    const from = router.currentRoute.value;
    let nextArg: any;
    beforeEachGuard?.(to, from, (value?: any) => {
      nextArg = value;
    });
    return nextArg;
  };

  const runAfterEachOnly = (
    toUrl: string,
    fromUrl: string,
    failureType?: NavigationFailureType
  ) => {
    const to = createRoute(toUrl);
    const from = createRoute(fromUrl);
    afterEachHook?.(
      to,
      from,
      failureType === undefined ? undefined : { type: failureType }
    );
  };

  return {
    history,
    nav,
    router,
    commitNavigation,
    emitBrowserDelta,
    runBeforeEachOnly,
    runAfterEachOnly,
  };
};

describe("createIonRouter integration", () => {
  it("supports handleNavigate/goBack/goForward/handleNavigateBack flows", () => {
    const h = createRouterHarness("/");

    h.nav.handleNavigate("/a", "push", "forward");
    expect(h.router.push).toHaveBeenCalledWith("/a");
    h.commitNavigation("/a");

    h.nav.handleNavigate("/b", "push", "forward");
    expect(h.router.push).toHaveBeenCalledWith("/b");
    h.commitNavigation("/b");

    expect(h.nav.getCurrentRouteInfo()?.pathname).toBe("/b");
    expect(h.nav.canGoBack()).toBe(true);

    h.nav.goBack();
    expect(h.router.replace).toHaveBeenLastCalledWith("/a");
    h.commitNavigation("/a", { replaced: true });
    expect(h.nav.getCurrentRouteInfo()?.routerDirection).toBe("back");
    expect(h.nav.getCurrentRouteInfo()?.routerAction).toBe("pop");

    h.nav.goForward();
    expect(h.router.replace).toHaveBeenLastCalledWith("/b");
    h.commitNavigation("/b", { replaced: true });
    expect(h.nav.getCurrentRouteInfo()?.routerDirection).toBe("forward");

    h.nav.handleNavigateBack("/fallback");
    expect(h.router.replace).toHaveBeenLastCalledWith("/a");
    h.commitNavigation("/a", { replaced: true });

    // At cursor 0 in default context, performBack("/fallback") returns
    // "/fallback" (the caller-supplied defaultHref) since root "/a" != "/fallback"
    h.nav.handleNavigateBack("/fallback");
    expect(h.router.replace).toHaveBeenLastCalledWith("/fallback");
    h.commitNavigation("/fallback", { replaced: true });
    expect(h.nav.getCurrentRouteInfo()?.pathname).toBe("/fallback");
    expect(h.nav.getCurrentRouteInfo()?.routerDirection).toBe("back");
    expect(h.nav.getCurrentRouteInfo()?.routerAction).toBe("pop");
  });

  it("intercepts browser back/forward in beforeEach", () => {
    const h = createRouterHarness("/");

    h.nav.handleNavigate("/a", "push", "forward");
    h.commitNavigation("/a");
    h.nav.handleNavigate("/b", "push", "forward");
    h.commitNavigation("/b");

    h.emitBrowserDelta(-1);
    const nextBack = h.runBeforeEachOnly("/a");
    expect(nextBack).toBe(false);
    expect(h.router.replace).toHaveBeenLastCalledWith("/a");

    h.nav.goBack();
    h.commitNavigation("/a", { replaced: true });

    h.emitBrowserDelta(1);
    const nextForward = h.runBeforeEachOnly("/b");
    expect(nextForward).toBe(false);
    expect(h.router.replace).toHaveBeenLastCalledWith("/b");
  });

  it("replays deep history deltas through context-aware go steps", () => {
    const h = createRouterHarness("/");

    h.nav.handleNavigate("/a", "push", "forward");
    h.commitNavigation("/a");
    h.nav.handleNavigate("/b", "push", "forward");
    h.commitNavigation("/b");
    h.nav.handleNavigate("/c", "push", "forward");
    h.commitNavigation("/c");

    h.emitBrowserDelta(-2);
    h.commitNavigation("/a");

    expect(h.router.replace).toHaveBeenLastCalledWith("/a");

    h.commitNavigation("/a", { replaced: true });
    expect(h.nav.getCurrentRouteInfo()?.pathname).toBe("/a");
    // Default context at cursor 0: '/a' != '/' → fallback-to-default adds +1
    expect(h.nav.canGoBack()).toBe(true);
    expect(h.nav.canGoBack(2)).toBe(false);
    expect(h.nav.canGoForward(2)).toBe(true);

    h.emitBrowserDelta(2);
    h.commitNavigation("/c");

    expect(h.router.replace).toHaveBeenLastCalledWith("/c");

    h.commitNavigation("/c", { replaced: true });
    expect(h.nav.getCurrentRouteInfo()?.pathname).toBe("/c");
    expect(h.nav.canGoBack(2)).toBe(true);
  });

  it("wraps router.go to replay deep context-aware steps directly", () => {
    const h = createRouterHarness("/");
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});

    try {
      h.nav.handleNavigate("/a", "push", "forward");
      h.commitNavigation("/a");
      h.nav.handleNavigate("/b", "push", "forward");
      h.commitNavigation("/b");
      h.nav.handleNavigate("/c", "push", "forward");
      h.commitNavigation("/c");

      h.router.go(-2);
      expect(h.router.replace).toHaveBeenLastCalledWith("/a");
      h.commitNavigation("/a", { replaced: true });

      expect(h.nav.getCurrentRouteInfo()?.pathname).toBe("/a");
      // Default context at cursor 0: '/a' != '/' → canGoBack true
      expect(h.nav.canGoBack()).toBe(true);
      expect(h.nav.canGoForward(2)).toBe(true);

      h.router.go(2);
      expect(h.router.replace).toHaveBeenLastCalledWith("/c");
      h.commitNavigation("/c", { replaced: true });

      expect(h.nav.getCurrentRouteInfo()?.pathname).toBe("/c");
      expect(h.nav.canGoBack(2)).toBe(true);

      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0][0]).toContain("router.go(-2)");
    } finally {
      warn.mockRestore();
    }
  });

  it("exposes retained pathnames from context history", () => {
    const h = createRouterHarness("/");

    h.nav.handleNavigate("/a", "push", "forward");
    h.commitNavigation("/a");
    h.nav.handleNavigate("/b", "push", "forward");
    h.commitNavigation("/b");
    h.nav.handleNavigate("/c", "push", "forward");
    h.commitNavigation("/c");

    h.nav.goBack();
    h.commitNavigation("/b", { replaced: true });

    expect(Array.from(h.nav.getRetainedPathnames()).sort()).toEqual([
      "/a",
      "/b",
    ]);
  });

  it("warns once per overridden traversal method", () => {
    const h = createRouterHarness("/");
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});

    try {
      h.router.back();
      h.router.back();
      h.router.forward();
      h.router.forward();
      h.router.go(-1);
      h.router.go(1);

      expect(warn).toHaveBeenCalledTimes(3);
      expect(warn.mock.calls[0][0]).toContain("router.back()");
      expect(warn.mock.calls[1][0]).toContain("router.forward()");
      expect(warn.mock.calls[2][0]).toContain("router.go(-1)");
    } finally {
      warn.mockRestore();
    }
  });

  it("browser interception abort does not clear the re-dispatched plan", () => {
    const h = createRouterHarness("/");

    h.nav.handleNavigate("/a", "push", "forward");
    h.commitNavigation("/a");
    h.nav.handleNavigate("/b", "push", "forward");
    h.commitNavigation("/b");

    h.emitBrowserDelta(-1);
    h.commitNavigation("/a");

    expect(h.router.replace).toHaveBeenLastCalledWith("/a");

    h.commitNavigation("/a", { replaced: true });

    expect(h.nav.getCurrentRouteInfo()?.pathname).toBe("/a");
    expect(h.nav.getCurrentRouteInfo()?.routerDirection).toBe("back");
    expect(h.nav.getCurrentRouteInfo()?.routerAction).toBe("pop");
    expect(h.nav.canGoForward()).toBe(true);
  });

  it("aborted plan has no effect; cancelled plan is kept for successor", () => {
    const h = createRouterHarness("/");

    h.nav.handleNavigate("/a", "push", "forward");
    h.commitNavigation("/a");
    h.nav.handleNavigate("/b", "push", "forward");
    h.commitNavigation("/b");

    h.nav.goBack();
    expect(h.router.replace).toHaveBeenLastCalledWith("/a");
    h.runAfterEachOnly("/a", "/b", NavigationFailureType.aborted);

    expect(h.nav.getCurrentRouteInfo()?.pathname).toBe("/b");
    expect(h.nav.canGoForward()).toBe(false);

    h.nav.handleNavigate("/c", "push", "forward");
    h.commitNavigation("/c");

    h.nav.goBack();
    h.nav.goBack();
    expect(h.router.replace).toHaveBeenNthCalledWith(2, "/b");
    expect(h.router.replace).toHaveBeenNthCalledWith(3, "/a");

    h.runAfterEachOnly("/b", "/c", NavigationFailureType.cancelled);
    h.runAfterEachOnly("/a", "/b");

    expect(h.nav.getCurrentRouteInfo()?.pathname).toBe("/a");
    expect(h.nav.getCurrentRouteInfo()?.routerDirection).toBe("back");
    expect(h.nav.canGoForward(2)).toBe(true);
  });

  it("skips same-URL mutation but still notifies listeners", () => {
    const h = createRouterHarness("/");
    const listener = jest.fn();

    h.nav.registerHistoryChangeListener(listener);
    h.nav.handleNavigate("/a", "push", "forward");
    h.commitNavigation("/a");
    const previousRouteInfo = h.nav.getCurrentRouteInfo();

    h.nav.handleNavigate("/a", "push", "forward");
    h.commitNavigation("/a");

    expect(listener).toHaveBeenCalledTimes(2);
    expect(h.nav.getCurrentRouteInfo()).toBe(previousRouteInfo);
    // Only entry is "/a" in default context, root '/a' != '/' → canGoBack true
    expect(h.nav.canGoBack()).toBe(true);
  });

  it("produces initial route info even when the first confirmed route matches the current URL", () => {
    const h = createRouterHarness("/");

    h.commitNavigation("/");

    expect(h.nav.getCurrentRouteInfo()?.pathname).toBe("/");
    expect(h.nav.getCurrentRouteInfo()?.routerAction).toBe("push");
    expect(h.nav.getCurrentRouteInfo()?.routerDirection).toBe("forward");
  });

  it("exposes current/leaving/canGoBack and tab registration snapshot", () => {
    const h = createRouterHarness("/");

    h.nav.handleNavigate("/tabs/feed", "push", "forward");
    h.commitNavigation("/tabs/feed");
    h.nav.handleNavigate("/tabs/feed/details", "push", "forward");
    h.commitNavigation("/tabs/feed/details");

    expect(h.nav.getCurrentRouteInfo()?.pathname).toBe("/tabs/feed/details");
    expect(h.nav.getLeavingRouteInfo()?.pathname).toBe("/tabs/feed");
    expect(h.nav.canGoBack()).toBe(true);

    h.nav.handleSetCurrentTab("feed");

    const snapshot = h.nav.getContextSnapshot();
    expect(snapshot.contexts.feed).toBeDefined();
    expect(snapshot.contexts.feed.entries[0].url).toBe("/tabs/feed");
  });

  it("delegates navigate, changeTab, resetTab, resetAll and canGoForward", () => {
    const h = createRouterHarness("/");

    h.nav.navigate({ routerLink: "/a", routerAction: "replace", routerDirection: "root" });
    expect(h.router.replace).toHaveBeenCalledWith("/a");
    h.commitNavigation("/a", { replaced: true });

    h.nav.handleNavigate("/tabs/feed", "push", "forward");
    h.commitNavigation("/tabs/feed");
    h.nav.handleSetCurrentTab("feed");

    h.nav.changeTab("feed", "/tabs/feed");
    expect(h.router.push).toHaveBeenLastCalledWith("/tabs/feed");
    h.commitNavigation("/tabs/feed");

    h.nav.handleNavigate("/tabs/feed/page2", "push", "forward");
    h.commitNavigation("/tabs/feed/page2");

    h.nav.resetTab("feed", "/tabs/feed");
    expect(h.router.replace).toHaveBeenLastCalledWith("/tabs/feed");
    h.commitNavigation("/tabs/feed", { replaced: true });

    h.nav.handleNavigate("/tabs/feed/page2", "push", "forward");
    h.commitNavigation("/tabs/feed/page2");
    h.nav.goBack();
    h.commitNavigation("/tabs/feed", { replaced: true });
    expect(h.nav.canGoForward()).toBe(true);

    h.nav.resetAll("/login");
    expect(h.router.replace).toHaveBeenLastCalledWith("/login");
    h.commitNavigation("/login", { replaced: true });
    expect(h.nav.getCurrentRouteInfo()?.routerDirection).toBe("root");
  });

  it("lazy-registers a tab context on first changeTab", () => {
    const h = createRouterHarness("/");

    h.nav.handleNavigate("/tabs/tab1", "push", "forward");
    h.commitNavigation("/tabs/tab1");

    h.nav.changeTab("tab2", "/tabs/tab2");
    expect(h.router.push).toHaveBeenLastCalledWith("/tabs/tab2");

    h.commitNavigation("/tabs/tab2");

    expect(h.nav.getCurrentRouteInfo()?.pathname).toBe("/tabs/tab2");
    expect(h.nav.getContextSnapshot().contexts.tab2).toBeDefined();
  });

  it("handles ionBackButton by calling goBack path", () => {
    const h = createRouterHarness("/");

    h.nav.handleNavigate("/a", "push", "forward");
    h.commitNavigation("/a");
    h.nav.handleNavigate("/b", "push", "forward");
    h.commitNavigation("/b");

    let registeredHandler: ((processNextHandler: () => void) => void) | undefined;
    const register = jest.fn(
      (_priority: number, handler: (processNextHandler: () => void) => void) => {
        registeredHandler = handler;
      }
    );

    document.dispatchEvent(
      new CustomEvent("ionBackButton", {
        detail: { register },
      })
    );

    expect(register).toHaveBeenCalled();

    const processNextHandler = jest.fn();
    registeredHandler?.(processNextHandler);

    expect(h.router.replace).toHaveBeenLastCalledWith("/a");
    expect(processNextHandler).toHaveBeenCalled();
  });
});
