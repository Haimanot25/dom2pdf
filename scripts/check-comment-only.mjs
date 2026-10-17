// Verifies that working-tree edits to source files are comment-only.
// For each modified .ts/.mjs file it compares the TypeScript AST of the
// HEAD version with the working-tree version, printed without comments:
// any code change (including string literals) makes the printed ASTs differ.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import ts from "typescript";

const files = execFileSync("git", ["diff", "--name-only", "HEAD", "--", "*.ts", "*.mjs"], {
  encoding: "utf8",
})
  .trim()
  .split("\n")
  .filter(Boolean);

if (files.length === 0) {
  console.log("no modified .ts/.mjs files");
  process.exit(0);
}

const printed = (path, text) => {
  const kind = path.endsWith(".mjs") ? ts.ScriptKind.JS : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, kind);
  return ts.createPrinter({ removeComments: true }).printFile(sf);
};

let offenders = 0;
for (const file of files) {
  const head = execFileSync("git", ["show", `HEAD:${file}`], { encoding: "utf8" });
  const work = readFileSync(file, "utf8");
  if (printed(file, head) !== printed(file, work)) {
    console.log(`CODE CHANGED (not comment-only): ${file}`);
    offenders += 1;
  }
}

if (offenders > 0) {
  console.log(`${offenders} file(s) contain code changes — review required`);
  process.exit(1);
}
console.log(`ok: ${files.length} modified file(s), all comment-only`);
