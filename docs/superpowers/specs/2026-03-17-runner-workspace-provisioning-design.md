# Runner Workspace Provisioning Design

## Context

The runner currently always creates a per-thread workspace under the configured `workspaces_directory`, mixes host-side and runtime-side provisioning concerns inside `root.ts` and `ThreadContainerService`, and writes `AGENTS.md` files directly into the mounted workspace.

This task changes the workspace model and the provisioning boundaries:

- add a `--workspace-path` runner option
- add a `--use-dedicated-workspaces` runner option representing the current per-thread behavior
- default to using the current working directory as the shared workspace when `--workspace-path` is not provided
- reject using `--workspace-path` together with `--use-dedicated-workspaces`
- stop creating `AGENTS.md` in the workspace
- move the AGENTS/system prompt content into a dedicated Jinja template and prepend it to Codex developer instructions
- split provisioning into host-side and runtime-side modules

## Goals

- Make workspace selection explicit and deterministic from runner startup configuration.
- Support a shared host workspace mounted directly as `/workspace` for all threads.
- Preserve the existing dedicated per-thread workspace behavior behind an explicit flag.
- Separate host provisioning from runtime provisioning so responsibilities are modular and testable.
- Keep runner-owned metadata out of `/workspace`.
- Preserve the existing workspace guidance by delivering it through developer instructions instead of workspace files.

## Non-Goals

- No retro-compatibility work beyond what is needed for this task.
- No changes to the app-server thread cwd inside the runtime container; it remains `/workspace`.
- No runner-managed metadata files in `/workspace`.
- No workspace instruction files created by the runner.

## Behavior

### Runner configuration

Add two runner start options:

- `--workspace-path <path>`
- `--use-dedicated-workspaces`

Add matching config fields:

- `workspace_path`
- `use_dedicated_workspaces`

Configuration rules:

- `workspace_path` defaults to `process.cwd()`.
- `use_dedicated_workspaces` defaults to `false`.
- When `use_dedicated_workspaces` is `true`, the runner uses the existing per-thread directory strategy under `workspaces_directory`.
- When `use_dedicated_workspaces` is `false`, every thread uses the exact resolved `workspace_path`.
- `workspace-path` and `use-dedicated-workspaces` are mutually exclusive in CLI/config resolution. If both are supplied explicitly for startup, the runner throws a user-facing configuration error before bootstrapping.

### Workspace layout

Dedicated mode:

- Host path: `<resolveThreadsRootDirectory(config_directory, workspaces_directory)>/thread-<id>`
- Mounted as `/workspace`

Shared mode:

- Host path: `<resolved workspace_path>`
- Mounted as `/workspace`

Runner-managed metadata files move under the agent-owned directory inside the runtime environment:

- `/home/agent/.companyhelm/agent/installations.json`
- `/home/agent/.companyhelm/agent/thread-git-skills.json`
- `/home/agent/.companyhelm/agent/thread-mcp.json`
- `/home/agent/.companyhelm/agent/thread-agent-cli.json`

No `AGENTS.md` or `agents.md` files are created by the runner.

### Developer instructions

The existing workspace guidance content currently sourced from the AGENTS template moves to a new dedicated Jinja template used as a system prompt fragment.

Behavior:

- create a new template dedicated to runtime system prompt content
- render it with the same runtime values currently used for AGENTS content
- prepend the rendered content to thread additional developer instructions when starting Codex threads
- preserve existing user-supplied additional instructions by appending them after the rendered system prompt fragment

This keeps the runtime guidance available to Codex without polluting the mounted workspace.

## Architecture

### Host provisioning

Create `src/provisioning/host_provisioning` for host filesystem preparation and workspace metadata writes.

Responsibilities:

- resolve workspace mode and host workspace path
- create the workspace directory when needed
- stop writing runner-owned metadata into the mounted workspace
- expose a single workflow used by thread creation

Suggested modules:

- `workspace_path_resolver.ts`
- `thread_workspace_provisioner.ts`

### Runtime provisioning

Create `src/provisioning/runtime_provisioning` for setup that happens inside the runtime container.

Responsibilities:

