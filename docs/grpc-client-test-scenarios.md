# CompanyHelm CLI gRPC Client Test Scenarios

**Purpose:** This document is a shared QA reference for manually testing the CompanyHelm CLI gRPC client behavior.

**Audience:** QA testers, CLI maintainers, and reviewers validating CompanyHelm API client connectivity, authentication metadata, streaming behavior, and reconnect handling.

**Important Note:** These scenarios should use a stub gRPC server rather than a shared live environment whenever possible. The stub server is a fixture that simulates the CompanyHelm API so success, auth, reconnect, and error conditions are deterministic.

**Preconditions:**
- Node.js version supported by the repo is installed.
- A stub gRPC server is available or can be started locally.
- The stub implements the CompanyHelm runner-control service shape needed by the scenario.

---

## 1. Endpoint Parsing and Transport Selection

### Scenario 1.1: Parse local gRPC endpoint URL correctly

**Steps:**
1. Provide a local-style API URL to the client, such as `127.0.0.1:<port>/grpc`.
2. Start the client against a stub server on that address.

**Expected Results:**
- The target host and port are parsed correctly.
- The `/grpc` path prefix is preserved.
- The client uses insecure transport for local targets.

### Scenario 1.2: Parse remote-style gRPC endpoint URL correctly

**Steps:**
1. Provide a remote-style API URL using an https-style or non-local target.
2. Inspect client behavior during connection setup.

**Expected Results:**
- The target and path prefix are parsed correctly.
- The client selects TLS for non-local targets.

### Scenario 1.3: Path prefix mismatches are visible and diagnosable

**Steps:**
1. Start a stub server on one gRPC path prefix.
2. Configure the client with the wrong prefix.

**Expected Results:**
- The call fails predictably.
- The resulting error is diagnosable and not misleading.

---

## 2. Registration and Auth Metadata

### Scenario 2.1: Register runner request succeeds against stub server

**Steps:**
1. Start a stub gRPC server that implements `registerRunner`.
2. Run the CLI or client against that stub.
3. Capture the incoming request on the stub side.

**Expected Results:**
- The client calls `registerRunner` before opening the command channel.
- The stub receives a correctly shaped registration payload.
- The client proceeds only after successful registration.

### Scenario 2.2: Authorization metadata is attached when secret is provided

**Steps:**
1. Start a stub gRPC server that records request metadata.
2. Run the CLI or client with `--secret <value>`.
3. Capture metadata for both unary and streaming calls.

**Expected Results:**
- The `authorization` header is sent as `Bearer <value>`.
- The metadata is present on the control channel as expected.

### Scenario 2.3: No authorization metadata is sent when secret is absent

**Steps:**
1. Start a stub gRPC server that records request metadata.
2. Run the CLI or client without a secret.

**Expected Results:**
- No bearer authorization header is sent.
- The client still attempts connection normally.

### Scenario 2.4: Unary registration failure is surfaced cleanly

**Steps:**
1. Start a stub gRPC server that returns an error from `registerRunner`.
2. Connect the client.

**Expected Results:**
- The connection attempt fails.
- The CLI or client surfaces the registration error clearly.

---

## 3. Streaming Command Channel

### Scenario 3.1: Command channel opens successfully after registration

**Steps:**
1. Start a stub gRPC server that:
   - accepts `registerRunner`
   - accepts `controlChannel`
   - sends initial metadata or first server message
2. Connect the CLI or client.

**Expected Results:**
- The command channel is considered open only after the server makes it usable.
- The client transitions into the connected state.

### Scenario 3.2: Bidirectional streaming works in both directions

**Steps:**
1. Start a stub gRPC server that echoes or records client messages and sends server messages back.
2. Connect the CLI or client.
3. Send at least one client message and at least one server message.

**Expected Results:**
- Client-to-server messages are transmitted correctly.
- Server-to-client messages are received and processed correctly.
- Message ordering is sane for the tested path.

### Scenario 3.3: Stub server closes before usable open state

**Steps:**
1. Start a stub gRPC server that accepts the stream and closes it before sending metadata or a message.
2. Connect the client.

**Expected Results:**
- The client reports that the command channel closed before becoming usable.
- The failure is surfaced clearly.

### Scenario 3.4: Streaming channel failure is surfaced cleanly

**Steps:**
1. Start a stub gRPC server that accepts registration but returns a streaming error on `controlChannel`.
2. Connect the client.

**Expected Results:**
- The client reports the stream failure.
- The failure does not present as a silent hang.

### Scenario 3.5: Reconnect behavior works after temporary unavailability

**Steps:**
1. Start a stub gRPC server and connect the CLI in daemon mode.
2. Drop the stub server or close the stream.
3. Bring the stub server back.

**Expected Results:**
- The CLI detects the disconnect.
- Reconnect attempts occur as designed.
- The CLI reconnects successfully when the server returns.

---

## 4. Additional Unary RPC Coverage

### Scenario 4.1: GitHub installation helper unary RPCs work against stub server

**Steps:**
1. Start a stub server that implements:
   - list GitHub installations for runner
   - get GitHub installation access token for runner
2. Run the client path that invokes those calls.

**Expected Results:**
- Each unary RPC reaches the stub method with the expected payload.
- The client handles successful responses correctly.
- Error responses from the stub are surfaced clearly.

---

## 5. Regression Checklist

1. Reproduce the original client or connection issue first.
2. Verify the exact URL, auth, or streaming path now works.
3. Verify the failure path still behaves clearly.
4. Re-run one adjacent unary or streaming scenario to catch regressions.
