# Publishing the Coldtill plugin to the EmDash registry

The registry is experimental, so `@emdash-cms/plugin-cli` is pinned to an exact version (`0.13.4`) in
`package.json`. Run every command below from this directory (the one with `emdash-plugin.jsonc`); `pnpm exec`
uses the pinned CLI. Reference: <https://docs.emdashcms.com/plugins/creating-plugins/publishing/> and
<https://docs.emdashcms.com/plugins/creating-plugins/delegated-releases/>.

## Identity

The package is published under the Atmosphere account **@coldtill.eurosky.social**. The manifest pins its DID:

```jsonc
"publisher": "did:plc:xappngqq5pvgufmk2rpuuq4o", // coldtill.eurosky.social
```

The DID is what the registry and EmDash use, so the handle can later be switched to `coldtill.com` (in the
account's settings, with a DNS or `/.well-known/atproto-did` proof) without changing the manifest, the package, or
the plugin id that installed sites use (`r_iq46b5ezsks5zhaf`, derived from the DID and the slug `coldtill`). Never
change `publisher` or `slug` after the first release: it would become a different package.

## Before every release

1. Bump `version` in `package.json` (the manifest takes it from there). Releases are immutable.
   - **major** when the trust contract grows (capabilities, allowed hosts, storage, public routes),
   - **minor** for new routes or hooks,
   - **patch** for fixes.
2. Run the checks:

   ```sh
   pnpm install
   pnpm test
   pnpm typecheck
   pnpm build
   pnpm bundle   # must report "Validation passed"; limits are 256 KB total, 128 KB per file, 20 files
   ```

3. Make sure the public GitHub repository named in `repo` (`https://github.com/Coldtill/emdash-crypto-payment-gateway`)
   exists and holds this release's source. The registry links the package to it.

## Publish from your computer

1. Log in once with the publisher account. This opens the account provider's sign-in page; EmDash never sees the
   password.

   ```sh
   pnpm exec emdash-plugin login coldtill.eurosky.social
   pnpm exec emdash-plugin whoami   # the active session must be did:plc:xappngqq5pvgufmk2rpuuq4o
   ```

   If another account is active, run `pnpm exec emdash-plugin switch did:plc:xappngqq5pvgufmk2rpuuq4o`. A mismatch
   fails with `MANIFEST_PUBLISHER_MISMATCH`.

2. Publish:

   ```sh
   pnpm exec emdash-plugin publish
   ```

   This rebuilds and validates the bundle, uploads it and `icon.png` to the account's PDS, creates the package
   profile on the first release (name, description, sections, keywords and links from `emdash-plugin.jsonc`) and
   writes the release record. If it reports `MISSING_BLOB_SCOPE`, run `emdash-plugin logout`, log in again and
   retry.

3. Watch the listing checks. The CLI prints the exact command; it looks like:

   ```sh
   pnpm exec emdash-plugin info coldtill.eurosky.social coldtill --version 1.0.0 --watch
   ```

   Until the package is approved this shows only the check state. Once approved it prints the public plugin page.
   Stop watching with Ctrl-C; that doesn't affect the release.

The profile is only created by the first `publish`. To change the listing text, keywords or links later without a
new release:

```sh
pnpm exec emdash-plugin update-package        # preview
pnpm exec emdash-plugin update-package --yes  # apply
```

## Optional: release from GitHub Actions

Automated releases build in GitHub Actions and publish through the EmDash release service, so no account
credential is stored in the repository. They need the GitHub repository to be **public**, with this plugin at its
root and `pnpm-lock.yaml` committed (the workflow runs `pnpm install --frozen-lockfile`).

1. Log in as above (`emdash-plugin login coldtill.eurosky.social`).
2. In a clone of `Coldtill/emdash-crypto-payment-gateway`, run:

   ```sh
   pnpm exec emdash-plugin release setup
   ```

   It prepares the package profile (or adds release settings to the one `publish` created) and writes
   `.github/workflows/emdash-release.yml`. Choose:
   - approval **When plugin permissions increase** (default) or **For every release**;
   - **Require provenance** (default) to accept only Actions-built releases, or **Allow releases without
     provenance** to keep publishing from your computer as well.

   Non-interactive: `pnpm exec emdash-plugin release setup --yes` (add `--provenance optional` to keep local
   publishing). The workflow file is not committed or pushed for you; review and commit it.
3. Open <https://releases.emdashcms.com/publisher>, sign in as `coldtill.eurosky.social` and select
   **Authorize publishing**. Release approvals need a passkey on that account.
4. Release by pushing a tag of the form `<slug>@<version>`:

   ```sh
   git tag coldtill@1.0.0
   git push origin coldtill@1.0.0
   ```

   or use **Run workflow** on the repository's Actions page.
5. On the first run, open the link in the job summary and approve the repository and tag scope. A release that
   expands the plugin's permissions waits in **Awaiting approval** until you approve it in the browser.
6. Watch it with `emdash-plugin info` as above.

## After the first approval

- Registry installs use the plugin id `r_iq46b5ezsks5zhaf`, so their routes are under
  `/_emdash/api/plugins/r_iq46b5ezsks5zhaf/`. The README and the Astro example already use it.
- Add the plugin to <https://coldtill.com/integrations/> and the docs' integration list.
