# WL2GO

An all-in-one [Winlink](https://winlink.org/) email client for amateur radio operators.

WL2GO puts the soft-modem, the Winlink protocol engine and rig control in one desktop app, so there's nothing else to install. It has an Outlook-style mailbox (folders, message list, reading pane, compose windows), and the buttons work the way existing Winlink Express users expect.

> **Status: early development.** macOS on Apple Silicon is the only platform built and tested so far. Expect rough edges, and check transmissions on air carefully.

## Download

Test builds for Macs with Apple Silicon running **macOS 26 (Tahoe) or later** are on the [Releases page](https://github.com/jkmurre/WL2GO/releases). Each zip contains `WL2GO.app` and its release notes. The notes explain how to open a build that isn't signed with an Apple Developer ID (see [RELEASE_NOTES.md](RELEASE_NOTES.md)).

Builds aren't packaged for Windows or Linux yet.

## Features

- **Connections:** Telnet to the Winlink CMS, and ARDOP over HF through a bundled soft-modem.
- **Radio Profiles:** each profile bundles the mode, audio/serial interface and rig control settings, so reconnecting takes one click. A guided setup wizard walks you through creating one.
- **Rig control** through Hamlib's `rigctld`: frequency, mode, PTT, drive level and tuning.
- **Leaves the radio as it found it:** WL2GO saves the radio's frequency and mode when it connects and restores them on disconnect or quit. Then it sends PTT off on its own, whether or not the restore worked.
- **Local mailbox:** a fast, searchable SQLite index over Pat's on-disk mailbox, plus drafts, user folders, attachments and archive.
- **Station browser:** RMS gateway lists and hybrid-network pickup stations, plus direct station-to-station calls and radio-only sessions.

## How it works

WL2GO is an Electron app that runs three open-source programs as local subprocesses:

| Component | Role | License |
|---|---|---|
| [Pat](https://github.com/la5nta/pat) | Winlink protocol engine, driven through its local HTTP/WebSocket API | MIT |
| [ardopcf](https://github.com/pflarue/ardop) | ARDOP soft-modem (built with a PortAudio backend on macOS) | MIT |
| [Hamlib](https://github.com/Hamlib/Hamlib) `rigctld` | CAT/PTT rig control | GPL-2.0 (rigctld), LGPL-2.1 (libhamlib) |

Each one is built from a pinned upstream commit or checksummed tarball, with a small set of patches in [vendor/](vendor/). Every subprocess listens on loopback only. Pat's API is protected by a token generated at each launch.

## Building from source

Prerequisites (macOS, Apple Silicon):

The bundled programs are built for the macOS version you build on, so the app runs on that version or newer.

- Node.js 22.18 or later
- Go 1.27.4 or later (stdlib security fixes reach Pat only through the toolchain)
- Xcode Command Line Tools (`xcode-select --install`)
- git and curl

```sh
npm run bootstrap
```

This installs npm dependencies, builds Pat, ardopcf and rigctld from source into `resources/bin/`, builds the app, and packages an ad-hoc-signed `release/mac-arm64/WL2GO.app`. The steps can also be run one at a time:

```sh
npm install
npm run build:pat
npm run build:ardopcf
npm run build:rigctld
npm run pack:mac
```

To develop with hot reload, run `npm run dev`.

### Checks

```sh
npm run typecheck
npm test
```

## Licensing

WL2GO is released under the [MIT License](LICENSE). The packaged app includes the license text of every bundled component, generated at build time by [scripts/collect-licenses.mjs](scripts/collect-licenses.mjs). Corresponding source for the GPL/LGPL components (Hamlib, libusb) is the pinned upstream release that [scripts/build-rigctld.sh](scripts/build-rigctld.sh) fetches and checksums.

## Disclaimer

Transmitting with WL2GO requires an amateur radio license, and you're responsible for every transmission made under your callsign. The software comes with no warranty (see [LICENSE](LICENSE)).

## Security

See [SECURITY.md](SECURITY.md) to report a vulnerability.
