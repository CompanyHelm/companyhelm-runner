# CompanyHelm Runner

Run the CompanyHelm runner in isolated Docker sandboxes on your machine.

## Install

```bash
npm install -g @companyhelm/runner
```

Or run it without installing globally:

```bash
npx @companyhelm/runner --help
```

Package: [@companyhelm/runner](https://www.npmjs.com/package/@companyhelm/runner)

## Basic Usage

Start the CLI in the foreground:

```bash
companyhelm-runner
```

Start it as a daemon:

```bash
companyhelm-runner --daemon
```

Check whether the daemon is running:

```bash
companyhelm-runner status
```

The `status` command prints:

- whether the daemon is running
- the recorded daemon PID
- the daemon log directory and log file path

## Why Use It

- Runs agents in isolated containers instead of directly on your machine
- Supports Docker-in-Docker for end-to-end workflows
- Keeps runner state in a local SQLite database
- Supports long-running daemon mode for background operation

## For Developers

Development and maintenance notes live in [DEVELOPING.md](./DEVELOPING.md).

## License

MIT
