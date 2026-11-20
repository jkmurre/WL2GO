import assert from "node:assert/strict";
import * as http from "node:http";
import { closeSync, mkdtempSync, openSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";
import {
  PAT_TOKEN_ENV,
  PatProcessManager,
  prepareLogFile,
  resolveBinaryPath,
  tryGetStatus,
  waitUntilReady,
} from "./patProcessManager.ts";

const servers: http.Server[] = [];

after(async () => {
  await Promise.all(servers.map((s) => new Promise<void>((resolve) => s.close(() => resolve()))));
});

async function startServer(handler: http.RequestListener): Promise<number> {
  const server = http.createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (typeof address === "string" || address === null) throw new Error("expected a TCP address");
  return address.port;
}

describe("resolveBinaryPath", () => {
  it("keys binaries by Node's platform and arch", () => {
    assert.equal(resolveBinaryPath("/r/bin", "pat", "darwin", "arm64"), "/r/bin/darwin/arm64/pat");
    assert.equal(resolveBinaryPath("/r/bin", "pat", "linux", "x64"), "/r/bin/linux/x64/pat");
  });

  it("appends .exe on Windows only", () => {
    assert.equal(resolveBinaryPath("/r/bin", "pat", "win32", "x64"), "/r/bin/win32/x64/pat.exe");
    assert.ok(!resolveBinaryPath("/r/bin", "pat", "darwin", "arm64").endsWith(".exe"));
  });

  it("uses Node's arch vocabulary, not Go's", () => {
    // scripts/build-pat.sh translates Go's "amd64" into Node's "x64" when it
    // chooses an output directory; if that mapping regresses, the two sides
    // disagree and the binary is silently unfindable at runtime.
    const resolved = resolveBinaryPath("/r/bin", "pat", "linux", "x64");
    assert.ok(resolved.includes("/x64/"));
    assert.ok(!resolved.includes("amd64"));
  });

  it("supports the other vendored binaries", () => {
    assert.equal(resolveBinaryPath("/r/bin", "ardopcf", "linux", "arm64"), "/r/bin/linux/arm64/ardopcf");
    assert.equal(resolveBinaryPath("/r/bin", "rigctld", "win32", "x64"), "/r/bin/win32/x64/rigctld.exe");
  });
});

describe("tryGetStatus", () => {
  it("is true only for a 200 response", async () => {
    const okPort = await startServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
    });
    const notFoundPort = await startServer((_req, res) => {
      res.writeHead(404);
      res.end();
    });

    assert.equal(await tryGetStatus(okPort), true);
    assert.equal(await tryGetStatus(notFoundPort), false);
  });

  it("sends the API token when given one", async () => {
    const port = await startServer((req, res) => {
      res.writeHead(req.headers["x-wl2go-token"] === "tok" ? 200 : 403);
      res.end();
    });
    assert.equal(await tryGetStatus(port, "127.0.0.1", 1000, "tok"), true);
    assert.equal(await tryGetStatus(port), false, "a guarded Pat refuses a probe without it");
  });

  it("is false when nothing is listening", async () => {
    // Port 1 is privileged and unbound in test environments.
    assert.equal(await tryGetStatus(1, "127.0.0.1", 300), false);
  });
});

