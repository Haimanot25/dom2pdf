import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Dom2PdfError } from "../src/errors/index.js";
import { assertLocalFileAllowed, type LocalFilePolicy } from "../src/security/destination-policy.js";

let workspace: string;
let allowedDir: string;
let outsideDir: string;

beforeEach(async () => {
  workspace = await mkdtemp(path.join(tmpdir(), "dom2pdf-file-policy-"));
  allowedDir = path.join(workspace, "allowed");
  outsideDir = path.join(workspace, "outside");
  await mkdir(allowedDir);
  await mkdir(outsideDir);
  await writeFile(path.join(allowedDir, "inside.html"), "<p>inside</p>");
  await writeFile(path.join(outsideDir, "secret.html"), "<p>secret</p>");
  await writeFile(path.join(allowedDir, "notes.txt"), "not html");
});

afterEach(async () => {
  await rm(workspace, { recursive: true, force: true });
});

function policy(overrides: Partial<LocalFilePolicy> = {}): LocalFilePolicy {
  return {
    allowLocalFiles: true,
    allowedLocalDirectories: [allowedDir],
    ...overrides,
  };
}

async function expectCode(promise: Promise<unknown>, code: string): Promise<Dom2PdfError> {
  let caught: unknown;
  try {
    await promise;
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(Dom2PdfError);
  const error = caught as Dom2PdfError;
  expect(error.code).toBe(code);
  return error;
}

describe("assertLocalFileAllowed", () => {
  it("is disabled by default", async () => {
    await expectCode(
      assertLocalFileAllowed(path.join(allowedDir, "inside.html"), {
        allowLocalFiles: false,
        allowedLocalDirectories: [allowedDir],
      }),
      "LOCAL_FILE_NOT_ALLOWED",
    );
    await expectCode(
      assertLocalFileAllowed(path.join(allowedDir, "inside.html"), {
        allowLocalFiles: true,
        allowedLocalDirectories: [],
      }),
      "LOCAL_FILE_NOT_ALLOWED",
    );
  });

  it("accepts .html files inside an allowed directory", async () => {
    const resolved = await assertLocalFileAllowed(path.join(allowedDir, "inside.html"), policy());
    expect(resolved).toBe(await realpath(path.join(allowedDir, "inside.html")));
  });

  it("accepts .htm extension", async () => {
    const target = path.join(allowedDir, "page.htm");
    await writeFile(target, "<p>x</p>");
    await expect(assertLocalFileAllowed(target, policy())).resolves.toBeTypeOf("string");
  });

  it("rejects non-HTML extensions", async () => {
    await expectCode(assertLocalFileAllowed(path.join(allowedDir, "notes.txt"), policy()), "INVALID_INPUT");
  });

  it("rejects missing files", async () => {
    await expectCode(assertLocalFileAllowed(path.join(allowedDir, "absent.html"), policy()), "INVALID_INPUT");
  });

  it("rejects files outside the allowed directories", async () => {
    await expectCode(
      assertLocalFileAllowed(path.join(outsideDir, "secret.html"), policy()),
      "LOCAL_FILE_NOT_ALLOWED",
    );
  });

  it("rejects path traversal attempts", async () => {
    await expectCode(
      assertLocalFileAllowed(path.join(allowedDir, "..", "outside", "secret.html"), policy()),
      "LOCAL_FILE_NOT_ALLOWED",
    );
  });

  it("rejects a different drive root even when listed as allowed", async () => {
    await expectCode(
      assertLocalFileAllowed(path.join(outsideDir, "secret.html"), policy({ allowedLocalDirectories: ["Z:\\definitely-missing"] })),
      "LOCAL_FILE_NOT_ALLOWED",
    );
  });

  it("blocks symlink escapes because containment is checked after realpath", async (ctx) => {
    const escapeLink = path.join(allowedDir, "escape.html");
    try {
      await symlink(path.join(outsideDir, "secret.html"), escapeLink, "file");
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EPERM" || code === "EACCES") {
        ctx.skip(); // Windows without developer mode/admin cannot create file symlinks.
        return;
      }
      throw error;
    }
    await expectCode(assertLocalFileAllowed(escapeLink, policy()), "LOCAL_FILE_NOT_ALLOWED");
  });

  it("blocks directory junction escapes", async () => {
    const junction = path.join(allowedDir, "linked");
    await symlink(outsideDir, junction, "junction");
    await expectCode(assertLocalFileAllowed(path.join(junction, "secret.html"), policy()), "LOCAL_FILE_NOT_ALLOWED");
  });
});
