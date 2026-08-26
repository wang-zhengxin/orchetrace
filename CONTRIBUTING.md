# Contributing to Orchetrace

Orchetrace is an Alpha project. Small, evidence-backed changes with deterministic fixtures are easier to review than broad runtime assumptions.

## Development setup

Requirements:

- Node.js 22;
- Rust 1.88 with `rustfmt` and `clippy`;
- Tauri 2 system dependencies when changing the desktop shell.

Run the standard checks before opening a pull request:

```bash
npm run check
npm run desktop:prepare
cargo fmt --all -- --check
cargo clippy --workspace --all-targets --locked -- -D warnings
cargo test --workspace --locked
npm run desktop:check
```

## Change guidelines

- Keep runtime-specific parsing inside its Adapter package.
- Keep status, lineage and outcome semantics in the Rust Core.
- Do not infer a child Agent, success or failure without explicit runtime evidence.
- Preserve stable event IDs and ACK-gated cursor updates.
- Add a synthetic, irreversibly redacted fixture for new runtime behavior.
- Add both mapping tests and fold/projection tests when changing Canonical Event semantics.
- Treat unknown required source events as diagnostics or errors, never silent data loss.

## Fixtures and privacy

Fixtures must not contain real credentials, usernames, private absolute paths, business code, repository names or unreviewed model/tool output. Prefer short synthetic examples that isolate one behavior.

Local product, design and implementation notes under `docs/` are intentionally excluded from the public repository. Public behavior, setup changes and user-facing limitations belong in `README.md`, `SECURITY.md` or the relevant code comments and tests.

## Pull requests

A pull request should explain:

1. the observable behavior being changed;
2. the runtime evidence supporting the mapping;
3. failure, replay and reconnect behavior;
4. tests added or updated;
5. any privacy, compatibility or migration impact.

Use focused commits. Conventional Commit prefixes such as `feat:`, `fix:`, `test:` and `docs:` are preferred.
