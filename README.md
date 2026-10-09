# pi-depo-secure

A Git-installable Pi Package for Pi Coding Agent. It combines pi-depo package management with encrypted GitHub Gist synchronization for Pi configuration.

This is a fork of pi-depo and is not an official upstream release.

## Install as a Pi Package

The normal installation path is through Pi, not a global npm install:

    pi install git:github.com/Luckylos/pi-depo-secure@main

Use a verified tag or commit instead of `main` for production. Restart Pi after installation so the extension is loaded.

A global `pd` command is not required for the Pi extension. The `pd` CLI remains available as an optional interface for headless automation, development, and maintenance.

## First-time setup

Inside Pi, run:

    /gist-sync setup

The guided setup checks GitHub authentication before asking for a passphrase. It always uses the built-in GitHub Device Flow and stores the resulting token in the local credential store. No GitHub CLI, pasted token, or environment token is required.

### GitHub Device Flow

Create a GitHub OAuth App under Settings -> Developer settings -> OAuth Apps, enable Device Flow in that app's settings, and keep its public Client ID. The app only requests the gist scope. It does not need a client secret for Device Flow.

Set the Client ID on the Pi host before starting Pi or running the CLI:

    export PI_GITHUB_OAUTH_CLIENT_ID=your_public_client_id

Then run:

    /gist-sync auth

The terminal displays a GitHub verification URL and one-time code. Complete the authorization from any browser. The resulting access token is always stored as an AES-256-GCM encrypted file in the current user's standard config directory. No native module, system package, elevated permission, or keychain setup is required. It is not written to Pi settings, the Gist, logs, or command arguments.

Credential files are stored outside the Pi agent directory and are never included in Gist Sync:

    macOS:  ~/Library/Application Support/pi-depo-secure/github-token.enc
    Linux:  $XDG_CONFIG_HOME/pi-depo-secure/github-token.enc
            or ~/.config/pi-depo-secure/github-token.enc
    Windows: %APPDATA%\pi-depo-secure\github-token.enc

The directory also contains a separate random encryption key file named github-token.key. On POSIX systems the directory is mode 700 and both files are mode 600. Windows uses the current user's profile permissions.

If a matching Private Gist already exists, setup defaults to restoring it. It previews the remote diff, creates a local encrypted backup, and never uploads the new machine first. Use `--create` only when you explicitly want a new Gist. A new Gist is created only when no match exists or creation is explicitly selected.

The setup passphrase is masked and confirmed twice in Pi. It never silently installs packages, updates Pi, or runs `pd sync`.

## Daily usage

Inside Pi:

    /gist-sync auth
    /gist-sync status
    /gist-sync diff
    /gist-sync push
    /gist-sync pull
    /gist-sync doctor

`push` previews the upload before changing the Gist. `pull` shows the configuration diff, creates a local backup, and asks before applying changes. Configuration pull never installs or updates packages automatically.

Backups are stored under:

    ~/.pi/agent/backups/pi-gist-sync/<timestamp>/

To restore a selected backup:

    /gist-sync restore BACKUP_DIRECTORY

## Package management

Configuration setup does not create or push `pi-depo.yml`. Package operations remain explicit:

    /gist-sync packages status
    /gist-sync packages push
    /gist-sync packages pull
    /gist-sync packages sync

`pull` and `sync` may install, remove, or update packages and therefore require a separate confirmation. They are never triggered implicitly by configuration `pull`.

The extension must work without a global `pd` on PATH. Package actions use shared pi-depo code or the package-local CLI bundle.

Credential storage uses only Node built-ins and the current user's config directory. Package installation does not run native credential-store scripts.

## Optional CLI

The standalone CLI mirrors the extension for headless workflows:

    pd gist-sync auth
    printf "%s" "$PI_GIST_SYNC_PASSPHRASE" | pd gist-sync setup --passphrase-stdin --yes

For an existing Gist, `setup` restores the single matching Private Gist by default. To force a new one: `pd gist-sync setup --create --passphrase-stdin --yes`. To select a specific existing Gist: `pd gist-sync setup --gist-id=<id> --passphrase-stdin --yes`.
    pd gist-sync status
    printf "%s" "$PI_GIST_SYNC_PASSPHRASE" | pd gist-sync diff --passphrase-stdin
    printf "%s" "$PI_GIST_SYNC_PASSPHRASE" | pd gist-sync push --passphrase-stdin --yes
    printf "%s" "$PI_GIST_SYNC_PASSPHRASE" | pd gist-sync pull --passphrase-stdin --yes

The passphrase is never accepted as a normal command-line argument. For non-interactive use, provide it through `PI_GIST_SYNC_PASSPHRASE` or `--passphrase-stdin`; do not put it in shell history, process arguments, or shared logs.

## Pi-depo compatibility

The fork keeps the existing pi-depo model and files:

    /gist-sync auth
    pd login
    pd init
    pd push
    pd status
    pd diff
    pd sync

`pd sync` is not run silently by the configuration extension. Updates are opt-in:

    PI_DEPO_ALLOW_UPDATES=1 pd sync

The Git-installed extension is the recommended user interface. The CLI commands are retained for compatibility and advanced use.

## Gist contents

A selected Private Gist may contain:

- `pi-depo.yml` and `kit.lock.json`, owned by pi-depo after an explicit package operation;
- `pi-gist-sync.manifest.json`, containing non-secret metadata and a ciphertext hash;
- `pi-gist-sync.config.enc.json`, containing the encrypted Pi configuration snapshot;
- unrelated files, which are preserved.

The sync layer never writes a public Gist or stores the encryption passphrase. GitHub tokens remain in the encrypted user-local credential store.

## Configuration scope

Included by default:

- `settings.json`
- `models.json`
- `auth.json`
- `APPEND_SYSTEM.md`
- known Pi JSON configuration files, including `mcp.json`
- `agents/`
- `skills/`, `prompts/`, and `themes/`
- `extensions/`

Excluded:

- sessions and conversation history
- fff history and web caches
- context-mode databases
- Pi runtime, npm store, and Git checkout directories
- package-manager credentials
- symlinks and paths outside `~/.pi/agent`

Pull is additive and overwrite-only by default. It does not delete local files absent from the Gist. `--prune` is explicit and should only be used when the managed directory is authoritative.

## Security properties

- GitHub authentication uses only the built-in Device Flow; the extension never accepts pasted or environment tokens.
- The Device Flow uses only a public OAuth Client ID and stores the resulting token in an AES-256-GCM encrypted user-local file.
- Configuration payloads use scrypt and AES-256-GCM with a fresh salt and nonce per push.
- API keys are never printed by the extension, CLI, manifest, diff, or errors.
- `models.json`, `mcp.json`, and local sync settings are written with mode `600`.
- Extension package operations do not depend on a globally installed `pd`.
- Subprocesses use argument arrays and `shell: false`; user-authored kit steps are the only explicit shell execution path.
- Gist payload hashes and authenticated encryption are checked before any configuration write.
- A failed restore attempts a rollback from the in-memory snapshot.

Read `SECURITY.md` before synchronizing credentials or installing third-party Pi packages.
