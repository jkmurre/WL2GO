import type { AudioDeviceTestResult, TestAudioDevicesRequest } from "../../shared/ipcContract.ts";
import { ArdopProcessManager } from "../ardop/ardopProcessManager.ts";
import { findFreePortPair } from "../util/tcpProbe.ts";
import { listAudioDevices } from "./audioDeviceService.ts";
import { resolveAudioDevice } from "./deviceResolver.ts";

/**
 * Answers "will these two devices actually work?" by opening them.
 *
 * This is the only honest answer available. PortAudio's Pa_IsFormatSupported is
 * a prediction that CoreAudio in particular contradicts, and ardopcf itself
 * never consults it -- it opens the stream and exits if that fails. So the test
 * does exactly what a connection would do, just briefly and on a scratch port.
 *
 * ArdopProcessManager already detects this precise failure: ardopcf exits
 * immediately when it cannot open a device, and waitForTcpPort's shouldAbort
 * catches the exit before the readiness timeout. All this adds is turning that
 * into a sentence the operator can act on, BEFORE a connect attempt does it the
 * hard way in the middle of a session.
 */
export async function testAudioDevices(
  resourcesBinDir: string,
  request: TestAudioDevicesRequest,
): Promise<AudioDeviceTestResult> {
  let devices;
  try {
    devices = await listAudioDevices(resourcesBinDir);
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err), warnings: [] };
  }

  const capture = resolveAudioDevice(request.input, devices, "capture");
  if (!capture.ok) return { ok: false, message: capture.message, warnings: [] };

  const playback = resolveAudioDevice(request.output, devices, "playback");
  if (!playback.ok) return { ok: false, message: playback.message, warnings: [] };

  const warnings = [...capture.warnings, ...playback.warnings];

  // A scratch port, never the profile's: testing must not collide with a modem
  // already running on the configured one.
  const hostPort = await findFreePortPair();

  const modem = new ArdopProcessManager({
    resourcesBinDir,
    hostPort,
    captureDevice: capture.argument,
    playbackDevice: playback.argument,
  });

  try {
    await modem.start();
    return {
      ok: true,
      message:
        `Opened "${capture.device?.name ?? "the default input"}" and ` +
        `"${playback.device?.name ?? "the default output"}" at 12000 Hz.`,
      warnings,
    };
  } catch (err) {
    return {
      ok: false,
      message: describeOpenFailure(err instanceof Error ? err.message : String(err)),
      warnings,
    };
  } finally {
    // Always, including on the success path -- the modem holds the sound card
    // exclusively, and leaving it running would block the real connection.
    //
    // Safe to call after a failed start(), which already stopped the process
    // itself: stop() returns early when there is no process and leaves the
    // "failed" state alone. Keep this call; the belt-and-braces looks redundant
    // but the success path has nothing else that releases the device.
    await modem.stop();
  }
}

/**
 * ardopcf's own exit is silent about the cause, and on macOS the most likely
 * cause is one the operator can fix in System Settings rather than in WL2GO.
 */
function describeOpenFailure(reason: string): string {
  if (process.platform === "darwin") {
    return (
      `The modem could not open those devices. ${reason}\n\n` +
      `If macOS asked for microphone access and it was declined, WL2GO cannot ` +
      `hear the radio: allow it under System Settings > Privacy & Security > Microphone.`
    );
  }
  return `The modem could not open those devices. ${reason}`;
}
