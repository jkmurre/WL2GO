import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { LOOPBACK_HOST, loopbackAddr } from "./loopback.ts";
import { PatProcessManager } from "../pat/patProcessManager.ts";
import { ArdopProcessManager } from "../ardop/ardopProcessManager.ts";
import { RigctldProcessManager } from "../rigctl/rigctldProcessManager.ts";

/**
 * Every service WL2GO spawns must listen on loopback and nothing else.
 *
 * These are regression tests, not unit tests: each of the three defaults to
 * binding every interface, and the consequences are real -- an open rigctld port
 * lets anyone on the network key the transmitter, ardopcf's host port is TNC
 * control, and Pat's HTTP API is unauthenticated remote control of the station.
 * A future edit that drops one of these flags fails here rather than in the field.
 */
describe("loopback binding", () => {
  it("uses the documented loopback address", () => {
    assert.equal(LOOPBACK_HOST, "127.0.0.1");
    assert.equal(loopbackAddr(8080), "127.0.0.1:8080");
  });

  it("binds Pat's HTTP API to loopback, never all interfaces", () => {
    const args = new PatProcessManager({
      resourcesBinDir: "/r/bin",
      configPath: "/c/config.json",
      mailboxDir: "/c/mbox",
      prehooksDir: "/c/prehooks",
      logPath: "/c/pat-logs/pat.log",
      eventLogPath: "/c/pat-logs/eventlog.json",
      formsDir: "/c/pat-forms",
      httpPort: 17812,
    }).buildArgs();

    const addrIndex = args.indexOf("--addr");
    assert.notEqual(addrIndex, -1, "Pat must be given an explicit listen address");
    assert.equal(args[addrIndex + 1], "127.0.0.1:17812");

    // A bare ":port" is what Go reads as "every interface" -- the exact bug.
    assert.equal(args.includes(":17812"), false, "a bare :port binds every interface");
  });

  it("binds ardopcf's host port to loopback via patch 0005", () => {
    const args = new ArdopProcessManager({ resourcesBinDir: "/r/bin", hostPort: 8515 }).buildArgs();

    const bindIndex = args.indexOf("--hostbind");
    assert.notEqual(bindIndex, -1, "ardopcf must be given --hostbind (vendor patch 0005)");
    assert.equal(args[bindIndex + 1], LOOPBACK_HOST);
  });

  it("puts ardopcf's options before its positionals", () => {
    // Not cosmetic. ardopcf reads positionals as argv[optind + n], so options
    // placed after them are only seen if this platform's getopt permutes.
    // glibc does; BSD-derived getopt, which macOS ships, may stop at the first
    // non-option and silently drop every flag after it.
    const args = new ArdopProcessManager({ resourcesBinDir: "/r/bin", hostPort: 8515 }).buildArgs();

    const firstPositional = args.indexOf("8515");
    assert.notEqual(firstPositional, -1, "the port is passed positionally");
    assert.ok(
      args.indexOf("--hostbind") < firstPositional,
      "--hostbind must precede the positional arguments or getopt may never see it",
    );
    assert.ok(args.indexOf("-m") < firstPositional, "-m must precede the positional arguments");

    // The three positionals must stay adjacent and in order.
    assert.deepEqual(args.slice(firstPositional), ["8515", "NOSOUND", "NOSOUND"]);
  });

  it("binds rigctld to loopback, whose default is ANY", () => {
    const args = new RigctldProcessManager({ resourcesBinDir: "/r/bin" }).buildArgs();

    const bindIndex = args.indexOf("-T");
    assert.notEqual(bindIndex, -1, "rigctld must be given -T; its default listen address is ANY");
    assert.equal(args[bindIndex + 1], LOOPBACK_HOST);
  });

  it("leaves no service bound to a wildcard address", () => {
    const all = [
      new PatProcessManager({
        resourcesBinDir: "/r/bin",
        configPath: "/c/config.json",
        mailboxDir: "/c/mbox",
        prehooksDir: "/c/prehooks",
      logPath: "/c/pat-logs/pat.log",
      eventLogPath: "/c/pat-logs/eventlog.json",
      formsDir: "/c/pat-forms",
        httpPort: 17812,
      }).buildArgs(),
      new ArdopProcessManager({ resourcesBinDir: "/r/bin", hostPort: 8515 }).buildArgs(),
      new RigctldProcessManager({ resourcesBinDir: "/r/bin" }).buildArgs(),
    ];

    for (const args of all) {
      for (const arg of args) {
        assert.doesNotMatch(arg, /^0\.0\.0\.0/, `"${arg}" binds every interface`);
        assert.doesNotMatch(arg, /^::/, `"${arg}" binds every interface`);
      }
    }
  });
});
