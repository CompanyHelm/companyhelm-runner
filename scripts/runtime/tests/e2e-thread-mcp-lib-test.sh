#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "${SCRIPT_DIR}/../e2e-thread-mcp-lib.sh"

fail() {
  printf 'FAIL: %s\n' "$*" >&2
  exit 1
}

assert_equals() {
  local expected="$1"
  local actual="$2"
  local message="$3"

  if [[ "${expected}" != "${actual}" ]]; then
    fail "${message}: expected '${expected}', got '${actual}'"
  fi
}

assert_contains() {
  local haystack="$1"
  local needle="$2"
  local message="$3"

  if [[ "${haystack}" != *"${needle}"* ]]; then
    fail "${message}: missing '${needle}'"
  fi
}

assert_not_contains() {
  local haystack="$1"
  local needle="$2"
  local message="$3"

  if [[ "${haystack}" == *"${needle}"* ]]; then
    fail "${message}: unexpected '${needle}'"
  fi
}

context_file="$(mktemp)"
cat > "${context_file}" <<'EOF'
API_AUTH_BEARER_TOKEN=test-auth-token
EOF

assert_equals "test-auth-token" "$(load_auth_token_from_context_file "${context_file}")" "should load auth token from context file"
rm -f "${context_file}"

declare -a curl_args=()
build_graphql_curl_args curl_args "http://127.0.0.1:4000/graphql" '{"query":"{__typename}"}' "company-123" "token-456"
curl_args_joined="$(printf '%s\n' "${curl_args[@]}")"
assert_contains "${curl_args_joined}" "content-type: application/json" "should include content-type header"
assert_contains "${curl_args_joined}" "x-company-id: company-123" "should include x-company-id header"
assert_contains "${curl_args_joined}" "authorization: Bearer token-456" "should include authorization header when token is present"

declare -a curl_args_without_auth=()
build_graphql_curl_args curl_args_without_auth "http://127.0.0.1:4000/graphql" '{"query":"{__typename}"}' "company-123" ""
curl_args_without_auth_joined="$(printf '%s\n' "${curl_args_without_auth[@]}")"
assert_not_contains "${curl_args_without_auth_joined}" "authorization: Bearer" "should omit authorization header when token is empty"

assert_equals "/tmp/companyhelm/workspaces/thread-123" "$(resolve_thread_workspace_path "/tmp/companyhelm/workspaces" "123")" "should resolve thread workspace directly under workspaces root"

printf 'PASS\n'
