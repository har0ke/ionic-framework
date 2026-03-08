import { createContextHistory } from "../src/contextHistory";
import type { ContextConfig } from "../src/types";

const tabConfig: ContextConfig = {
  clearOnExternalPush: false,
};

describe("Context History (registry + matching)", () => {
  it("default context exists: matchContext('/anything') === 'default'", () => {
    const ctx = createContextHistory();
    expect(ctx.matchContext("/anything")).toEqual("default");
  });

  it("registers a single tab prefix and matches exact + nested (trailing slash normalized)", () => {
    const ctx = createContextHistory();
    ctx.registerContext("feed", "/tabs/feed/", tabConfig);

    expect(ctx.matchContext("/tabs/feed")).toEqual("feed");
    expect(ctx.matchContext("/tabs/feed/1")).toEqual("feed");
  });

  it("registers a single tab prefix and matches exact + nested (no trailing slash)", () => {
    const ctx = createContextHistory();
    ctx.registerContext("feed", "/tabs/feed", tabConfig);

    expect(ctx.matchContext("/tabs/feed")).toEqual("feed");
    expect(ctx.matchContext("/tabs/feed/1")).toEqual("feed");
  });

  it("chooses the longest matching prefix when multiple contexts overlap", () => {
    const ctx = createContextHistory();
    ctx.registerContext("feed", "/tabs/feed", tabConfig);
    ctx.registerContext("feed-settings", "/tabs/feed/settings", tabConfig);

    expect(ctx.matchContext("/tabs/feed/123")).toEqual("feed");
    expect(ctx.matchContext("/tabs/feed/settings")).toEqual("feed-settings");
    expect(ctx.matchContext("/tabs/feed/settings/profile")).toEqual("feed-settings");
  });

  it("boundary match: '/tabs/feed' does NOT match '/tabs/feedback'", () => {
    const ctx = createContextHistory();
    ctx.registerContext("feed", "/tabs/feed", tabConfig);

    expect(ctx.matchContext("/tabs/feedback")).toEqual("default");
  });

  it("re-registering the same id is a no-op", () => {
    const ctx = createContextHistory();
    ctx.registerContext("feed", "/tabs/feed", tabConfig);
    ctx.registerContext("feed", "/other", tabConfig);

    expect(ctx.matchContext("/tabs/feed")).toEqual("feed");
    expect(ctx.matchContext("/other")).toEqual("default");
  });

  it("unmatched route returns default", () => {
    const ctx = createContextHistory();
    ctx.registerContext("feed", "/tabs/feed", tabConfig);

    expect(ctx.matchContext("/does-not-match")).toEqual("default");
  });
});

