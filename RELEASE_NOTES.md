# WL2GO 0.1.0 — Release notes

The first public test build of WL2GO, an all-in-one Winlink email client for amateur radio. The soft-modem, the Winlink engine and rig control are built in, so there's nothing else to install.

> **This is an early test build.** Watch your first transmissions closely, and please report problems on the [issue tracker](https://github.com/jkmurre/WL2GO/issues).

## Requirements

- A Mac with Apple Silicon (M1 or later). Intel Macs aren't supported yet.
- **macOS 26 (Tahoe) or later.** The bundled modem and rig-control programs need it.
- An amateur radio license, and a Winlink account for your callsign.
- For radio connections: a radio with a USB audio/CAT interface (or a separate sound card and serial PTT).

## Installing

1. Drag **WL2GO.app** into your **Applications** folder.
2. This build isn't signed with an Apple Developer ID, so macOS will block it the first time. In Terminal, run:

   ```sh
   xattr -dr com.apple.quarantine /Applications/WL2GO.app
   ```

   Alternatively, try to open the app once, then go to **System Settings → Privacy & Security** and click **Open Anyway**.
3. Open WL2GO. On first launch macOS asks whether WL2GO may use its Keychain entry, which is where your Winlink password is stored encrypted. Click **Always Allow**. Until you do, the app waits on the "Loaded config" step.

   Each new test build asks again, because its signature changes.

## What's in this build

- **Telnet** connections to the Winlink CMS over the internet.
- **ARDOP** connections over HF, through the built-in soft-modem. WL2GO listens for a clear channel before transmitting and sends your station ID at the end.
- **Radio Profiles:** a guided wizard that saves your mode, audio device, serial port and rig settings together, so reconnecting takes one click.
- **Rig control** for frequency, mode, PTT, drive level and a tuning carrier.
- **Leaves the radio as it found it.** On disconnect or quit, WL2GO puts back the radio's frequency and mode, then sends PTT off on its own.
- **Mailbox:** Inbox, Outbox, Sent, Drafts, Archive and your own folders, with search, attachments, reply, forward and acknowledgements. Messages waiting in the Outbox can still be edited.
- **Station browser:** RMS gateways, hybrid-network pickup stations, direct station-to-station calls and radio-only sessions.

## Security

- Every built-in program listens only on your own Mac (loopback), never on your network.
- Your Winlink and radio LAN passwords are stored encrypted in the macOS Keychain.
- Links in messages open only as web links (http/https) in your browser. Message content can't open files or run programs.

## Known limitations

- Only macOS on Apple Silicon so far. Windows and Linux builds aren't packaged yet.
- No auto-update. Download each new build by hand.
- VARA and packet aren't supported. VARA is closed source and can't be bundled.

## Bundled components

| Component | Version | License |
|---|---|---|
| Electron | 43.8.10 | MIT |
| Pat | 1.0.0, with WL2GO patches | MIT |
| ardopcf | 1.0.4.1.3, with WL2GO patches | MIT |
| Hamlib `rigctld` | 4.7.2 | GPL-2.0 / LGPL-2.1 |
| libusb | 1.0.30 | LGPL-2.1 |
| PortAudio | 19.7.0 | MIT |

The full license texts ship inside the app at `WL2GO.app/Contents/Resources/licenses/`. Source code, including the source for the GPL/LGPL components, is at <https://github.com/jkmurre/WL2GO>.

## Reporting problems

- **Bugs:** <https://github.com/jkmurre/WL2GO/issues>. Logs help. In WL2GO, use **Open Logs** and attach the latest log file.
- **Security issues:** please report privately. See [SECURITY.md](https://github.com/jkmurre/WL2GO/blob/main/SECURITY.md).

WL2GO comes with no warranty. You're responsible for every transmission made under your callsign.
