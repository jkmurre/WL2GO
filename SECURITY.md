# Security policy

## Reporting a vulnerability

Please **don't** open a public issue for a security problem.

Report it privately through GitHub's [private vulnerability reporting](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability): go to the **Security** tab of this repository and click **Report a vulnerability**.

Please include:

- the WL2GO version (or commit) and your OS
- what an attacker could do, and what access they'd need (for example: on the local network, over the air, or able to send you a Winlink message)
- steps to reproduce, or a proof of concept

You'll get an acknowledgement within a week. A fix ships as soon as a release can carry it, and you'll be credited in the advisory unless you'd rather not be.

## Scope

In scope:

- the WL2GO app (Electron main process, preload, renderer)
- WL2GO's patches to Pat and ardopcf in [vendor/](vendor/), and the build scripts in [scripts/](scripts/)
- how WL2GO starts and exposes the bundled subprocesses (loopback binding, Pat's API token)

Bugs in Pat, ardopcf, Hamlib, libusb, PortAudio or Electron themselves should go to those projects. If one of them makes WL2GO exploitable, please tell us too.

## Supported versions

Only the latest release, and `main`, get security fixes.
