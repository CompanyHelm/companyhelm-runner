# Runner Codex Registration And Auth Design

## Goal

Update `companyhelm-runner` so runner startup always registers a Codex SDK entry, upgrades runner protocol usage to `@companyhelm/protos` `0.5.19`, auto-detects host auth when `/home/agent/.codex/auth.json` exists, and handles server-driven Codex auth configuration for both API key and device-code style flows.

## Scope

- Always persist a `codex` SDK record before connecting.
- Always include `codex` in `RegisterRunnerRequest`.
- Report `READY`, `UNCONFIGURED`, or `ERROR` at registration time and over control-channel updates.
- Auto-select host auth on `runner start` when host Codex auth exists, unless `--use-dedicated-auth` is specified.
- Treat `--use-dedicated-auth` as:
  - leave existing dedicated auth unchanged when already configured
  - otherwise mark Codex unconfigured
- Handle server `CodexConfigurationRequest` for:
  - API key auth
  - device-code login flow with device-code extraction and auth file copy-back

## Registration Model

The runner state DB remains the source of truth for Codex authentication mode and configuration status.

`agent_sdks` entries for `codex` will be normalized as:

- `authentication=host`, `status=configured`
- `authentication=dedicated`, `status=configured`
- `authentication=api-key`, `status=configured`
- `authentication=unauthenticated`, `status=unconfigured`

Runner startup will always ensure a `codex` row exists. Registration will no longer fail just because no SDK is configured.

## Startup Behavior

On `runner start`:

1. Inspect the configured host auth path.
2. If host auth exists and `--use-dedicated-auth` is not set:
   - log that host auth was auto-detected
   - persist `authentication=host`, `status=configured`
3. If `--use-dedicated-auth` is set:
   - if Codex is already `dedicated/configured`, keep it unchanged
   - otherwise persist `authentication=unauthenticated`, `status=unconfigured`
4. If no host auth exists and dedicated auth is not explicitly preserved:
   - persist `authentication=unauthenticated`, `status=unconfigured`

Interactive startup auth configuration is removed from the root command path. The runner connects first and allows the server to drive auth when needed.

## Registration Status Mapping

`RegisterRunnerRequest.agent_sdks[]` will always contain the `codex` SDK entry.

Status rules:

- configured auth + successful model refresh => `READY`
- unconfigured auth => `UNCONFIGURED`
- configured auth + model refresh failure => `ERROR` with `error_message`

If model refresh fails with configured auth, the runner still registers and the server receives the error state plus message. Cached models may still be included if present, but registration does not fail solely due to refresh failure.

## Server-Driven Auth Flow

The control channel will handle `CodexConfigurationRequest`.

### API key

- Validate that an API key was supplied.
- Start the Codex app-server/container path needed to write auth state.
- Configure auth using the typed app-server account login API.
- Persist `authentication=api-key`, `status=configured`.
- Refresh models.
- Send an `agent_sdk_update` with the resulting `AgentSdk`.

### Device code

The typed app-server API exposes login start/completion metadata, but not a typed `device_code` field. The runner will therefore use the runtime container login flow to extract the device code from interactive output, which is the least invasive way to satisfy the current server contract.

Flow:

1. Launch the Codex login flow in the runtime context.
2. Parse stdout/stderr for the device code string expected by the server contract.
3. Send `codex_device_code` to the server as soon as the device code is discovered.
4. Continue monitoring output and completion notifications.
5. Detect the auth-complete phrase or success notification.
6. Copy the resulting `auth.json` from the runtime/container context into runner-managed storage.
7. Persist `authentication=dedicated`, `status=configured`.
8. Refresh models and send an `agent_sdk_update`.

If the device-code flow fails, the runner keeps the SDK entry and reports `ERROR` with an error message.

## Thread Handling

Thread creation remains gated on configured Codex auth. A runner may be connected yet still reject thread creation if Codex is `UNCONFIGURED` or `ERROR`.

## Testing

- Unit tests for startup auth normalization and registration status mapping.
- Unit tests for `CodexConfigurationRequest` API key and device-code branches.
- Integration tests proving:
  - registration happens before channel use even when unconfigured
  - unconfigured runners register `codex`
  - configured runners send `ERROR` status plus error message when model refresh fails
  - server-driven auth updates flow back over the control channel
