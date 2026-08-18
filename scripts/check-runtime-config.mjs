import assert from "node:assert/strict";

import {
  getApiBaseUrl,
  RuntimeConfigError,
  resolveRuntimeConfig,
} from "../apps/web/lib/runtime-config.ts";

const localEnvironment = {
  apiBaseUrl: "http://localhost:8000",
  realtimeWsUrlTemplate: "ws://localhost:8000/api/v1/sessions/:sessionId/realtime",
};

assert.deepEqual(resolveRuntimeConfig({ environment: {} }), {
  apiBaseUrl: "http://localhost:8000",
  realtimeWsUrlTemplate: null,
});

assert.deepEqual(
  resolveRuntimeConfig({
    environment: {
      apiBaseUrl: "/",
      realtimeWsUrlTemplate: "/api/v1/sessions/:sessionId/realtime",
    },
  }),
  {
    apiBaseUrl: "http://localhost:8000",
    realtimeWsUrlTemplate:
      "ws://localhost:8000/api/v1/sessions/:sessionId/realtime",
  },
);

assert.deepEqual(
  resolveRuntimeConfig({
    environment: localEnvironment,
    pageUrl: "http://localhost:3000/study",
    runtimeConfig: {
      apiBaseUrl: "https://api.example.test/base/",
      realtimeWsUrlTemplate: "wss://api.example.test/realtime/:sessionId",
    },
  }),
  {
    apiBaseUrl: "https://api.example.test/base",
    realtimeWsUrlTemplate: "wss://api.example.test/realtime/:sessionId",
  },
);

assert.deepEqual(
  resolveRuntimeConfig({
    environment: {
      apiBaseUrl: "/",
      realtimeWsUrlTemplate: "/api/v1/sessions/:sessionId/realtime",
    },
    pageUrl: "https://study.example.test/spaces",
  }),
  {
    apiBaseUrl: "https://study.example.test",
    realtimeWsUrlTemplate:
      "wss://study.example.test/api/v1/sessions/:sessionId/realtime",
  },
);

assert.equal(
  resolveRuntimeConfig({
    environment: localEnvironment,
    pageUrl: "http://localhost:3000",
    runtimeConfig: { realtimeWsUrlTemplate: null },
  }).realtimeWsUrlTemplate,
  null,
);

globalThis.window = {
  location: { href: "https://companion.example.test" },
  __COMPANION_SPACE_RUNTIME_CONFIG__: {
    apiBaseUrl: "https://api-one.example.test",
  },
};
assert.equal(getApiBaseUrl(), "https://api-one.example.test");
globalThis.window.__COMPANION_SPACE_RUNTIME_CONFIG__.apiBaseUrl =
  "https://api-two.example.test";
assert.equal(getApiBaseUrl(), "https://api-two.example.test");
delete globalThis.window;

const invalidCases = [
  {
    pageUrl: "https://companion.example.test",
    runtimeConfig: { apiBaseUrl: "http://api.example.test" },
  },
  {
    pageUrl: "https://companion.example.test",
    runtimeConfig: { apiBaseUrl: "https://user:secret@api.example.test" },
  },
  {
    pageUrl: "https://companion.example.test",
    runtimeConfig: { apiBaseUrl: "https://api.example.test?token=secret" },
  },
  {
    pageUrl: "https://companion.example.test",
    runtimeConfig: { apiBaseUrl: "https://api.example.test?" },
  },
  {
    pageUrl: "https://companion.example.test",
    runtimeConfig: {
      apiBaseUrl: "https://api.example.test",
      realtimeWsUrlTemplate: "ws://api.example.test/realtime/:sessionId",
    },
  },
  {
    pageUrl: "https://companion.example.test",
    runtimeConfig: {
      apiBaseUrl: "https://api.example.test",
      realtimeWsUrlTemplate: "wss://api.example.test/realtime/:sessionId?token=secret",
    },
  },
  {
    pageUrl: "https://companion.example.test",
    runtimeConfig: {
      apiBaseUrl: "https://api.example.test",
      realtimeWsUrlTemplate: "wss://other.example.test/realtime/:sessionId",
    },
  },
  {
    pageUrl: "https://companion.example.test",
    runtimeConfig: {
      apiBaseUrl: "https://api.example.test",
      realtimeWsUrlTemplate: "wss://api.example.test/realtime/:spaceId/:sessionId",
    },
  },
];

for (const invalidCase of invalidCases) {
  assert.throws(
    () => resolveRuntimeConfig({ environment: {}, ...invalidCase }),
    RuntimeConfigError,
  );
}

console.log("runtime config checks passed");