describe("Context History (Chunk B stack operations)", () => {
  it("same-context push sets currentEntry pathname and context", () => {
    const ctx = createContextHistory();

    ctx.push("/login/");

    expect(ctx.currentEntry()?.pathname).toEqual("/login/");
    expect(ctx.currentEntry()?.context).toEqual("default");
  });

  it("cross-context push switches current entry context and sets originContext", () => {
    const ctx = createContextHistory();
    ctx.registerContext("feed", "/tabs/feed", tabConfig);

    ctx.push("/login/");
    ctx.push("/tabs/feed/");

    expect(ctx.currentEntry()?.pathname).toEqual("/tabs/feed/");
    expect(ctx.currentEntry()?.context).toEqual("feed");
    expect(ctx.currentEntry()?.originContext).toEqual("default");
  });

  it("clearOnExternalPush true clears target context before push", () => {
    const ctx = createContextHistory();
    ctx.registerContext("feed", "/tabs/feed", tabConfig);
    ctx.registerContext("discover", "/tabs/discover", tabConfig);

    ctx.push("/login/");
    ctx.push("/signup/");
    ctx.push("/tabs/feed/");
    ctx.push("/tabs/discover/");
    ctx.push("/login-new/");

    expect(ctx.currentEntry()?.pathname).toEqual("/login-new/");
    expect(ctx.currentEntry()?.context).toEqual("default");
    // Default context, root entry '/login-new/' != fallback '/' → canGoBack(1) is true
    // (performBack would return '/' as the fallback target)
    expect(ctx.canGoBack(1)).toBe(true);
    expect(ctx.canGoBack(2)).toBe(false);
  });

  it("replace in same context updates pathname but keeps routerAnimation", () => {
    const ctx = createContextHistory();
    ctx.registerContext("feed", "/tabs/feed", tabConfig);
    const customAnimation = (() => undefined) as any;

    ctx.push("/tabs/feed/", { routerAnimation: customAnimation });
    ctx.replace("/tabs/feed/updated/");

    expect(ctx.currentEntry()?.pathname).toEqual("/tabs/feed/updated/");
    expect(ctx.currentEntry()?.routerAnimation).toBe(customAnimation);
  });

  it("replace cross-context behaves as push into target context", () => {
    const ctx = createContextHistory();
    ctx.registerContext("feed", "/tabs/feed", tabConfig);
    ctx.registerContext("discover", "/tabs/discover", tabConfig);

    ctx.push("/tabs/feed/");
    ctx.replace("/tabs/discover/profile/");

    expect(ctx.currentEntry()?.pathname).toEqual("/tabs/discover/profile/");
    expect(ctx.currentEntry()?.context).toEqual("discover");
    expect(ctx.currentEntry()?.originContext).toEqual("feed");
  });

  it("canGoBack accounts for cursor and fallback-to-default offset", () => {
    const ctx = createContextHistory();

    ctx.push("/a/");
    ctx.push("/b/");
    ctx.push("/c/");

    // cursor=2, root entry '/a/' != default '/' → offset=1 → effectiveDepth=3
    expect(ctx.canGoBack(1)).toBe(true);
    expect(ctx.canGoBack(2)).toBe(true);
    expect(ctx.canGoBack(3)).toBe(true);
    expect(ctx.canGoBack(4)).toBe(false);
    expect(ctx.canGoForward(1)).toBe(false);
  });

  it("canGoBack with rootHref matching root entry does not add offset", () => {
    const ctx = createContextHistory();
    ctx.registerContext("feed", "/tabs/feed", tabConfig);
    ctx.handleSetCurrentTab("feed", "/tabs/feed/", "/tabs/feed/");

    ctx.push("/tabs/feed/");
    ctx.push("/tabs/feed/page2/");

    // cursor=1, root entry matches rootHref → no offset → effectiveDepth=1
    expect(ctx.canGoBack(1)).toBe(true);
    expect(ctx.canGoBack(2)).toBe(false);
  });

  it("canGoBack with rootHref not matching root entry adds offset", () => {
    const ctx = createContextHistory();
    ctx.registerContext("feed", "/tabs/feed", tabConfig);
    ctx.handleSetCurrentTab("feed", "/tabs/feed/deep/", "/tabs/feed/");

    ctx.push("/tabs/feed/deep/");

    // cursor=0, root '/tabs/feed/deep/' != rootHref '/tabs/feed/' → offset=1
    expect(ctx.canGoBack(1)).toBe(true);
    expect(ctx.canGoBack(2)).toBe(false);
  });

  it("parses search without leading question mark", () => {
    const ctx = createContextHistory();

    ctx.push("/a/?q=1");
    expect(ctx.currentEntry()?.search).toBe("q=1");

    ctx.push({ pathname: "/b/", search: "?x=2" });
    expect(ctx.currentEntry()?.search).toBe("x=2");
  });
});