- runtime user identity bootstrap
- runtime tooling validation
- `.bashrc` provisioning
- Codex config provisioning
- runner metadata directory provisioning under `/home/agent/.companyhelm/agent`
- agent CLI config provisioning
- git identity provisioning
- thread git skills clone/link provisioning
- render provisioning shell commands from Jinja templates instead of assembling multi-line shell scripts inline in TypeScript

Suggested modules:

- `runtime_identity_provisioner.ts`
- `runtime_shell_provisioner.ts`
- `runtime_codex_provisioner.ts`
- `runtime_agent_metadata_provisioner.ts`
- `runtime_agent_cli_provisioner.ts`
- `runtime_git_provisioner.ts`
- `runtime_thread_git_skills_provisioner.ts`

Suggested template layout:

- `src/templates/runtime_system_prompt.md.j2`
- `src/templates/provisioning/runtime_identity.sh.j2`
- `src/templates/provisioning/runtime_tooling_validation.sh.j2`
- `src/templates/provisioning/runtime_bashrc.sh.j2`
- `src/templates/provisioning/runtime_codex_config.sh.j2`
- `src/templates/provisioning/runtime_agent_metadata.sh.j2`
- `src/templates/provisioning/runtime_agent_cli_config.sh.j2`
- `src/templates/provisioning/runtime_git_config.sh.j2`
- `src/templates/provisioning/runtime_thread_git_skills_clone.sh.j2`
- `src/templates/provisioning/runtime_thread_git_skills_link.sh.j2`

`ThreadContainerService` remains responsible for Docker lifecycle operations and delegates provisioning script construction/execution to these modules.

## Data Flow

Thread creation flow:

1. Build root config from CLI options.
2. Validate workspace mode settings.
3. Resolve the thread workspace host path through host provisioning.
4. Insert the thread row with the resolved workspace path.
5. Provision only the host workspace directory itself; do not write runner metadata into `/workspace`.
6. Create containers mounting the resolved workspace as `/workspace`.
7. Run runtime provisioning steps in the runtime container, including writing runner metadata into `/home/agent/.companyhelm/agent`.
8. Render the runtime system prompt template and prepend it to the developer instructions passed to Codex.
9. Start the app-server thread with `cwd: "/workspace"`.

## Error Handling

- Invalid workspace configuration fails fast during root config construction with a clear error.
- Shared workspace preparation errors identify the workspace path that failed.
- Runtime metadata provisioning failures identify the file path or provisioning step that failed.
- Runtime provisioning failures continue to surface the specific container and step that failed.
- Removing `AGENTS.md` generation must not affect thread creation success.

## Testing

Write tests first for each changed behavior.

Unit tests:

- root config/build option validation for `--workspace-path` and `--use-dedicated-workspaces`
- workspace resolution in shared and dedicated modes
- host provisioning writes no runner metadata into `/workspace`
- runtime provisioning modules preserve current script behavior
- runtime agent metadata provisioning writes config files under `/home/agent/.companyhelm/agent`
- no `AGENTS.md` creation
- developer instruction rendering prepends the runtime system prompt template ahead of additional instructions

Integration tests:

- thread creation uses shared `workspace_path` when dedicated workspaces are off
- thread creation keeps per-thread workspaces when dedicated workspaces are on
- integration assertions stop expecting `AGENTS.md`
- integration assertions stop expecting runner metadata under `/workspace`
- runtime provisioning writes runner metadata under `/home/agent/.companyhelm/agent`
- Codex thread start receives the rendered runtime system prompt content inside developer instructions

E2E impact:

- runner-only change, so run runner repo tests and inspect `companyhelm-common` e2e helpers to confirm no shared e2e updates are required

## Workspace Pollution Audit

Based on the updated design, the runner should not create metadata files in `/workspace`.

The runtime-owned metadata files should instead live under:

- `/home/agent/.companyhelm/agent/installations.json`
- `/home/agent/.companyhelm/agent/thread-git-skills.json`
- `/home/agent/.companyhelm/agent/thread-mcp.json`
- `/home/agent/.companyhelm/agent/thread-agent-cli.json`

No other top-level workspace files should be created by the runner as part of this task.