describe("waitUntilReady", () => {
  it("resolves once the API starts answering", async () => {
    let calls = 0;
    const port = await startServer((_req, res) => {
      calls += 1;
      if (calls < 3) {
        res.writeHead(404);
        res.end();
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
    });

    await waitUntilReady(port, 5000, { intervalMs: 10 });
    assert.ok(calls >= 3);
  });

  it("rejects when the API never becomes ready", async () => {
    const port = await startServer((_req, res) => {
      res.writeHead(500);
      res.end();
    });

    await assert.rejects(waitUntilReady(port, 200, { intervalMs: 10 }), /did not respond/);
  });

  it("aborts early when the process dies, instead of waiting out the timeout", async () => {
    const port = await startServer((_req, res) => {
      res.writeHead(404);
      res.end();
    });

    await assert.rejects(
      waitUntilReady(port, 30_000, { intervalMs: 10, shouldAbort: () => "Pat exited with code=1" }),
      /exited with code=1/,
    );
  });
});

describe("PatProcessManager: spawn surface", () => {
  function manager(winlinkPassword: string | null = null, apiToken: string | null = null) {
    return new PatProcessManager({
      resourcesBinDir: "/r/bin",
      configPath: "/c/pat-config/config.json",
      mailboxDir: "/c/pat-mailbox",
      prehooksDir: "/c/pat-prehooks",
      logPath: "/c/pat-logs/pat.log",
      eventLogPath: "/c/pat-logs/eventlog.json",
      formsDir: "/c/pat-forms",
      httpPort: 17812,
      winlinkPassword,
      apiToken,
    });
  }

  it("passes no --mycall, so Pat's config is the single source", () => {
    // With the flag absent Pat adopts options.MyCall from config.mycall
    // (app/app.go:217-224), which also makes the password wipe at app.go:230-233
    // unreachable -- there is nothing left for config.mycall to disagree with.
    assert.equal(manager().buildArgs().includes("--mycall"), false);
  });

  it("points Pat's prehooks inside our own data directory", () => {
    // Pat's default is outside the app entirely, and a prehook inherits Pat's
    // environment -- which carries the Winlink password.
    const args = manager().buildArgs();
    const index = args.indexOf("--prehooks");
    assert.notEqual(index, -1);
    assert.equal(args[index + 1], "/c/pat-prehooks");
  });

  it("never puts the password in the command line", () => {
    // argv is readable by any process via `ps`. This is the assertion that
    // stops someone "simplifying" the environment plumbing into a flag.
    const args = manager("hunter2").buildArgs();
    assert.equal(args.join(" ").includes("hunter2"), false);
  });

  it("passes the password through PAT_SECURELOGINPASSWORD", () => {
    // The name is fixed by envconfig's rules: prefix "Pat" (app/config.go:33)
    // plus the untagged field SecureLoginPassword.
    const env = manager("hunter2").buildEnv({ PATH: "/usr/bin" });
    assert.equal(env["PAT_SECURELOGINPASSWORD"], "hunter2");
    assert.equal(env["PATH"], "/usr/bin", "the rest of the environment is preserved");
  });

  it("omits the variable entirely when no password is stored", () => {
    // Absent and empty mean different things; empty would still override.
    const env = manager(null).buildEnv({ PATH: "/usr/bin" });
    assert.equal("PAT_SECURELOGINPASSWORD" in env, false);
  });

  it("does not inherit a stale password from its own environment", () => {
    // If WL2GO itself were launched with the variable set, a cleared password
    // would otherwise silently keep working.
    const env = manager(null).buildEnv({ PAT_SECURELOGINPASSWORD: "stale" });
    assert.equal("PAT_SECURELOGINPASSWORD" in env, false);
  });

  it("keeps Pat's API on loopback", () => {
    const args = manager().buildArgs();
    assert.equal(args[args.indexOf("--addr") + 1], "127.0.0.1:17812");
  });

  it("passes the API token through the environment, never the command line", () => {
    const m = manager(null, "tok123");
    assert.equal(m.buildEnv({})[PAT_TOKEN_ENV], "tok123");
    assert.equal(m.buildArgs().join(" ").includes("tok123"), false);
  });

  it("does not inherit a stale API token from its own environment", () => {
    const env = manager(null, null).buildEnv({ [PAT_TOKEN_ENV]: "stale" });
    assert.equal(PAT_TOKEN_ENV in env, false);
  });

  it("reports port 0 until a start picks one, when none is fixed", () => {
    const m = new PatProcessManager({
      resourcesBinDir: "/r/bin",
      configPath: "/c/c.json",
      mailboxDir: "/c/m",
      prehooksDir: "/c/p",
      logPath: "/c/l/pat.log",
      eventLogPath: "/c/l/e.json",
      formsDir: "/c/f",
    });
    assert.equal(m.httpPort, 0);
    assert.equal(m.getState().httpPort, 0);
  });
});

describe("prepareLogFile", () => {
  it("creates Pat's log owner-only, in a directory only the owner can enter", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "wl2go-patlog-"));
    try {
      const logPath = path.join(dir, "nested", "pat.log");
      await prepareLogFile(logPath);

      assert.equal(statSync(logPath).mode & 0o777, 0o600);
      assert.equal(statSync(path.dirname(logPath)).mode & 0o777, 0o700);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fixes the mode of a file Pat already created world-readable", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "wl2go-patlog-"));
    try {
      const logPath = path.join(dir, "pat.log");
      writeFileSync(logPath, "old content\n", { mode: 0o644 });

      await prepareLogFile(logPath);
      assert.equal(statSync(logPath).mode & 0o777, 0o600);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps the mode when the file is truncated in place, as Go's os.Create does", async () => {
    // The whole mitigation rests on this: Go applies os.Create's 0666 only when
    // creating. On an existing file it truncates and leaves the mode alone -- so
    // pre-creating at 0600 is what keeps the activation password unreadable by
    // other users. Asserted rather than assumed.
    const dir = mkdtempSync(path.join(tmpdir(), "wl2go-patlog-"));
    try {
      const logPath = path.join(dir, "pat.log");
      await prepareLogFile(logPath);

      // O_CREAT|O_TRUNC|O_WRONLY with 0666 is exactly what os.Create issues.
      const fd = openSync(logPath, "w", 0o666);
      writeSync(fd, "pat writes its log\n");
      closeSync(fd);

      assert.equal(statSync(logPath).mode & 0o777, 0o600, "truncation must not widen the mode");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("is safe to run again before every spawn", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "wl2go-patlog-"));
    try {
      const logPath = path.join(dir, "pat.log");
      await prepareLogFile(logPath);
      writeFileSync(logPath, "session one\n");
      await prepareLogFile(logPath);

      // Appending, not truncating: Pat clears the file itself on startup, and
      // destroying it here would lose the previous session before it is read.
      assert.equal(readFileSync(logPath, "utf8"), "session one\n");
      assert.equal(statSync(logPath).mode & 0o777, 0o600);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
