import assert from "node:assert/strict";
import { formatSdkModelRefreshFailure } from "../../dist/service/sdk/refresh_models.js";

test("formatSdkModelRefreshFailure explains runtime image publish delays separately from auth issues", () => {
  const message = formatSdkModelRefreshFailure(
    "codex",
    new Error("manifest for companyhelm/runner:0.0.11 not found: manifest unknown"),
  );

  assert.match(message, /runner image is not available from Docker yet/i);
  assert.match(message, /Wait for the image publish to finish or set runtime_image to an available tag/i);
  assert.doesNotMatch(message, /valid auth/i);
});

test("formatSdkModelRefreshFailure keeps the auth guidance for non-image failures", () => {
  const message = formatSdkModelRefreshFailure("codex", new Error("connection reset by peer"));

  assert.match(message, /valid auth/i);
});
