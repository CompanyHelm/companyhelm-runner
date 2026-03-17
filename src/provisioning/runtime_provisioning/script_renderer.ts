import { join } from "node:path";
import type {
  RuntimeAgentCliConfig,
  ThreadContainerUser,
  ThreadGitSkillProvisionOptions,
} from "../../service/thread_lifecycle.js";
import { renderRuntimeBashrc } from "../../service/runtime_bashrc.js";
import { buildNvmCodexBootstrapScript } from "../../service/runtime_shell.js";
import { TemplateRenderer } from "../template_renderer.js";

export interface RuntimeAgentMetadataFile {
  filename: string;
  content: string;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function resolveThreadGitSkillsCloneRootDirectory(options: ThreadGitSkillProvisionOptions): string {
  return options.cloneRootDirectory.trim().length > 0
    ? options.cloneRootDirectory.trim()
    : "/skills";
}

export class RuntimeProvisioningScriptRenderer {
  constructor(private readonly templateRenderer = new TemplateRenderer()) {}

  renderIdentityScript(user: ThreadContainerUser): string {
    return this.templateRenderer.render("provisioning/runtime_identity.sh.j2", {
      agent_user: shellQuote(user.agentUser),
      agent_home: shellQuote(user.agentHomeDirectory),
      agent_uid: shellQuote(String(user.uid)),
      agent_gid: shellQuote(String(user.gid)),
    });
  }

  renderToolingValidationScript(user: ThreadContainerUser): string {
    return this.templateRenderer.render("provisioning/runtime_tooling_validation.sh.j2", {
      bootstrap: buildNvmCodexBootstrapScript(user.agentHomeDirectory),
    });
  }

  renderBashrcScript(user: ThreadContainerUser): string {
    return this.templateRenderer.render("provisioning/runtime_bashrc.sh.j2", {
      agent_home: shellQuote(user.agentHomeDirectory),
      bashrc_content: shellQuote(renderRuntimeBashrc(user.agentHomeDirectory)),
    });
  }

  renderCodexConfigScript(user: ThreadContainerUser, configToml: string): string {
    return this.templateRenderer.render("provisioning/runtime_codex_config.sh.j2", {
      agent_home: shellQuote(user.agentHomeDirectory),
      config_content: shellQuote(configToml),
    });
  }

  renderAgentCliConfigScript(user: ThreadContainerUser, config: RuntimeAgentCliConfig): string {
    const configDirectory = join(user.agentHomeDirectory, ".config", "companyhelm-agent-cli");
    const configPath = join(configDirectory, "config.json");
    const configContent = `${JSON.stringify(config, null, 2)}\n`;

    return this.templateRenderer.render("provisioning/runtime_agent_cli_config.sh.j2", {
      config_dir: shellQuote(configDirectory),
      config_path: shellQuote(configPath),
      config_content: shellQuote(configContent),
    });
  }

  renderGitConfigScript(gitUserName: string, gitUserEmail: string): string {
    return this.templateRenderer.render("provisioning/runtime_git_config.sh.j2", {
      default_git_user_name: shellQuote(gitUserName),
      default_git_user_email: shellQuote(gitUserEmail),
    });
  }

