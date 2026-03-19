import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_PATH_ENV, config } from "../../dist/config.js";

test("config defaults runtime image from version file", () => {
  const cfg = config.parse({});
  const version = readFileSync(join(process.cwd(), "RUNTIME_IMAGE_VERSION"), "utf8").trim();
  assert.equal(cfg.runtime_image, `companyhelm/runner:${version}`);
});

test("config defaults thread git skills clone directory", () => {
  const cfg = config.parse({});
  assert.equal(cfg.thread_git_skills_directory, "/skills");
});

test("config defaults CompanyHelm server URL", () => {
  const cfg = config.parse({});
  assert.equal(cfg.companyhelm_api_url, "https://api.companyhelm.com:50051");
});

test("config defaults the agent API URL", () => {
  const cfg = config.parse({});
  assert.equal(cfg.agent_api_url, "https://api.companyhelm.com/agent/v1");
});

test("config accepts explicit agent API URL override", () => {
  const cfg = config.parse({
    agent_api_url: "localhost:15052/agent/v1",
  });
  assert.equal(cfg.agent_api_url, "localhost:15052/agent/v1");
});

test("config resolves default state db path under config directory", () => {
  const cfg = config.parse({});
  assert.equal(cfg.state_db_path, "~/.config/companyhelm/state.db");
});

test("config resolves relative state db path under explicit config directory", () => {
  const cfg = config.parse({
    config_directory: "/tmp/companyhelm-config",
    state_db_path: "data/state.db",
  });
  assert.equal(cfg.state_db_path, "/tmp/companyhelm-config/data/state.db");
});

test("config uses COMPANYHELM_CONFIG_PATH as the default config directory", () => {
  const previous = process.env[CONFIG_PATH_ENV];
  process.env[CONFIG_PATH_ENV] = "/tmp/companyhelm-from-env";

  try {
    const cfg = config.parse({});
    assert.equal(cfg.config_directory, "/tmp/companyhelm-from-env");
    assert.equal(cfg.state_db_path, "/tmp/companyhelm-from-env/state.db");
  } finally {
    if (previous === undefined) {
      delete process.env[CONFIG_PATH_ENV];
    } else {
      process.env[CONFIG_PATH_ENV] = previous;
    }
  }
});
