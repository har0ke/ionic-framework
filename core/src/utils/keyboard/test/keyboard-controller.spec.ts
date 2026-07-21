import { Keyboard, KeyboardResize } from '../../native/keyboard';
import { createKeyboardController } from '../keyboard-controller';

describe('Keyboard Controller', () => {
  it('should update isKeyboardVisible', async () => {
    const keyboardCtrl = await createKeyboardController();

    window.dispatchEvent(new Event('keyboardWillShow'));
    expect(keyboardCtrl.isKeyboardVisible()).toBe(true);

    window.dispatchEvent(new Event('keyboardWillHide'));
    expect(keyboardCtrl.isKeyboardVisible()).toBe(false);
  });

  it('should run the callback', async () => {
    const callbackMock = jest.fn();
    await createKeyboardController(callbackMock);

    window.dispatchEvent(new Event('keyboardWillShow'));
    expect(callbackMock).toHaveBeenCalledWith(true, undefined);

    window.dispatchEvent(new Event('keyboardWillHide'));
    expect(callbackMock).toHaveBeenCalledWith(false, undefined);
  });
});

describe('Keyboard Controller: resize wait', () => {
  interface MockResizeObserverInstance {
    callback: () => void;
    observed: Element[];
    disconnected: boolean;
  }

  let ionApp: HTMLElement;
  let roInstances: MockResizeObserverInstance[];
  let warnSpy: jest.SpyInstance;

  const lastRo = () => roInstances[roInstances.length - 1];

  /**
   * mock-doc represents `ion-app` as a Proxy forwarding get/set to a backing
   * MockHTMLElement, so an instance `defineProperty` getter is ignored.
   * Plain assignment goes through the set trap and works.
   */
  const setContainerHeight = (height: number) => {
    (ionApp as any).clientHeight = height;
  };

  /**
   * Flush pending microtasks so promise continuations run
   * while the fake timers are installed.
   */
  const flushMicrotasks = async () => {
    for (let i = 0; i < 5; i++) {
      await Promise.resolve();
    }
  };

  const trackResolve = (promise?: Promise<void>) => {
    const state = { resolved: false };
    promise?.then(() => {
      state.resolved = true;
    });
    return state;
  };

  const showKeyboard = () => window.dispatchEvent(new Event('keyboardWillShow'));
  const hideKeyboard = () => window.dispatchEvent(new Event('keyboardWillHide'));

  beforeEach(() => {
    jest.useFakeTimers();
    warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.spyOn(Keyboard, 'getResizeMode').mockResolvedValue({ mode: KeyboardResize.Native });

    roInstances = [];
    (global as any).ResizeObserver = class {
      callback: () => void;
      observed: Element[] = [];
      disconnected = false;
      constructor(callback: () => void) {
        this.callback = callback;
        roInstances.push(this);
      }
      observe(el: Element) {
        this.observed.push(el);
      }
      disconnect() {
        this.disconnected = true;
      }
    };

    ionApp = document.createElement('ion-app');
    document.body.appendChild(ionApp);
    setContainerHeight(800);
  });

  afterEach(() => {
    ionApp.remove();
    delete (global as any).ResizeObserver;
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('resolves when the container returns to the pre-keyboard height', async () => {
    const callbackMock = jest.fn();
    await createKeyboardController(callbackMock);

    showKeyboard();
    expect(callbackMock).toHaveBeenLastCalledWith(true, undefined);

    setContainerHeight(500);
    hideKeyboard();
    const resizePromise = callbackMock.mock.calls[1][1];
    expect(resizePromise).toBeDefined();
    const wait = trackResolve(resizePromise);

    setContainerHeight(800);
    lastRo().callback();
    await flushMicrotasks();

    expect(wait.resolved).toBe(true);
    expect(lastRo().disconnected).toBe(true);

    // The safety timer was cleared: advancing time must not warn.
    jest.advanceTimersByTime(1000);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('resolves within the tolerance for subpixel height differences', async () => {
    const callbackMock = jest.fn();
    await createKeyboardController(callbackMock);

    showKeyboard();
    setContainerHeight(500);
    hideKeyboard();
    const wait = trackResolve(callbackMock.mock.calls[1][1]);

    setContainerHeight(799);
    lastRo().callback();
    await flushMicrotasks();

    expect(wait.resolved).toBe(true);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('resolves via the safety timeout when the height never returns', async () => {
    const callbackMock = jest.fn();
    await createKeyboardController(callbackMock);

    showKeyboard();
    setContainerHeight(500);
    hideKeyboard();
    const wait = trackResolve(callbackMock.mock.calls[1][1]);

    // Still shrunken: no match yet.
    lastRo().callback();
    await flushMicrotasks();
    expect(wait.resolved).toBe(false);

    jest.advanceTimersByTime(700);
    await flushMicrotasks();

    expect(wait.resolved).toBe(true);
    expect(lastRo().disconnected).toBe(true);
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it('stays bounded when the keyboard hides before it ever showed', async () => {
    const callbackMock = jest.fn();
    await createKeyboardController(callbackMock);

    hideKeyboard();
    const wait = trackResolve(callbackMock.mock.calls[0][1]);

    jest.advanceTimersByTime(700);
    await flushMicrotasks();

    expect(wait.resolved).toBe(true);
  });

  it('re-captures the baseline on show after a rotation while closed', async () => {
    const callbackMock = jest.fn();
    await createKeyboardController(callbackMock);

    // First session in "portrait".
    showKeyboard();
    setContainerHeight(500);
    hideKeyboard();
    setContainerHeight(800);
    lastRo().callback();
    await flushMicrotasks();

    // Rotate while the keyboard is closed, then a new session.
    setContainerHeight(1000);
    showKeyboard();
    setContainerHeight(700);
    hideKeyboard();
    const wait = trackResolve(callbackMock.mock.calls[3][1]);

    setContainerHeight(1000);
    lastRo().callback();
    await flushMicrotasks();

    // Without the baseline refresh this would only resolve via the
    // timeout (with a warning) because 1000 never matches the stale 800.
    expect(wait.resolved).toBe(true);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('does not re-capture the baseline while the keyboard is open', async () => {
    const callbackMock = jest.fn();
    await createKeyboardController(callbackMock);

    showKeyboard();
    setContainerHeight(500);
    // Keyboard geometry change fires another willShow while open.
    showKeyboard();

    hideKeyboard();
    const resizePromise = callbackMock.mock.calls[2][1];
    // A baseline poisoned to 500 would report "already settled" (no
    // promise) at hide time even though the webview is still shrunken.
    expect(resizePromise).toBeDefined();
    const wait = trackResolve(resizePromise);

    setContainerHeight(800);
    lastRo().callback();
    await flushMicrotasks();

    expect(wait.resolved).toBe(true);
    expect(warnSpy).not.toHaveBeenCalled();
  });
});
