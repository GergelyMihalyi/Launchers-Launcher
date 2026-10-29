# Contributing

Thanks for helping! This is a small project built around one living-room PC, so the most valuable
contributions are **reports and fixes from other machines** (another distro, desktop, GPU, TV or controller).

## Reporting a bug

Open an issue and include:

- your distro and version (`/etc/os-release`), `echo $XDG_CURRENT_DESKTOP $XDG_SESSION_TYPE`, your GPU,
  the controller type, and the launcher version;
- **Settings → System → Diagnostics** (versions, platform, missing commands);
- the log: **Settings → System → Log**, then **□** (export), writes `~/launchers-launcher-log-<date>.txt`. It can contain file
  paths and Wi-Fi names — look at it before attaching.

## Development setup

```bash
git clone https://github.com/GergelyMihalyi/Launchers-Launcher.git ~/launchers-launcher
cd ~/launchers-launcher
npm install            # also switches on the git hooks
npm test               # unit and contract tests, no GUI needed (Node >= 22.12)
npm run typecheck      # JSDoc type check, no build step
npm run test:e2e       # offscreen Electron smoke test (starts the real renderer)
npm start              # run the launcher (needs a graphical session)
```

There is no build step, no bundler and no framework. Start with [docs/dev/README.md](docs/dev/README.md): it maps
the architecture, every module and the many hardware gotchas. The conventions a change must follow:

- **Folder organisation:** a new file goes into the folder of its role (`lib/ipc/`, `lib/launchers/`, `renderer/settings/`, …) and
  its test mirrors the path under `test/` — [docs/dev/architecture.md](docs/dev/architecture.md#folder-organisation-rules).
- **Everything is English** — code, comments, log lines, tests, docs. The only Hungarian is the program's own UI table
  (`renderer/i18n/i18n-hu.js`). `test/contracts/english-only.test.js` enforces it.
- **User-visible strings go through `tr()`** and need an entry in **both** language tables.
- **Every external command needs a timeout** (`lib/timings.js`); renderer input is validated with `lib/validate.js`.
- **Tests:** a change to a parser, a config key, an IPC channel or the renderer comes with a test. GUI behaviour that tests
  cannot cover must be tried on a real machine — say in the pull request what you tried.
- **Commits:** one short, lowercase, imperative line in Conventional Commits style (`feat: …`, `fix: …`, `docs: …`).

## Pull requests

Keep a pull request to one topic and describe what you verified and on which setup. Add a line to
the `[Unreleased]` section of [CHANGELOG.md](CHANGELOG.md) (add the heading above the latest version if there is none) for anything a user would notice. By contributing you
agree that your work is released under the project's [MIT license](LICENSE).