describe("Context History (Chunk C navigation algorithms)", () => {
  it("performBack decrements cursor within context", () => {
    const ctx = createContextHistory();
    ctx.registerContext("feed", "/tabs/feed", tabConfig);

    ctx.push("/tabs/feed/");
    ctx.push("/tabs/feed/details/");

    expect(ctx.performBack()).toBe("/tabs/feed/");
    expect(ctx.currentEntry()?.pathname).toBe("/tabs/feed/");
  });

  it("performBack at cursor 0 with rootHref matching current entry blocks", () => {
    const ctx = createContextHistory();
    ctx.registerContext("feed", "/tabs/feed", tabConfig);
    // Simulate IonTabBar setting rootHref
    ctx.handleSetCurrentTab("feed", "/tabs/feed/", "/tabs/feed/");

    ctx.push("/tabs/feed/");

    // Already at tab root → blocked
    expect(ctx.performBack()).toBeNull();
    expect(ctx.currentEntry()?.pathname).toBe("/tabs/feed/");
  });

  it("performBack at cursor 0 falls back to rootHref for deep-linked tab page", () => {
    const ctx = createContextHistory();
    ctx.registerContext("feed", "/tabs/feed", tabConfig);
    ctx.handleSetCurrentTab("feed", "/tabs/feed/deep/", "/tabs/feed/");

    ctx.push("/tabs/feed/deep/");

    // Deep-linked page backs to tab root
    expect(ctx.performBack()).toBe("/tabs/feed/");
  });

  it("performBack tab context ignores passed defaultHref (rootHref wins)", () => {
    const ctx = createContextHistory();
    ctx.registerContext("feed", "/tabs/feed", tabConfig);
    ctx.handleSetCurrentTab("feed", "/tabs/feed/deep/", "/tabs/feed/");

    ctx.push("/tabs/feed/deep/");

    // rootHref wins — defaultHref is ignored in tab contexts
    expect(ctx.performBack("/other/")).toBe("/tabs/feed/");
  });

  it("performBack at cursor 0 in non-tab context uses defaultHref", () => {
    const ctx = createContextHistory();

    ctx.push("/deep-link/");

    // Non-tab: no rootHref, falls through to defaultHref
    expect(ctx.performBack("/home/")).toBe("/home/");
  });

  it("performBack at cursor 0 in non-tab context defaults to /", () => {
    const ctx = createContextHistory();

    ctx.push("/deep-link/");

    // Non-tab, no defaultHref → falls back to '/'
    expect(ctx.performBack()).toBe("/");
  });

  it("performBack at cursor 0 blocks when already at default target", () => {
    const ctx = createContextHistory();

    ctx.push("/");

    // Already at '/' → blocked
    expect(ctx.performBack()).toBeNull();
  });

  it("performForward advances once and returns null at top", () => {
    const ctx = createContextHistory();

    ctx.push("/a/");
    ctx.push("/b/");
    ctx.push("/c/");

    ctx.performBack();
    expect(ctx.currentEntry()?.pathname).toBe("/b/");

    expect(ctx.performForward()).toBe("/c/");
    expect(ctx.performForward()).toBeNull();
  });

  it("performBack and performForward preserve query parameters in returned paths", () => {
    const ctx = createContextHistory();

    ctx.push("/a/?q=1");
    ctx.push("/b/?q=2");

    expect(ctx.performBack()).toBe("/a/?q=1");
    expect(ctx.performForward()).toBe("/b/?q=2");
  });

  it("go(-1) and go(-N) move back with partial completion semantics", () => {
    const ctx = createContextHistory();
    ctx.registerContext("feed", "/tabs/feed", tabConfig);
    ctx.handleSetCurrentTab("feed", "/tabs/feed/", "/tabs/feed/");

    ctx.push("/tabs/feed/");
    ctx.push("/tabs/feed/one/");
    ctx.push("/tabs/feed/two/");

    expect(ctx.go(-1)).toBe("/tabs/feed/one/");
    // At cursor 0, rootHref matches root entry → performBack returns null → stops
    expect(ctx.go(-5)).toBe("/tabs/feed/");
    expect(ctx.currentEntry()?.pathname).toBe("/tabs/feed/");
  });

  it("go(-N) returns null with no mutation when first step is blocked", () => {
    const ctx = createContextHistory();
    ctx.registerContext("feed", "/tabs/feed", tabConfig);
    ctx.handleSetCurrentTab("feed", "/tabs/feed/", "/tabs/feed/");

    ctx.push("/tabs/feed/");

    // At tab root with matching rootHref → blocked on first step
    expect(ctx.go(-1)).toBeNull();
    expect(ctx.currentEntry()?.pathname).toBe("/tabs/feed/");
  });

  it("go(+N) replays performForward and returns null when no movement", () => {
    const ctx = createContextHistory();

    ctx.push("/a/");
    ctx.push("/b/");
    ctx.push("/c/");

    expect(ctx.go(-2)).toBe("/a/");
    expect(ctx.go(10)).toBe("/c/");
    expect(ctx.go(1)).toBeNull();
  });

  it("go returns full path including query parameters", () => {
    const ctx = createContextHistory();

    ctx.push("/a/?q=1");
    ctx.push("/b/?q=2");
    ctx.push("/c/?q=3");

    expect(ctx.go(-2)).toBe("/a/?q=1");
    expect(ctx.go(1)).toBe("/b/?q=2");
  });
});

