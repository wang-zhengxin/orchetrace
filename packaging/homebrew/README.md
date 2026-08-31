# Homebrew distribution

M7 publishes two definitions to `wang-zhengxin/homebrew-tap`:

- `Formula/orchetrace.rb` installs the portable `orche` and `otrace` CLI bundle and uses Homebrew `node@22` for the four TypeScript runtime observers;
- `Casks/orchetrace.rb` installs the macOS desktop DMG.

The definitions are generated from immutable GitHub Release assets and their SHA-256 digests:

```bash
node scripts/generate-homebrew.mjs \
  --version 0.1.0-beta.4 \
  --assets-dir dist/release-assets \
  --output dist/homebrew \
  --require-cask
```

The release workflow updates the external tap only when the repository variable
`HOMEBREW_PUBLISH` is `true` and the secret `HOMEBREW_TAP_TOKEN` can push to the tap.
