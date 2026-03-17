import assert from "node:assert/strict";
import {
  resolveThreadMetadataDirectory,
  resolveThreadWorkspaceDirectory,
} from "../../dist/provisioning/host_provisioning/thread_workspace_provisioner.js";

test("resolveThreadWorkspaceDirectory uses the configured shared workspace path when dedicated workspaces are disabled", () => {
  const resolved = resolveThreadWorkspaceDirectory({
    configDirectory: "/config/companyhelm",
    workspacesDirectory: "workspaces",
    workspacePath: "/tmp/companyhelm-shared-workspace",
    useDedicatedWorkspaces: false,
    threadId: "123",
  });

  assert.equal(resolved, "/tmp/companyhelm-shared-workspace");
});

test("resolveThreadWorkspaceDirectory keeps per-thread directories when dedicated workspaces are enabled", () => {
  const resolved = resolveThreadWorkspaceDirectory({
    configDirectory: "/config/companyhelm",
    workspacesDirectory: "workspaces",
    workspacePath: "/tmp/companyhelm-shared-workspace",
    useDedicatedWorkspaces: true,
    threadId: "123",
  });

  assert.equal(resolved, "/config/companyhelm/workspaces/thread-123");
});

test("resolveThreadMetadataDirectory stores host-side metadata outside the workspace", () => {
  const resolved = resolveThreadMetadataDirectory("/config/companyhelm", "123");

  assert.equal(resolved, "/config/companyhelm/thread-metadata/thread-123");
});
