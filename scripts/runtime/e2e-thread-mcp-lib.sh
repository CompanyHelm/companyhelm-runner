#!/usr/bin/env bash

load_auth_token_from_context_file() {
  local context_file="$1"

  if [[ ! -f "${context_file}" ]]; then
    printf ''
    return
  fi

  (
    set -euo pipefail
    # shellcheck disable=SC1090
    source "${context_file}"
    printf '%s' "${API_AUTH_BEARER_TOKEN:-}"
  )
}

build_graphql_curl_args() {
  local output_array_name="$1"
  local api_url="$2"
  local payload="$3"
  local company_id="$4"
  local auth_token="${5:-}"
  local -n output_array="${output_array_name}"

  output_array=(
    -sS
    "${api_url}"
    -H
    "content-type: application/json"
    -H
    "x-company-id: ${company_id}"
  )

  if [[ -n "${auth_token}" ]]; then
    output_array+=(
      -H
      "authorization: Bearer ${auth_token}"
    )
  fi

  output_array+=(
    --data-binary
    "${payload}"
  )
}

resolve_thread_workspace_path() {
  local workspaces_root="$1"
  local thread_id="$2"

  printf '%s/thread-%s' "${workspaces_root%/}" "${thread_id}"
}