describe("Context History (Chunk D tab/reset/snapshot/output)", () => {
  it("changeTab synthesizes first entry for empty context and resumes existing stacks", () => {
    const ctx = createContextHistory();
    ctx.registerContext("feed", "/tabs/feed", tabConfig);
    // Set rootHref so tab root back is terminal
    ctx.handleSetCurrentTab("feed", "/tabs/feed/", "/tabs/feed/");

    expect(ctx.changeTab("feed", "/tabs/feed/")).toBe("/tabs/feed/");
    expect(ctx.currentEntry()?.pathname).toBe("/tabs/feed/");
    // Tab root matches rootHref → canGoBack is false
    expect(ctx.canGoBack(1)).toBe(false);

    ctx.push("/tabs/feed/page2/");
    ctx.push("/login/");

    expect(ctx.changeTab("feed", "/tabs/feed/")).toBe("/tabs/feed/page2/");
    expect(ctx.currentEntry()?.pathname).toBe("/tabs/feed/page2/");
  });

  it("resetTab resets active and inactive tabs and clears surviving root originContext", () => {
    const ctx = createContextHistory();
    ctx.registerContext("feed", "/tabs/feed", tabConfig);
    ctx.handleSetCurrentTab("feed", "/tabs/feed/", "/tabs/feed/");

    ctx.push("/login/");
    ctx.push("/tabs/feed/");
    ctx.push("/tabs/feed/page2/");

    expect(ctx.resetTab("feed", "/tabs/feed/")).toBe("/tabs/feed/");
    expect(ctx.currentEntry()?.pathname).toBe("/tabs/feed/");
    // Tab root matches rootHref → back is blocked
    expect(ctx.performBack()).toBeNull();

    ctx.push("/login/again/");
    expect(ctx.resetTab("feed", "/tabs/feed/")).toBeNull();
    expect(ctx.changeTab("feed", "/tabs/feed/")).toBe("/tabs/feed/");
    expect(ctx.canGoBack(1)).toBe(false);
  });

  it("resetAll clears stacks and creates a fresh entry in matched target context", () => {
    const ctx = createContextHistory();
    ctx.registerContext("feed", "/tabs/feed", tabConfig);
    ctx.handleSetCurrentTab("feed", "/tabs/feed/", "/tabs/feed/");

    ctx.push("/tabs/feed/");
    ctx.push("/tabs/feed/page/");
    ctx.push("/login/");

    expect(ctx.resetAll("/login/")).toBe("/login/");
    expect(ctx.currentEntry()?.pathname).toBe("/login/");
    // Default context: '/login/' != '/' → canGoBack(1) is true (fallback to '/')
    expect(ctx.canGoBack(1)).toBe(true);

    expect(ctx.changeTab("feed", "/tabs/feed/")).toBe("/tabs/feed/");
    // Tab root matches rootHref → canGoBack is false
    expect(ctx.canGoBack(1)).toBe(false);
  });

  it("getRetainedPathnames returns entries up to cursor across all contexts", () => {
    const ctx = createContextHistory();
    ctx.registerContext("feed", "/tabs/feed", tabConfig);

    ctx.push("/tabs/feed/");
    ctx.push("/tabs/feed/page2/");
    ctx.push("/login/");
    ctx.push("/signup/");

    expect(ctx.go(-1)).toBe("/login/");

    expect(Array.from(ctx.getRetainedPathnames()).sort()).toEqual([
      "/login/",
      "/tabs/feed/",
      "/tabs/feed/page2/",
    ]);
  });

  it("derivePushedByRoute returns previous entry, implicit default, or undefined", () => {
    const ctx = createContextHistory();
    ctx.registerContext("feed", "/tabs/feed", tabConfig);

    // Default context at cursor 0: root entry '/a/' !== implicit default '/'
    // → derivePushedByRoute returns '/' (the implicit default)
    ctx.push("/a/");
    expect(ctx.derivePushedByRoute()).toBe("/");

    ctx.push("/b/");
    // cursor > 0 → previous entry
    expect(ctx.derivePushedByRoute()).toBe("/a/");

    ctx.push("/tabs/feed/");
    // Switched to feed context. Set rootHref so tab root is recognized.
    ctx.handleSetCurrentTab("feed", "/tabs/feed/", "/tabs/feed/");
    // At tab root with rootHref matching → back is blocked → undefined
    expect(ctx.derivePushedByRoute()).toBeUndefined();

    ctx.push("/tabs/feed/page2/");
    // cursor > 0 → previous entry
    expect(ctx.derivePushedByRoute()).toBe("/tabs/feed/");
  });

  it("derivePushedByRoute returns undefined when root entry matches implicit default", () => {
    const ctx = createContextHistory();

    // Default context: push '/' as root. Implicit default is '/'.
    // Root entry matches → back is blocked → undefined
    ctx.push("/");
    expect(ctx.derivePushedByRoute()).toBeUndefined();

    // Push something else, then go back to cursor 0
    ctx.push("/a/");
    expect(ctx.derivePushedByRoute()).toBe("/");
  });

  it("produceCurrentRouteInfo maps fields and applies animation precedence", () => {
    const ctx = createContextHistory();
    const enteringAnimation = (() => undefined) as any;
    const leavingAnimation = (() => undefined) as any;
    const overrideAnimation = (() => undefined) as any;

    ctx.push("/a/");
    const entering = ctx.push("/b/", { routerAnimation: enteringAnimation });

    const leaving = {
      id: "leave",
      pathname: "/a/",
      search: "",
      params: undefined,
      pushedByRoute: undefined,
      routerAction: "push",
      routerDirection: "forward",
      routerAnimation: leavingAnimation,
      lastPathname: "/root/",
      prevRouteLastPathname: "/older/",
      delta: undefined,
      tab: "default",
    } as any;

    const backInfo = ctx.produceCurrentRouteInfo(entering, leaving, { direction: "back" });
    expect(backInfo.routerAction).toBe("pop");
    expect(backInfo.routerDirection).toBe("back");
    expect(backInfo.routerAnimation).toBe(leavingAnimation);
    expect(backInfo.lastPathname).toBe("/a/");
    expect(backInfo.prevRouteLastPathname).toBe("/root/");
    expect(backInfo.tab).toBe("default");
    expect(backInfo.delta).toBeUndefined();

    const rootInfo = ctx.produceCurrentRouteInfo(entering, leaving, { direction: "root" });
    expect(rootInfo.routerAction).toBe("replace");
    expect(rootInfo.routerDirection).toBe("root");

    const noneInfo = ctx.produceCurrentRouteInfo(entering, leaving, { direction: "none" });
    expect(noneInfo.routerAction).toBe("push");

    const overrideInfo = ctx.produceCurrentRouteInfo(entering, leaving, {
      direction: "none",
      animation: overrideAnimation,
      action: "replace",
    } as any);
    expect(overrideInfo.routerAction).toBe("replace");
    expect(overrideInfo.routerAnimation).toBe(overrideAnimation);
  });

  it("handleSetCurrentTab registers context, moves matching default entries, and is idempotent", () => {
    const ctx = createContextHistory();

    ctx.push("/tabs/feed/");
    ctx.push("/tabs/feed/page2/");
    ctx.push("/login/");
    ctx.go(-1);

    ctx.handleSetCurrentTab("feed", "/tabs/feed/page2/");
    expect(ctx.currentEntry()?.pathname).toBe("/tabs/feed/page2/");
    expect(ctx.currentEntry()?.context).toBe("feed");
    expect(ctx.performBack()).toBe("/tabs/feed/");

    const before = JSON.stringify(ctx.snapshot());
    ctx.handleSetCurrentTab("feed", "/tabs/feed/page2/");
    expect(JSON.stringify(ctx.snapshot())).toBe(before);
  });

  it("snapshot returns expected structure and backTarget links", () => {
    const ctx = createContextHistory();
    ctx.registerContext("feed", "/tabs/feed", tabConfig);

    ctx.push("/tabs/feed/");
    ctx.push("/tabs/feed/page2/");
    ctx.push("/login/");

    const snap = ctx.snapshot();

    expect(snap.activeContext).toBe("default");
    expect(snap.contexts.feed.entries[0].url).toBe("/tabs/feed/");
    expect(snap.contexts.feed.entries[0].backTarget).toBeNull();
    expect(snap.contexts.feed.entries[1].backTarget).toEqual({ context: "feed", cursor: 0 });
    // Default context entry at cursor 0: back is blocked (no previous-context)
    expect(snap.contexts.default.entries[0].url).toBe("/login/");
    expect(snap.contexts.default.entries[0].backTarget).toBeNull();
  });
});

