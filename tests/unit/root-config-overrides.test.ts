import assert from "node:assert/strict";
import {
  buildRootConfig,
  formatApiConnectionFailureDiagnostics,
  formatApiConnectionFailureMessage,
  isRetryableApiConnectionError,
} from "../../dist/commands/root.js";
import * as grpc from "@grpc/grpc-js";

test("buildRootConfig maps config and state path CLI overrides", () => {
  const cfg = buildRootConfig({
    configPath: "/tmp/companyhelm-config",
    stateDbPath: "/tmp/companyhelm-state.db",
    serverUrl: "https://example.com:50051",
    agentApiUrl: "https://example.com/agent/v1",
  });

  assert.equal(cfg.config_directory, "/tmp/companyhelm-config");
  assert.equal(cfg.state_db_path, "/tmp/companyhelm-state.db");
  assert.equal(cfg.companyhelm_api_url, "https://example.com:50051");
  assert.equal(cfg.agent_api_url, "https://example.com/agent/v1");
});

test("buildRootConfig resolves relative state path CLI overrides under config path", () => {
  const cfg = buildRootConfig({
    configPath: "/tmp/companyhelm-config",
    stateDbPath: "state.db",
  });

  assert.equal(cfg.config_directory, "/tmp/companyhelm-config");
  assert.equal(cfg.state_db_path, "/tmp/companyhelm-config/state.db");
});

test("isRetryableApiConnectionError returns false for unauthenticated gRPC failures", () => {
  const error = Object.assign(new Error("Missing authorization header."), {
    code: grpc.status.UNAUTHENTICATED,
  });

  assert.equal(isRetryableApiConnectionError(error), false);
});

test("formatApiConnectionFailureMessage includes grpc status and endpoint", () => {
  const error = Object.assign(new Error("13 INTERNAL: Internal server error."), {
    code: grpc.status.INTERNAL,
    details: "Internal server error.",
  });

  assert.equal(
    formatApiConnectionFailureMessage(error, "https://api.example.com/grpc", "secret"),
    "gRPC INTERNAL (13): Internal server error. [endpoint=https://api.example.com/grpc]",
  );
});

test("formatApiConnectionFailureDiagnostics includes metadata and stack for grpc errors", () => {
  const metadata = new grpc.Metadata();
  metadata.set("x-request-id", "req-123");
  const error = Object.assign(new Error("13 INTERNAL: Internal server error."), {
    code: grpc.status.INTERNAL,
    details: "Internal server error.",
    metadata,
    stack: "Error: boom\n    at test",
  });

  const diagnostics = formatApiConnectionFailureDiagnostics(error);

  assert.match(diagnostics ?? "", /code=13/);
  assert.match(diagnostics ?? "", /status=INTERNAL/);
  assert.match(diagnostics ?? "", /metadata=\{\"x-request-id\":\"req-123\"\}/);
  assert.match(diagnostics ?? "", /stack=/);
});
