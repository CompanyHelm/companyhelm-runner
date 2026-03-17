import assert from "node:assert/strict";
import {
  buildCodexDeveloperInstructions,
  renderRuntimeSystemPrompt,
} from "../../dist/provisioning/runtime_provisioning/system_prompt.js";

test("renderRuntimeSystemPrompt includes common and shared workspace guidance", () => {
  const rendered = renderRuntimeSystemPrompt({
    homeDirectory: "/home/agent",
    agentApiUrl: "http://host.docker.internal:3000/agent/v1",
    agentToken: "thread-secret-123",
    workspaceMode: "shared",
  });

  assert.equal(rendered.includes("## Workspace Structure"), true);
  assert.equal(rendered.includes("## Shared Workspace"), true);
  assert.equal(rendered.includes("## Dedicated Workspace"), false);
  assert.equal(rendered.includes("/home/agent/.companyhelm/agent/installations.json"), true);
  assert.equal(rendered.includes("list-installations"), true);
  assert.equal(rendered.includes("gh-use-installation"), true);
  assert.equal(rendered.includes("http://host.docker.internal:3000/agent/v1"), true);
  assert.equal(rendered.includes("thread-secret-123"), true);
  assert.equal(rendered.includes("{{"), false);
});

test("renderRuntimeSystemPrompt includes dedicated workspace guidance when requested", () => {
  const rendered = renderRuntimeSystemPrompt({
    homeDirectory: "/home/agent",
    agentApiUrl: "http://host.docker.internal:3000/agent/v1",
    agentToken: "thread-secret-123",
    workspaceMode: "dedicated",
  });

  assert.equal(rendered.includes("## Dedicated Workspace"), true);
  assert.equal(rendered.includes("## Shared Workspace"), false);
});

test("buildCodexDeveloperInstructions prepends the rendered system prompt to additional instructions", () => {
  const rendered = buildCodexDeveloperInstructions("  Ask for explicit assumptions before coding.  ", {
    homeDirectory: "/home/agent",
    agentApiUrl: "http://host.docker.internal:3000/agent/v1",
    agentToken: "thread-secret-123",
    workspaceMode: "shared",
  });

  assert.ok(rendered);
  assert.equal(rendered.startsWith("# Agent Instructions"), true);
  assert.equal(rendered.includes("Ask for explicit assumptions before coding."), true);
  assert.equal(
    rendered.trimEnd().endsWith("Ask for explicit assumptions before coding."),
    true,
  );
});
