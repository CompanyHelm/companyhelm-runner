import { TemplateRenderer } from "../template_renderer.js";

export type RuntimeWorkspaceMode = "shared" | "dedicated";

export interface RuntimeSystemPromptOptions {
  homeDirectory: string;
  agentApiUrl: string;
  agentToken: string;
  threadId: string;
  workspaceMode: RuntimeWorkspaceMode;
}

function normalizeAdditionalInstructions(value: string | null | undefined): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export class RuntimeSystemPromptRenderer {
  constructor(private readonly templateRenderer = new TemplateRenderer()) {}

  render(options: RuntimeSystemPromptOptions): string {
    const context = {
      home_directory: options.homeDirectory,
      agent_api_url: options.agentApiUrl,
      agent_token: options.agentToken,
      thread_id: options.threadId,
    };
    const common = this.templateRenderer.render("system_prompts/common.md.j2", context).trim();
    const workspaceSpecificTemplate = options.workspaceMode === "dedicated"
      ? "system_prompts/dedicated_workspace.md.j2"
      : "system_prompts/shared_workspace.md.j2";
    const workspaceSpecific = this.templateRenderer.render(workspaceSpecificTemplate, context).trim();

    return `${common}\n\n${workspaceSpecific}\n`;
  }
}

export function renderRuntimeSystemPrompt(options: RuntimeSystemPromptOptions): string {
  return new RuntimeSystemPromptRenderer().render(options);
}

export function buildCodexDeveloperInstructions(
  additionalInstructions: string | null | undefined,
  options: RuntimeSystemPromptOptions,
): string {
  const systemPrompt = renderRuntimeSystemPrompt(options).trimEnd();
  const normalizedAdditionalInstructions = normalizeAdditionalInstructions(additionalInstructions);
  if (!normalizedAdditionalInstructions) {
    return `${systemPrompt}\n`;
  }

  return `${systemPrompt}\n\n${normalizedAdditionalInstructions}\n`;
}
