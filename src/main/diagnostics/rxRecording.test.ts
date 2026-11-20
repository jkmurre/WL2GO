import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { NO_RECORD_RX_MARKER, RECORD_RX_ENV_VAR, rxRecordingDir } from "./rxRecording.ts";

const noMarker = () => false;

describe("rxRecordingDir", () => {
  it("follows the Settings toggle, and the toggle's default is off", () => {
    // Recording ran on by default while the audio path was being debugged;
    // now that it is a Settings switch, quiet is the resting state -- the
    // WAVs cost ~24 kB/s and nothing prunes them.
    assert.equal(rxRecordingDir("/logs", true, {}, noMarker), "/logs");
    assert.equal(rxRecordingDir("/logs", false, {}, noMarker), undefined);
  });

  it("is turned off by the marker file even when the toggle is on", () => {
    const seen: string[] = [];
    const marker = (p: string) => {
      seen.push(p);
      return p.endsWith(NO_RECORD_RX_MARKER);
    };
    assert.equal(rxRecordingDir("/logs", true, {}, marker), undefined);
    assert.deepEqual(seen, [`/logs/${NO_RECORD_RX_MARKER}`]);
  });

  it("is turned off by the env var, whatever the toggle says", () => {
    for (const off of ["0", "false", "FALSE", " 0 ", ""]) {
      assert.equal(rxRecordingDir("/logs", true, { [RECORD_RX_ENV_VAR]: off }, noMarker), undefined, JSON.stringify(off));
    }
  });

  it("is forced ON by any other env value, keeping the shell-launched debugging workflow", () => {
    // WL2GO_RECORD_RX=1 recorded before the toggle existed and must keep
    // doing so with the toggle off -- a developer chasing an audio bug should
    // not also have to flip a setting in the app under test.
    for (const on of ["1", "true", "yes"]) {
      assert.equal(rxRecordingDir("/logs", false, { [RECORD_RX_ENV_VAR]: on }, noMarker), "/logs", on);
    }
  });

  it("lets the marker file win over an env force-on", () => {
    const marker = (p: string) => p.endsWith(NO_RECORD_RX_MARKER);
    assert.equal(rxRecordingDir("/logs", false, { [RECORD_RX_ENV_VAR]: "1" }, marker), undefined);
  });

  it("declines when there is nowhere to write, whatever else is set", () => {
    // ardopcf falls back to the process CWD when the log directory is empty
    // (PaSound.c:189-198) -- for a packaged app, somewhere unfindable.
    assert.equal(rxRecordingDir(null, true, {}, noMarker), undefined);
  });
});
