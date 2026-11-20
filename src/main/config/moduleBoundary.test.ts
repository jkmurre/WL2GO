import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import * as path from "node:path";
import { describe, it } from "node:test";

const HERE = import.meta.dirname;

/** Collects every module reachable from an entry file by relative import. */
async function transitiveImports(entry: string): Promise<Map<string, string>> {
  const seen = new Map<string, string>();
  const queue = [entry];

  while (queue.length) {
    const file = queue.pop()!;
    if (seen.has(file)) continue;

    const source = await readFile(file, "utf8");
    seen.set(file, source);

    for (const match of source.matchAll(/^import\s[^"']*["'](\.[^"']+)["'];?$/gm)) {
      queue.push(path.resolve(path.dirname(file), match[1]!));
    }
  }

  return seen;
}

/**
 * The config and secret stores are unit tested by `node --test`, which runs
 * outside Electron. An `electron` import anywhere in their graph would make them
 * unimportable there -- and that is precisely why this project hand-rolls them
 * instead of using electron-store. Guard the boundary so it cannot be lost to a
 * convenient import later.
 */
describe("config store module boundary", () => {
  for (const entry of ["configStore.ts", "secretStore.ts"]) {
    it(`${entry} reaches no Electron import`, async () => {
      const modules = await transitiveImports(path.join(HERE, entry));

      for (const [file, source] of modules) {
        assert.doesNotMatch(
          source,
          /from ["']electron["']/,
          `${path.relative(HERE, file)} imports electron, which breaks testing outside Electron`,
        );
      }
    });
  }

  /**
   * The mailbox cache has the same constraint for the same reason: mailboxDb,
   * mailboxSync and the mapper are all unit tested by `node --test`, outside
   * Electron. Guarded here rather than in its own file so there is one place
   * that answers "what must stay importable outside Electron?".
   */
  for (const entry of ["mailboxDb.ts", "mailboxSync.ts", "patMessageMapper.ts"]) {
    it(`mailbox/${entry} reaches no Electron import`, async () => {
      const modules = await transitiveImports(path.join(HERE, "..", "mailbox", entry));

      for (const [file, source] of modules) {
        assert.doesNotMatch(
          source,
          /from ["']electron["']/,
          `${path.relative(HERE, file)} imports electron, which breaks testing outside Electron`,
        );
      }
    });
  }

  /** Drafts and compose have the same constraint, for the same reason. */
  for (const entry of ["draftStore.ts", "composeService.ts"]) {
    it(`drafts/${entry} reaches no Electron import`, async () => {
      const modules = await transitiveImports(path.join(HERE, "..", "drafts", entry));

      for (const [file, source] of modules) {
        assert.doesNotMatch(
          source,
          /from ["']electron["']/,
          `${path.relative(HERE, file)} imports electron, which breaks testing outside Electron`,
        );
      }
    });
  }

  it("folders/folderStore.ts reaches no Electron import", async () => {
    const modules = await transitiveImports(path.join(HERE, "..", "folders", "folderStore.ts"));

    for (const [file, source] of modules) {
      assert.doesNotMatch(
        source,
        /from ["']electron["']/,
        `${path.relative(HERE, file)} imports electron, which breaks testing outside Electron`,
      );
    }
  });

  it("keeps Electron on the service side of the boundary", async () => {
    // The counterpart assertion: safeStorage has to be reached somewhere, and
    // configService is the agreed place. If this ever fails, the injection seam
    // has moved and the tests above are no longer proving anything.
    const service = await readFile(path.join(HERE, "configService.ts"), "utf8");
    assert.match(service, /import \{ safeStorage \} from "electron"/);
  });
});
