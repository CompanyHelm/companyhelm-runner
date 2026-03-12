# Runner Logs Command Design

## Summary

Add a new root CLI command, `companyhelm-runner logs`, that prints the local runner daemon log file. By default it prints the full file contents and exits. With `--live`, it prints the current contents and keeps streaming newly appended data.

## Goals

- Reuse the same state DB resolution and daemon log path resolution used by `status`.
- Keep the implementation inside the Node CLI rather than shelling out to external tools.
- Exit cleanly with a friendly message when the log file does not exist.
- Keep live-follow behavior deterministic and easy to unit test.

## Command Surface

- `companyhelm-runner logs`
- Options:
  - `--live`
  - `--state-db-path <path>`

## Behavior

### Path Resolution

1. Parse the active config with `state_db_path` overrides the same way `status` does.
2. Read the current daemon state from the state DB.
3. Resolve the log path from daemon state when present.
4. Fall back to the default daemon log path derived from the state DB path when daemon state is absent or does not include a log path.

### Default Mode

1. Read the full log file contents.
2. Write the contents to stdout exactly as stored.
3. Exit immediately.

### Live Mode

1. Print the full current contents first.
2. Continue polling the file for appended bytes.
3. Stream only new bytes to stdout until the process is interrupted.

### Missing File

1. Print a friendly stdout message that includes the resolved path.
2. Exit with status code `0`.

## Implementation Notes

- Register the command at the root command level next to `status`.
- Implement the command in a dedicated module under `src/commands`.
- Use a small internal class to encapsulate file reading and append-following logic.
- Use native Node filesystem APIs and polling with an abort-aware sleep in live mode for deterministic tests.

## Tests

- Help output includes `logs`.
- Default command prints full file contents.
- Missing file prints a friendly message.
- `--live` prints existing content and follows appended content.
