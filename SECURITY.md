# Security Policy

Orchetrace processes local transcripts, tool metadata and runtime state. Security reports involving unintended data exposure, authentication bypass, unsafe path handling or corrupted local state are especially important.

## Supported versions

Orchetrace is currently an Alpha project. Security fixes are applied to the latest `main` branch; older commits and locally modified builds are not maintained as separate supported releases.

## Reporting a vulnerability

Do not open a public issue containing exploit details, transcripts, database files, connection tokens or other sensitive data.

Use GitHub's private vulnerability reporting for this repository:

<https://github.com/wang-zhengxin/orchetrace/security/advisories/new>

If private reporting is not available, open a minimal public issue asking the maintainer for a private contact channel. Do not include vulnerability details or sensitive data in that issue.

Please include:

- the affected commit or version;
- the operating system and runtime Adapter involved;
- concise reproduction steps using synthetic data where possible;
- the expected and observed security boundary;
- any known mitigations.

We aim to acknowledge a complete report within seven days. Resolution timing depends on severity and whether a coordinated dependency fix is required.

## Handling diagnostic data

- Replace real prompts, paths, usernames, repository names and tool output with synthetic values.
- Never attach `.db`, transcript, cursor or `live-config.json` files without reviewing and redacting them first.
- Revoke or discard any token included in a report.
- Keep vulnerability details private until a fix or mitigation is available.

## Current boundary

The Alpha service accepts only loopback ingest and Live listeners, requires a per-start token and validates the WebSocket Origin. Orchetrace does not upload runtime data by design.

Ingest applies recursive secret-key redaction before events reach projections, SQLite or an optional JSON mirror. Operators can select `metadata-only` capture, add organization-specific sensitive keys, scrub existing events, cascade-delete a Session tree, and prune complete Runs by age or event count. These controls reduce stored content; they are not a substitute for reviewing data before sharing it. Content-addressed encrypted blob storage is not implemented yet, so unreviewed runtime data should not be committed or attached to reports.
