import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { COMPILE_CACHE_DIR_NAME, compileCacheEnvironment } from "../src/worker-client.js";

describe("the worker's compile cache", () => {
  it("lives under the host's state directory, keyed by the Node that will read it", () => {
    expect(compileCacheEnvironment({}, "/state")).toEqual({
      NODE_COMPILE_CACHE: join("/state", COMPILE_CACHE_DIR_NAME, `node-${process.versions.node}`),
    });
  });
  it("is only a hint: no state directory, or an explicit choice, leaves the launch environment alone", () => {
    expect(compileCacheEnvironment({}, undefined)).toEqual({});
    expect(compileCacheEnvironment({ NODE_COMPILE_CACHE: "/elsewhere" }, "/state")).toEqual({});
    expect(compileCacheEnvironment({ NODE_DISABLE_COMPILE_CACHE: "1" }, "/state")).toEqual({});
  });
});
