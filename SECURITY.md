# Security notes

## Threat model

The encrypted configuration file is designed to protect Pi configuration contents from GitHub Gist viewers and accidental repository disclosure. It does not protect a running host from a compromised root account, a compromised Pi extension, a compromised GitHub account, or a leaked sync passphrase.

## Credentials

The passphrase is not stored in the Gist or in pi-gist-sync.json. The GitHub token is not stored in ~/.pkit/config.yml. Use a fine-grained token with only Gist access when an environment token is necessary.

The synchronized models.json may contain provider API keys. Treat the passphrase and every host that receives the decrypted file as sensitive.

## Restore behavior

Pull validates the manifest, ciphertext hash, authentication tag, file paths, modes, duplicate paths, and size limits before writing. Symlinks, special files, absolute paths, parent traversal, and paths outside the Pi agent directory are rejected. Pull creates an encrypted backup before applying a change. Pruning is opt-in.

## Gist ownership

The fork writes only pi-gist-sync.manifest.json and pi-gist-sync.config.enc.json during configuration sync. pi-depo owns pi-depo.yml and pi-depo.lock.json. Unknown Gist files are preserved by GitHub partial file update semantics and are never included in the custom payload.

## Operational recommendations

- Use a Private Gist.
- Keep PI_GIST_SYNC_PASSPHRASE out of shell history, process listings, and shared logs.
- Prefer the guided `/gist-sync auth` web/device flow over long-lived environment tokens. The flow can be completed from another browser when the CLI host has no browser.
- If `gh` is not installed, install it through the host operating system and rerun the guided auth flow; the extension never installs system packages.
- Review `/gist-sync diff` before every restore; a first-run setup with an existing Gist restores by default and never overwrites the remote snapshot.
- Use `pd gist-sync diff` only in headless CLI workflows.
- Do not enable --prune on a host containing unmanaged Pi files.
- Pin package sources and review third-party Pi extensions before installing them. Package synchronization is explicit and is not part of configuration setup.