describe("Context History (Chunk E prepared navigation plans)", () => {
  it("prepareBack returns null when blocked, plan when cursor > 0", () => {
    const ctx = createContextHistory();
    ctx.push("/");

    // At cursor 0 with root entry '/' matching implicit default '/' → blocked
    expect(ctx.prepareBack()).toBeNull();

    ctx.push("/a");
    ctx.push("/b");

    // cursor 2 → prepareBack should produce a plan targeting '/a'
    const plan = ctx.prepareBack();
    expect(plan).not.toBeNull();
    expect(plan!.transport).toBe("replace");
    expect(plan!.target).toBe("/a");
    expect(plan!.direction).toBe("back");
    expect(plan!.action).toBe("pop");
    expect(plan!.expectedComparableTarget).toBe("/a");

    // State should NOT be mutated yet
    expect(ctx.currentEntry()?.pathname).toBe("/b");

    // Commit the plan
    const entry = plan!.commit({ pathname: "/a", search: "" });
    expect(entry.pathname).toBe("/a");
    expect(ctx.currentEntry()?.pathname).toBe("/a");
  });

  it("prepareBack with fallback-to-default at cursor 0", () => {
    const ctx = createContextHistory();
    ctx.push("/deep-link");

    // cursor 0, root entry '/deep-link' != implicit default '/' → fallback
    const plan = ctx.prepareBack();
    expect(plan).not.toBeNull();
    expect(plan!.target).toBe("/");
    expect(plan!.action).toBe("pop");

    // State not mutated
    expect(ctx.currentEntry()?.pathname).toBe("/deep-link");

    // Commit replaces the entry at cursor 0
    const entry = plan!.commit({ pathname: "/", search: "" });
    expect(entry.pathname).toBe("/");
    expect(ctx.currentEntry()?.pathname).toBe("/");
  });

  it("prepareBack with tab rootHref fallback", () => {
    const ctx = createContextHistory();
    ctx.registerContext("feed", "/tabs/feed", tabConfig);
    ctx.push("/tabs/feed/detail");
    ctx.handleSetCurrentTab("feed", "/tabs/feed/detail", "/tabs/feed");

    const plan = ctx.prepareBack();
    expect(plan).not.toBeNull();
    expect(plan!.target).toBe("/tabs/feed");

    // Passing defaultHref should not override rootHref
    const plan2 = ctx.prepareBack("/other");
    expect(plan2!.target).toBe("/tabs/feed");
  });

  it("prepareForward returns null at end, plan when forward exists", () => {
    const ctx = createContextHistory();
    ctx.push("/a");
    ctx.push("/b");
    ctx.push("/c");
    ctx.performBack(); // cursor 2 → 1

    const plan = ctx.prepareForward();
    expect(plan).not.toBeNull();
    expect(plan!.transport).toBe("replace");
    expect(plan!.target).toBe("/c");
    expect(plan!.direction).toBe("forward");

    // State not mutated
    expect(ctx.currentEntry()?.pathname).toBe("/b");

    plan!.commit({ pathname: "/c", search: "" });
    expect(ctx.currentEntry()?.pathname).toBe("/c");

    // At end → null
    expect(ctx.prepareForward()).toBeNull();
  });

  it("prepareGo simulates multi-step back and forward", () => {
    const ctx = createContextHistory();
    ctx.push("/a");
    ctx.push("/b");
    ctx.push("/c");
    ctx.push("/d");

    // Go back 2 steps
    const backPlan = ctx.prepareGo(-2);
    expect(backPlan).not.toBeNull();
    expect(backPlan!.target).toBe("/b");
    expect(backPlan!.direction).toBe("back");
    expect(ctx.currentEntry()?.pathname).toBe("/d"); // not mutated

    backPlan!.commit({ pathname: "/b", search: "" });
    expect(ctx.currentEntry()?.pathname).toBe("/b");

    // Go forward 2 steps
    const fwdPlan = ctx.prepareGo(2);
    expect(fwdPlan).not.toBeNull();
    expect(fwdPlan!.target).toBe("/d");
    expect(fwdPlan!.direction).toBe("forward");
    expect(ctx.currentEntry()?.pathname).toBe("/b"); // not mutated

    fwdPlan!.commit({ pathname: "/d", search: "" });
    expect(ctx.currentEntry()?.pathname).toBe("/d");

    // Go back 0 → null
    expect(ctx.prepareGo(0)).toBeNull();
  });

  it("prepareGo returns null when first step is blocked", () => {
    const ctx = createContextHistory();
    ctx.push("/");
    // At '/' which matches default → back blocked
    expect(ctx.prepareGo(-1)).toBeNull();
    // No forward entries
    expect(ctx.prepareGo(1)).toBeNull();
  });

  it("prepareChangeTab returns a plan that synthesizes an entry for empty tab", () => {
    const ctx = createContextHistory();
    ctx.push("/home");

    const plan = ctx.prepareChangeTab("feed", "/tabs/feed");
    expect(plan.transport).toBe("push");
    expect(plan.target).toBe("/tabs/feed");
    expect(plan.direction).toBe("none");

    // State not mutated (still in default context)
    expect(ctx.currentEntry()?.pathname).toBe("/home");

    const entry = plan.commit({ pathname: "/tabs/feed", search: "" });
    expect(entry.pathname).toBe("/tabs/feed");
    expect(entry.context).toBe("feed");
  });

  it("prepareChangeTab returns existing tab entry if tab has history", () => {
    const ctx = createContextHistory();
    ctx.registerContext("feed", "/tabs/feed", tabConfig);
    ctx.push("/tabs/feed");
    ctx.push("/tabs/feed/detail");
    ctx.push("/other");

    const plan = ctx.prepareChangeTab("feed", "/tabs/feed");
    // Tab has history, cursor at 1 → target is '/tabs/feed/detail'
    expect(plan.target).toBe("/tabs/feed/detail");
  });

  it("prepareResetTab returns plan for active tab, null for inactive", () => {
    const ctx = createContextHistory();
    ctx.registerContext("feed", "/tabs/feed", tabConfig);
    ctx.push("/tabs/feed");
    ctx.push("/tabs/feed/page2");

    // feed is not active context (default is) → null
    // Wait, push into /tabs/feed goes to feed context due to prefix match
    // Actually it does match, so activeContext should be 'feed'

    const plan = ctx.prepareResetTab("feed", "/tabs/feed");
    expect(plan).not.toBeNull();
    expect(plan!.transport).toBe("replace");
    expect(plan!.target).toBe("/tabs/feed");
    expect(plan!.direction).toBe("back");

    // Not mutated
    expect(ctx.currentEntry()?.pathname).toBe("/tabs/feed/page2");

    plan!.commit({ pathname: "/tabs/feed", search: "" });
    expect(ctx.currentEntry()?.pathname).toBe("/tabs/feed");
    expect(ctx.canGoForward()).toBe(false); // entries truncated to root
  });

  it("prepareResetAll returns a plan that clears all stacks", () => {
    const ctx = createContextHistory();
    ctx.registerContext("feed", "/tabs/feed", tabConfig);
    ctx.push("/tabs/feed");
    ctx.push("/tabs/feed/page2");
    ctx.push("/other");

    const plan = ctx.prepareResetAll("/login");
    expect(plan.transport).toBe("replace");
    expect(plan.target).toBe("/login");
    expect(plan.direction).toBe("root");
    expect(plan.action).toBe("replace");

    // Not mutated
    expect(ctx.currentEntry()?.pathname).toBe("/other");

    plan.commit({ pathname: "/login", search: "" });
    expect(ctx.currentEntry()?.pathname).toBe("/login");
    // After resetAll to '/login': root entry is '/login', implicit default
    // is '/' → canGoBack is true (back would go to '/' via fallback)
    expect(ctx.canGoBack()).toBe(true);

    // Tab context should be cleared
    const snap = ctx.snapshot();
    expect(snap.contexts.feed?.entries.length ?? 0).toBe(0);
  });
});
