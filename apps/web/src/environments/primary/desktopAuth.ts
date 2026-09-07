// The desktop main process owns token lifetime and refresh. The renderer only
// coalesces an in-flight IPC read so independent HTTP requests do not race to
// ask for the same token while still observing the main process's next token.
let desktopBearerTokenPromise: Promise<string> | null = null;

export function readDesktopPrimaryBearerToken(): Promise<string | null> {
  if (typeof window === "undefined") {
    return Promise.resolve(null);
  }
  const bridge = window.desktopBridge;
  if (!bridge) {
    return Promise.resolve(null);
  }

  if (desktopBearerTokenPromise !== null) {
    return desktopBearerTokenPromise;
  }

  const request = bridge.getLocalEnvironmentBearerToken();
  desktopBearerTokenPromise = request;
  void request.then(
    () => {
      if (desktopBearerTokenPromise === request) {
        desktopBearerTokenPromise = null;
      }
    },
    () => {
      if (desktopBearerTokenPromise === request) {
        desktopBearerTokenPromise = null;
      }
    },
  );
  return request;
}

export function __resetDesktopPrimaryAuthForTests(): void {
  desktopBearerTokenPromise = null;
}