  renderThreadGitSkillsCloneScript(options: ThreadGitSkillProvisionOptions): string {
    const cloneRootDirectory = resolveThreadGitSkillsCloneRootDirectory(options);
    const packageBlocks = options.packages.map((pkg) => {
      const checkoutPath = join(cloneRootDirectory, pkg.checkoutDirectoryName);
      const sourceMarkerPath = join(checkoutPath, ".companyhelm-source");
      return [
        `PACKAGE_DIR=${shellQuote(checkoutPath)}`,
        `PACKAGE_SOURCE_MARKER=${shellQuote(sourceMarkerPath)}`,
        `PACKAGE_REPO_URL=${shellQuote(pkg.repositoryUrl)}`,
        `PACKAGE_COMMIT_REF=${shellQuote(pkg.commitReference)}`,
        'if [ ! -d "$PACKAGE_DIR/.git" ] || [ ! -f "$PACKAGE_SOURCE_MARKER" ] || [ "$(cat "$PACKAGE_SOURCE_MARKER")" != "$PACKAGE_REPO_URL#$PACKAGE_COMMIT_REF" ]; then',
        '  rm -rf "$PACKAGE_DIR"',
        '  if ! git clone --depth 1 --branch "$PACKAGE_COMMIT_REF" "$PACKAGE_REPO_URL" "$PACKAGE_DIR"; then',
        '    rm -rf "$PACKAGE_DIR"',
        '    git clone --depth 1 "$PACKAGE_REPO_URL" "$PACKAGE_DIR"',
        '    git -C "$PACKAGE_DIR" fetch --depth 1 origin "$PACKAGE_COMMIT_REF"',
        '    git -C "$PACKAGE_DIR" checkout --detach FETCH_HEAD',
        "  fi",
        '  printf \'%s\' "$PACKAGE_REPO_URL#$PACKAGE_COMMIT_REF" > "$PACKAGE_SOURCE_MARKER"',
        "fi",
        'chmod -R a+rX "$PACKAGE_DIR" || true',
      ].join("\n");
    }).join("\n\n");

    return this.templateRenderer.render("provisioning/runtime_thread_git_skills_clone.sh.j2", {
      skills_root: shellQuote(cloneRootDirectory),
      package_blocks: packageBlocks,
    });
  }

  renderThreadGitSkillsLinkScript(user: ThreadContainerUser, options: ThreadGitSkillProvisionOptions): string {
    const cloneRootDirectory = resolveThreadGitSkillsCloneRootDirectory(options);
    const codexSkillsDirectory = join(user.agentHomeDirectory, ".codex", "skills");
    const skillBlocks = options.packages.flatMap((pkg) => pkg.skills.map((skill) => [
      `SKILL_SOURCE=${shellQuote(join(cloneRootDirectory, pkg.checkoutDirectoryName, skill.directoryPath))}`,
      `SKILL_LINK=${shellQuote(join(codexSkillsDirectory, skill.linkName))}`,
      'if [ ! -d "$SKILL_SOURCE" ]; then',
      '  echo "Thread git skill directory not found: $SKILL_SOURCE" >&2',
      "  exit 1",
      "fi",
      'if [ ! -f "$SKILL_SOURCE/SKILL.md" ]; then',
      '  echo "Thread git skill directory is missing SKILL.md: $SKILL_SOURCE" >&2',
      "  exit 1",
      "fi",
      'rm -rf "$SKILL_LINK"',
      'ln -s "$SKILL_SOURCE" "$SKILL_LINK"',
    ].join("\n"))).join("\n\n");

    return this.templateRenderer.render("provisioning/runtime_thread_git_skills_link.sh.j2", {
      skills_root: shellQuote(cloneRootDirectory),
      codex_skills_root: shellQuote(codexSkillsDirectory),
      skill_blocks: skillBlocks,
    });
  }

  renderAgentMetadataScript(user: ThreadContainerUser, files: RuntimeAgentMetadataFile[]): string {
    const metadataRoot = join(user.agentHomeDirectory, ".companyhelm", "agent");
    const fileBlocks = files.map((file) => {
      const filePath = join(metadataRoot, file.filename);
      return [
        `FILE_PATH=${shellQuote(filePath)}`,
        `FILE_CONTENT=${shellQuote(file.content)}`,
        'printf \'%s\' "$FILE_CONTENT" > "$FILE_PATH"',
        'chmod 0600 "$FILE_PATH"',
      ].join("\n");
    }).join("\n\n");

    return this.templateRenderer.render("provisioning/runtime_agent_metadata.sh.j2", {
      agent_home: shellQuote(user.agentHomeDirectory),
      metadata_root: shellQuote(metadataRoot),
      file_blocks: fileBlocks,
    });
  }
}
