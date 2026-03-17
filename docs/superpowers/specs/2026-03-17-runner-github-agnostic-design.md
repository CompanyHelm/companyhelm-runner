# Runner GitHub Agnostic Design

## Goal

Remove GitHub-specific behavior from `companyhelm-runner` entirely.

GitHub installation discovery and installation-token auth should move to:

- `companyhelm-api` via thread-authenticated agent REST endpoints
- `companyhelm-skills` via a dedicated GitHub skill that calls those endpoints and configures `gh` and git in the runtime

## Accepted Decisions

- `companyhelm-runner` must be completely GitHub-agnostic.
- Do not keep runner-side GitHub installation sync.
- Do not materialize `installations.json` into runtime containers.
- Do not keep runtime GitHub helper tools in the runner image.
- Use GitHub-specific agent REST endpoints for now.
- Put the GitHub user workflow in `companyhelm-skills`.

## Architecture

### Runner

Remove all GitHub-specific behavior from `companyhelm-runner`:

- remove runtime scripts such as `list-installations` and `gh-use-installation`
- remove GitHub-installation guidance from the runtime system prompt
- remove gRPC client methods and logic for:
  - listing GitHub installations
  - fetching GitHub installation access tokens
- remove the GitHub installation sync loop
- remove workspace GitHub installation file writes
- remove runtime container provisioning of GitHub installation metadata

After this change, the runner only provides generic runtime, thread, and agent API bootstrap behavior.

### API

Add thread-authenticated agent REST endpoints under `/agent/v1/github`:

- `GET /agent/v1/github/installations`
- `POST /agent/v1/github/installations/:installationId/access-token`

These endpoints authenticate via `Authorization: Bearer <thread-secret>`, derive the thread and company scope from the thread secret, and perform GitHub installation lookup/token retrieval on the server side.

### Skills

Add a GitHub skill in `companyhelm-skills` that:

- reads the runtime agent config already present in the container
- calls the agent REST endpoints
- presents installation choices
- configures `gh`
- configures git HTTPS credentials so `git push` works immediately

This skill becomes the only GitHub-specific runtime UX layer.

### Protos

Once runner and API stop depending on the runner GitHub gRPC path, remove the obsolete GitHub installation RPCs and messages from `companyhelm-protos`.

## Data Flow

### Installation Discovery

1. The GitHub skill reads `agent_api_url` and thread token from the existing runtime agent config.
2. The skill calls `GET /agent/v1/github/installations`.
3. The API authenticates the thread secret and resolves company scope.
4. The API returns the installations visible to that company/thread context.
5. The skill presents those choices to the user.

### Installation Selection and Auth

1. The user selects an installation.
2. The skill calls `POST /agent/v1/github/installations/:installationId/access-token`.
3. The API validates that the installation belongs to the authenticated thread/company context.
4. The API returns:
   - installation id
   - installation token
   - expiration
   - repository scope metadata
5. The skill configures:
   - `gh auth login --with-token`
   - git HTTPS credential helper for GitHub

## API Contract

### `GET /agent/v1/github/installations`

Purpose:

- list GitHub installations available to the authenticated thread/company

Response shape should include only the metadata needed for discovery, for example:

- installation id
- repository scope summary
- any stable display fields needed by the skill

### `POST /agent/v1/github/installations/:installationId/access-token`

Purpose:

- return a fresh installation access token for the selected installation

Response shape:

- installation id
- access token
- expiration timestamp
- repository scope metadata

The API remains the authoritative source of token freshness. No runner-side refresh loop or cached installation-state file is needed.

## Error Handling

### API

- `401 UNAUTHENTICATED`
  - missing or invalid thread secret
- `404 NOT_FOUND`
  - installation is not visible to the authenticated thread/company
- `500 INTERNAL`
  - unexpected server-side failure
- `502 UPSTREAM_FAILURE`
  - GitHub token mint or upstream credential retrieval failed

Responses should use short, stable machine-readable codes and concise messages.

### Skill

The skill should:

- surface API failures directly
- avoid partial auth setup where possible
- stop immediately on installation lookup or token retrieval failure
- only configure `gh` and git after a valid token is returned

## Repository Changes

### `companyhelm-runner`

- delete GitHub-specific runtime scripts
- delete GitHub-specific prompt text
- delete GitHub-specific sync logic and runtime provisioning logic
- delete GitHub-specific runner tests
- update tests to assert the runner no longer carries GitHub-specific behavior

### `companyhelm-api`

- add agent REST GitHub routes
- add service logic behind those routes
- use existing thread-auth context to scope access

### `companyhelm-skills`

- add the GitHub skill
- implement installation listing and auth configuration against agent REST

### `companyhelm-protos`

- remove runner GitHub installation RPC/messages after consumers are removed

## Verification

### API

- route tests for `/agent/v1/github/installations`
- route tests for `/agent/v1/github/installations/:installationId/access-token`
- auth-context tests proving thread-secret scoping is enforced
- service tests for installation listing and token retrieval

### Runner

- remove or replace tests covering:
  - GitHub installation sync
  - runtime installation metadata files
  - GitHub-specific runtime prompt guidance
- verify no GitHub-specific runner paths remain

### Skills

- verify the skill can:
  - list installations from agent REST
  - select an installation
  - configure `gh`
  - configure git credential helpers so HTTPS push works immediately

### Protos

- verify runner and API compile and test cleanly after GitHub runner RPC removal

## Rollout Order

1. Add GitHub agent REST endpoints in `companyhelm-api`.
2. Add the GitHub skill in `companyhelm-skills`.
3. Remove GitHub behavior from `companyhelm-runner`.
4. Remove obsolete GitHub runner RPC schema from `companyhelm-protos`.

## Rationale

This design removes stale copied installation state, removes an unnecessary runner-owned sync loop, and preserves a cleaner boundary:

- API owns GitHub installation lookup and token issuance.
- Skills own the GitHub user workflow.
- Runner remains a generic runtime/thread orchestration layer.
