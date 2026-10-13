# Install CoThink

CoThink requires Node.js 22 or newer and npm. The package is named `cothink`, and its executable is `cothink`. Version 0.6.1 is prepared for installation from a local tarball; no npm registry release or dedicated CoThink GitHub repository is assumed by these instructions.

## Build and install from source

Open a terminal in the source checkout and run:

```bash
npm ci
npm run build
npm pack --workspace packages/cothink --pack-destination .
npm install -g ./cothink-0.6.1.tgz
cothink --version
cothink --help
```

The tarball bundles the peer CLI and core. It does not depend on a published `@onevcat/argue` package containing the new peer exports. npm still installs the declared runtime dependencies, so installing the tarball ordinarily requires network access.

The global command becomes available through npm's global executable directory. If the shell cannot find `cothink`, check `npm prefix -g` and the shell's `PATH`. Use a Node installation you can write to; the CLI does not require administrator access.

## Use without a global install

After building, run the bundled entry directly from this checkout:

```bash
node packages/cothink/dist/cli.js --help
node packages/cothink/dist/cli.js setup
node packages/cothink/dist/cli.js test
node packages/cothink/dist/cli.js start --question "What are the tradeoffs in this proposal?"
```

Paths are relative to the directory from which you run the command. Run in the directory where you want `.cothink/` to live, or choose explicit paths.

## Configure and verify the connection

```bash
cothink setup
cothink test
```

`setup` requires an interactive terminal. It creates configuration and, only if you enter keys, a separate key file. It makes no API requests. Press Enter at key entry to use an exported environment variable or add credentials later.

For a noninteractive template:

```bash
cothink init
```

Edit both placeholder endpoints and model IDs before use, then export the key variables or create your chosen environment file. `init` is the same as `setup --no-input`; it does not create usable provider credentials.

You can use alternate paths:

```bash
cothink setup --config config.json --env-file keys.env
cothink test --config config.json --env-file keys.env
cothink start --config config.json --env-file keys.env --question "Review this proposal"
```

Setup refuses to replace existing files. Edit the existing configuration explicitly or choose new paths. Keep key files and session material out of source-control commits; the default `.cothink/` directory is ignored in this repository.

`test` can send up to four paid API requests. See [configuration and diagnostics](CONFIGURATION.md) for the call bounds, compatibility limits and troubleshooting. Verify installation with `--help` and `--version` before running a paid check.

## Upgrade or remove

Build and pack the desired source version, then install its tarball using the same command with the matching filename. Installing a package does not migrate or delete saved sessions. To remove the globally installed executable:

```bash
npm uninstall -g cothink
```

When running inside your own Git project, add `.cothink/` and any custom credential-file path to that project's `.gitignore`. This repository already ignores its own local data; the CLI does not edit another project's ignore rules.
