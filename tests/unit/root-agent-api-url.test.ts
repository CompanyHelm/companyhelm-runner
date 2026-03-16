import assert from "node:assert/strict";
import { normalizeThreadAgentApiUrlForRuntime } from "../../dist/commands/root.js";

test("normalizeThreadAgentApiUrlForRuntime rewrites localhost-style targets to http://host.docker.internal", () => {
  assert.equal(
    normalizeThreadAgentApiUrlForRuntime("localhost:50052/agent/v1"),
    "http://host.docker.internal:50052/agent/v1",
  );
  assert.equal(
    normalizeThreadAgentApiUrlForRuntime("127.0.0.1:50052/agent/v1"),
    "http://host.docker.internal:50052/agent/v1",
  );
  assert.equal(
    normalizeThreadAgentApiUrlForRuntime("[::1]:50052/agent/v1"),
    "http://host.docker.internal:50052/agent/v1",
  );
  assert.equal(
    normalizeThreadAgentApiUrlForRuntime("http://localhost:50052/agent/v1"),
    "http://host.docker.internal:50052/agent/v1",
  );
  assert.equal(
    normalizeThreadAgentApiUrlForRuntime("https://127.0.0.1:50052/agent/v1"),
    "https://host.docker.internal:50052/agent/v1",
  );
});

test("normalizeThreadAgentApiUrlForRuntime preserves non-local endpoints", () => {
  assert.equal(
    normalizeThreadAgentApiUrlForRuntime("api.companyhelm.com/agent/v1"),
    "api.companyhelm.com/agent/v1",
  );
  assert.equal(
    normalizeThreadAgentApiUrlForRuntime("https://api.companyhelm.com/agent/v1"),
    "https://api.companyhelm.com/agent/v1",
  );
});
