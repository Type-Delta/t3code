import { Schema } from "effect";
import { describe, expect, it } from "vite-plus/test";

import {
  ConfiguredLocalServerUrls,
  CONFIGURED_LOCAL_SERVER_URLS_MAX_ITEMS,
  DiscoveredLocalServer,
  PREVIEW_URL_MAX_LENGTH,
  PreviewEvent,
  PreviewNavStatus,
  PreviewSessionSnapshot,
  PreviewViewportSetting,
} from "./preview.ts";
import {
  PreviewAutomationHost,
  PreviewAutomationError,
  PreviewAutomationOpenInput,
  PreviewAutomationResizeInput,
  PreviewAutomationResizeResult,
  PreviewAutomationStatus,
  PreviewAutomationResponse,
  PreviewAutomationStreamEvent,
} from "./previewAutomation.ts";

const decodeSnapshot = Schema.decodeUnknownSync(PreviewSessionSnapshot);
const decodeNavStatus = Schema.decodeUnknownSync(PreviewNavStatus);
const decodeViewport = Schema.decodeUnknownSync(PreviewViewportSetting);
const decodeResizeInput = Schema.decodeUnknownSync(PreviewAutomationResizeInput);
const decodeOpenInput = Schema.decodeUnknownSync(PreviewAutomationOpenInput);
const decodeResizeResult = Schema.decodeUnknownSync(PreviewAutomationResizeResult);
const decodeAutomationHost = Schema.decodeUnknownSync(PreviewAutomationHost);
const decodeAutomationStatus = Schema.decodeUnknownSync(PreviewAutomationStatus);

describe("preview automation acknowledgement compatibility", () => {
  it("preserves the negotiated capability and the started response across the wire", () => {
    const connected = {
      type: "connected",
      connectionId: "connection-1",
      supportsRequestAcknowledgement: true,
    };
    expect(Schema.decodeUnknownSync(PreviewAutomationStreamEvent)(connected)).toEqual(connected);
    const started = {
      clientId: "client-1",
      connectionId: "connection-1",
      requestId: "request-1",
      phase: "started",
      ok: true,
    };
    expect(Schema.decodeUnknownSync(PreviewAutomationResponse)(started)).toEqual(started);
  });

  it("accepts connections and final responses from older clients", () => {
    const connected = { type: "connected", connectionId: "connection-1" };
    expect(Schema.decodeUnknownSync(PreviewAutomationStreamEvent)(connected)).toEqual(connected);
    const completed = {
      clientId: "client-1",
      connectionId: "connection-1",
      requestId: "request-1",
      ok: true,
      result: { available: true },
    };
    expect(Schema.decodeSync(PreviewAutomationResponse)(completed)).toEqual(completed);
  });
});

describe("PreviewAutomationOpenInput", () => {
  it("accepts the inline preview visibility flag", () => {
    expect(decodeOpenInput({ open: false })).toEqual({ open: false });
  });

  it("retains the legacy show visibility alias", () => {
    expect(decodeOpenInput({ show: false })).toEqual({ show: false });
  });
});

describe("PreviewNavStatus", () => {
  it("decodes Idle", () => {
    expect(decodeNavStatus({ _tag: "Idle" })).toEqual({ _tag: "Idle" });
  });

  it("decodes Loading with title", () => {
    expect(decodeNavStatus({ _tag: "Loading", url: "http://localhost:5173/", title: "" })).toEqual({
      _tag: "Loading",
      url: "http://localhost:5173/",
      title: "",
    });
  });

  it("decodes LoadFailed with code/description", () => {
    expect(
      decodeNavStatus({
        _tag: "LoadFailed",
        url: "https://example.com/",
        title: "Example",
        code: -105,
        description: "ERR_NAME_NOT_RESOLVED",
      }),
    ).toEqual({
      _tag: "LoadFailed",
      url: "https://example.com/",
      title: "Example",
      code: -105,
      description: "ERR_NAME_NOT_RESOLVED",
    });
  });

  it("rejects empty url", () => {
    expect(() => decodeNavStatus({ _tag: "Loading", url: "", title: "" })).toThrow();
  });
});

