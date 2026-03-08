import { createContextHistory } from "../src/contextHistory";
import type { ContextConfig } from "../src/types";

const tabConfig: ContextConfig = {
  backBehavior: "within-context",
  rootBackBehavior: "block",
  clearOnExternalPush: false,
  unmatchedBehavior: "default",
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
    ctx.registerContext("feed", "/other", {
      ...tabConfig,
      unmatchedBehavior: "active",
    });

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
    expect(ctx.canGoBack(1)).toBe(false);
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

  it("replace in same context inherits entry overrides unless explicitly overridden", () => {
    const ctx = createContextHistory();
    ctx.registerContext("feed", "/tabs/feed", tabConfig);

    ctx.push("/tabs/feed/", {
      backBehavior: "previous-context",
      rootBackBehavior: "previous-context",
    });
    ctx.replace("/tabs/feed/updated/");

    expect(ctx.currentEntry()?.backBehavior).toEqual("previous-context");
    expect(ctx.currentEntry()?.rootBackBehavior).toEqual("previous-context");

    ctx.replace("/tabs/feed/updated-again/", {
      backBehavior: "within-context",
      rootBackBehavior: "block",
    });

    expect(ctx.currentEntry()?.backBehavior).toEqual("within-context");
    expect(ctx.currentEntry()?.rootBackBehavior).toEqual("block");
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

  it("canGoBack and canGoForward use cursor bounds", () => {
    const ctx = createContextHistory();

    ctx.push("/a/");
    ctx.push("/b/");
    ctx.push("/c/");

    expect(ctx.canGoBack(1)).toBe(true);
    expect(ctx.canGoBack(2)).toBe(true);
    expect(ctx.canGoBack(3)).toBe(false);
    expect(ctx.canGoForward(1)).toBe(false);
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
  it("performBack decrements within context and blocks at root when configured", () => {
    const ctx = createContextHistory();
    ctx.registerContext("feed", "/tabs/feed", tabConfig);

    ctx.push("/login/");
    ctx.push("/tabs/feed/");
    ctx.push("/tabs/feed/details/");

    expect(ctx.performBack()).toBe("/tabs/feed/");
    expect(ctx.currentEntry()?.pathname).toBe("/tabs/feed/");

    expect(ctx.performBack()).toBeNull();
    expect(ctx.currentEntry()?.pathname).toBe("/tabs/feed/");
  });

  it("performBack switches to origin context for previous-context behavior", () => {
    const ctx = createContextHistory();
    ctx.registerContext("feed", "/tabs/feed", {
      ...tabConfig,
      backBehavior: "previous-context",
      rootBackBehavior: "previous-context",
    });

    ctx.push("/home/");
    ctx.push("/tabs/feed/first/");
    ctx.push("/home/again/");
    ctx.push("/tabs/feed/second/");

    expect(ctx.performBack()).toBe("/home/again/");
    expect(ctx.currentEntry()?.context).toBe("default");
    expect(ctx.currentEntry()?.pathname).toBe("/home/again/");
  });

  it("previous-context with missing origin falls back to decrement or block", () => {
    const ctx = createContextHistory();

    ctx.push("/a/");
    ctx.push("/b/", { backBehavior: "previous-context" });
    ctx.replace("/b/", { backBehavior: "previous-context", rootBackBehavior: "previous-context" });

    const nonRootEntry = ctx.currentEntry();
    if (!nonRootEntry) {
      throw new Error("Expected a current entry");
    }
    nonRootEntry.originContext = "ghost";

    expect(ctx.performBack()).toBe("/a/");
    expect(ctx.currentEntry()?.pathname).toBe("/a/");

    const rootEntry = ctx.currentEntry();
    if (!rootEntry) {
      throw new Error("Expected a current entry");
    }
    rootEntry.rootBackBehavior = "previous-context";
    rootEntry.originContext = "ghost";

    expect(ctx.performBack()).toBeNull();
    expect(ctx.currentEntry()?.pathname).toBe("/a/");
  });

  it("entry overrides take precedence over context back configuration", () => {
    const ctx = createContextHistory();
    ctx.registerContext("feed", "/tabs/feed", {
      ...tabConfig,
      backBehavior: "within-context",
      rootBackBehavior: "block",
    });

    ctx.push("/d1/");
    ctx.push("/tabs/feed/a/");
    ctx.push("/d2/");
    ctx.push("/tabs/feed/b/", { backBehavior: "previous-context" });

    expect(ctx.performBack()).toBe("/d2/");
    expect(ctx.currentEntry()?.context).toBe("default");
    expect(ctx.currentEntry()?.pathname).toBe("/d2/");
  });

  it("left-behind context cursor is preserved after previous-context switch", () => {
    const ctx = createContextHistory();
    ctx.registerContext("feed", "/tabs/feed", {
      ...tabConfig,
      backBehavior: "previous-context",
      rootBackBehavior: "previous-context",
    });

    ctx.push("/start/");
    ctx.push("/tabs/feed/a/");
    ctx.push("/start/2/", { backBehavior: "previous-context" });
    ctx.push("/tabs/feed/b/");

    expect(ctx.performBack()).toBe("/start/2/");
    expect(ctx.currentEntry()?.context).toBe("default");

    expect(ctx.performBack()).toBe("/tabs/feed/b/");
    expect(ctx.currentEntry()?.context).toBe("feed");
    expect(ctx.currentEntry()?.pathname).toBe("/tabs/feed/b/");
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

    ctx.push("/tabs/feed/");
    ctx.push("/tabs/feed/one/");
    ctx.push("/tabs/feed/two/");

    expect(ctx.go(-1)).toBe("/tabs/feed/one/");
    expect(ctx.go(-5)).toBe("/tabs/feed/");
    expect(ctx.currentEntry()?.pathname).toBe("/tabs/feed/");
  });

  it("go(-N) returns null with no mutation when first step is blocked", () => {
    const ctx = createContextHistory();
    ctx.registerContext("feed", "/tabs/feed", tabConfig);

    ctx.push("/login/");
    ctx.push("/tabs/feed/");

    expect(ctx.go(-1)).toBeNull();
    expect(ctx.currentEntry()?.pathname).toBe("/tabs/feed/");
  });

  it("go(+N) clamps to top and returns null when no movement", () => {
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
