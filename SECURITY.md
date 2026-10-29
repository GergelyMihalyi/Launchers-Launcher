# Security

## Reporting a vulnerability

Please **do not open a public issue** for a security problem. Use GitHub's private vulnerability reporting
(the repository's **Security** tab → **Report a vulnerability**). I will answer as soon as I can.

Only the latest release is supported.

## What the launcher trusts (so you can judge a report)

The launcher is a kiosk program for your own machine; it deliberately runs some things for you:

- **Self-update** runs `git pull --ff-only` on the repository it was installed from and then `npm install` when
  `package.json` changed. Whoever can push to that repository's default branch can run code on every machine that
  updates from it. A failed start rolls back to the previous commit.
- **`install.sh` / `get-launchers-launcher.sh`** (`curl … | bash`) run shell code, and install packages with `sudo` after one confirmation.
- **Settings → Startup → Close apps on TV mode** can hold `cmd` lines that run through `bash -lc` when TV mode starts. They are
  read from a sidecar file that the launcher writes with mode `0600`; the script refuses it if it is not owned by the user or
  is writable by others.
- **Custom launchers** run the command you add. The renderer cannot add an arbitrary command: the main process only accepts
  `flatpak run <appid>`, a catalog command, or an existing non-shell program (`checkLauncherPayload`).
- The renderer is sandboxed (`contextIsolation`, no Node integration, a strict CSP, navigation locked), and every field it sends
  to the main process is validated.

A way around one of these guards is a vulnerability worth reporting.