describe("PreviewSessionSnapshot", () => {
  it("round-trips a Success snapshot", () => {
    const snapshot = decodeSnapshot({
      threadId: "thread-1",
      tabId: "preview-thread-1",
      navStatus: {
        _tag: "Success",
        url: "http://localhost:5173/",
        title: "Vite App",
      },
      canGoBack: false,
      canGoForward: false,
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    expect(snapshot.tabId).toBe("preview-thread-1");
    expect(snapshot.navStatus._tag).toBe("Success");
  });
});

describe("PreviewViewportSetting", () => {
  it("decodes fill, freeform, and preset modes", () => {
    expect(decodeViewport({ _tag: "fill" })).toEqual({ _tag: "fill" });
    expect(decodeViewport({ _tag: "freeform", width: 1024, height: 768 })).toEqual({
      _tag: "freeform",
      width: 1024,
      height: 768,
    });
    expect(
      decodeViewport({
        _tag: "preset",
        presetId: "iphone-15-pro",
        width: 393,
        height: 852,
      }),
    ).toMatchObject({ _tag: "preset", presetId: "iphone-15-pro" });
  });

  it("rejects unsafe dimensions and oversized render areas", () => {
    expect(() => decodeViewport({ _tag: "freeform", width: 100, height: 800 })).toThrow();
    expect(() => decodeViewport({ _tag: "freeform", width: 3840, height: 3840 })).toThrow();
  });
});

describe("PreviewAutomationResizeInput", () => {
  it("requires fields that match the selected mode", () => {
    expect(decodeResizeInput({ mode: "fill" })).toEqual({ mode: "fill" });
    expect(
      decodeResizeInput({ mode: "preset", preset: "pixel-7", orientation: "landscape" }),
    ).toMatchObject({ mode: "preset", preset: "pixel-7" });
    expect(() => decodeResizeInput({ mode: "preset", preset: "pixel-8" })).toThrow();
    expect(() => decodeResizeInput({ mode: "freeform", width: 1024 })).toThrow();
    expect(() => decodeResizeInput({ mode: "fill", width: 1024, height: 768 })).toThrow();
  });

  it("allows fill-mode measurements below the minimum selectable fixed size", () => {
    expect(
      decodeResizeResult({
        tabId: "preview-t",
        setting: { _tag: "fill" },
        viewport: { width: 180, height: 120 },
      }).viewport,
    ).toEqual({ width: 180, height: 120 });
  });
});

describe("preview automation tab targeting", () => {
  it("accepts an explicit tab and rejects contradictory open behavior", () => {
    expect(decodeResizeInput({ tabId: "tab-app", mode: "fill" })).toMatchObject({
      tabId: "tab-app",
      mode: "fill",
    });
    expect(decodeOpenInput({ tabId: "tab-app", reuseExistingTab: true })).toMatchObject({
      tabId: "tab-app",
      reuseExistingTab: true,
    });
    expect(() => decodeOpenInput({ tabId: "tab-app", reuseExistingTab: false })).toThrow();
  });
});

describe("PreviewAutomationHost", () => {
  it("accepts legacy hosts and current operation advertisements", () => {
    expect(decodeAutomationHost({ clientId: "legacy", environmentId: "environment-1" })).toEqual({
      clientId: "legacy",
      environmentId: "environment-1",
    });
    expect(
      decodeAutomationHost({
        clientId: "current",
        environmentId: "environment-1",
        supportedOperations: ["status", "resize"],
      }).supportedOperations,
    ).toEqual(["status", "resize"]);
  });
});

describe("PreviewAutomationStatus", () => {
  it("accepts old hosts without viewport data and exposes it from current hosts", () => {
    const base = {
      available: true,
      visible: false,
      tabId: "preview-t",
      url: "https://example.com",
      title: "Example",
      loading: false,
    };
    expect(decodeAutomationStatus(base)).toEqual(base);
    expect(
      decodeAutomationStatus({
        ...base,
        viewportSetting: { _tag: "preset", presetId: "pixel-8", width: 412, height: 915 },
        viewport: { width: 412, height: 915 },
      }).viewport,
    ).toEqual({ width: 412, height: 915 });
  });
});
