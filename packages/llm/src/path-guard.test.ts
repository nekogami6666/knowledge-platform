import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  checkToolPathContainment,
  globStaticPrefix,
  isWithinRoot,
  type RealpathFn,
  resolveContainmentRoot,
  resolveRealPath,
} from "./path-guard.js";

/**
 * 実 FS の fixture(ADR-0037 の本番実験と同じ形):
 *   <base>/clones/repo/inside.txt           — 正規の読み取り対象
 *   <base>/clones/repo/link-in.txt          → inside.txt(cwd 内で完結する symlink)
 *   <base>/clones/repo/link-out.txt         → <base>/secret/secret.txt(cwd 外を指す symlink)
 *   <base>/clones/repo/linkdir              → <base>/secret(cwd 外ディレクトリ)
 *   <base>/clones/repo/dangling-out         → <base>/secret/missing(未存在の外部)
 *   <base>/clones-evil/x.txt                — 接頭辞一致の兄弟(/clones と /clones-evil の混同防止)
 *   <base>/secret/secret.txt                — 読まれてはならない
 *   <base>/root-link                        → <base>/clones(cwd 自体が symlink のケース)
 */
let base: string;
let cwd: string;
let root: string;
let secret: string;

beforeAll(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), "path-guard-")));
  cwd = join(base, "clones");
  secret = join(base, "secret");
  mkdirSync(join(cwd, "repo", "docs"), { recursive: true });
  mkdirSync(secret, { recursive: true });
  mkdirSync(join(base, "clones-evil"), { recursive: true });
  writeFileSync(join(cwd, "repo", "inside.txt"), "ok\n");
  writeFileSync(join(cwd, "repo", "docs", "a.md"), "ok\n");
  writeFileSync(join(secret, "secret.txt"), "secret\n");
  writeFileSync(join(base, "clones-evil", "x.txt"), "evil\n");
  symlinkSync(join(cwd, "repo", "inside.txt"), join(cwd, "repo", "link-in.txt"));
  symlinkSync(join(secret, "secret.txt"), join(cwd, "repo", "link-out.txt"));
  symlinkSync(secret, join(cwd, "repo", "linkdir"));
  symlinkSync(join(secret, "missing"), join(cwd, "repo", "dangling-out"));
  symlinkSync(cwd, join(base, "root-link"));
  root = resolveContainmentRoot(cwd);
});

afterAll(() => {
  rmSync(base, { recursive: true, force: true });
});

const check = (tool: string, input: unknown) => checkToolPathContainment(tool, input, root);
const allowed = (tool: string, input: unknown) => check(tool, input).allowed;

describe("isWithinRoot", () => {
  it("root 自身と配下は内側、接頭辞一致の兄弟は外側", () => {
    expect(isWithinRoot("/clones", "/clones")).toBe(true);
    expect(isWithinRoot("/clones", "/clones/a/b")).toBe(true);
    expect(isWithinRoot("/clones", "/clones-evil/x")).toBe(false);
    expect(isWithinRoot("/clones", "/")).toBe(false);
    expect(isWithinRoot("/clones/", "/clones/a")).toBe(true);
  });
});

describe("resolveRealPath", () => {
  it("実在パスは realpath、未存在の末尾は実在祖先の realpath に連結する", () => {
    expect(resolveRealPath(join(cwd, "repo", "inside.txt"))).toBe(join(cwd, "repo", "inside.txt"));
    expect(resolveRealPath(join(cwd, "repo", "nope", "deeper.txt"))).toBe(
      join(cwd, "repo", "nope", "deeper.txt"),
    );
    // 未存在ファイルでも祖先の symlink は解決される(外へ出る判定を失わない)。
    expect(resolveRealPath(join(cwd, "repo", "linkdir", "nope.txt"))).toBe(
      join(secret, "nope.txt"),
    );
  });

  it("ENOENT/ENOTDIR 以外の失敗(EACCES・ELOOP 等)は null(呼び出し側で拒否)", () => {
    const eacces: RealpathFn = () => {
      throw Object.assign(new Error("denied"), { code: "EACCES" });
    };
    expect(resolveRealPath("/x/y", eacces)).toBeNull();
  });
});

describe("resolveContainmentRoot", () => {
  it("cwd 自体が symlink なら実体に解決する", () => {
    expect(resolveContainmentRoot(join(base, "root-link"))).toBe(cwd);
  });
  it("未存在の cwd は lexical な絶対パスに倒す", () => {
    expect(resolveContainmentRoot(join(base, "nope"))).toBe(join(base, "nope"));
  });
});

describe("checkToolPathContainment: Read", () => {
  it("cwd 内の絶対パス・相対パス・cwd 内で完結する symlink は許可", () => {
    expect(allowed("Read", { file_path: join(cwd, "repo", "inside.txt") })).toBe(true);
    expect(allowed("Read", { file_path: "repo/inside.txt" })).toBe(true);
    expect(allowed("Read", { file_path: "./repo/docs/a.md" })).toBe(true);
    expect(allowed("Read", { file_path: join(cwd, "repo", "link-in.txt") })).toBe(true);
  });

  it("cwd 内の未存在パスは許可(読んでも ENOENT で無害)", () => {
    expect(allowed("Read", { file_path: join(cwd, "repo", "missing.md") })).toBe(true);
  });

  it("cwd 外の絶対パスは拒否(/config・/data・/proc の本番ベクタ)", () => {
    expect(allowed("Read", { file_path: join(secret, "secret.txt") })).toBe(false);
    expect(allowed("Read", { file_path: "/proc/self/environ" })).toBe(false);
    expect(allowed("Read", { file_path: "/config/ops.yaml" })).toBe(false);
    expect(allowed("Read", { file_path: "/data/bot.db" })).toBe(false);
    expect(allowed("Read", { file_path: join(base, "clones-evil", "x.txt") })).toBe(false);
  });

  it("'..' セグメントは解決結果が内側でも拒否(link/../x 型の lexical/OS 解決差を塞ぐ)", () => {
    expect(allowed("Read", { file_path: "../secret/secret.txt" })).toBe(false);
    // path.join は '..' を正規化してしまうため生文字列で組む。
    expect(allowed("Read", { file_path: `${cwd}/../secret/secret.txt` })).toBe(false);
    expect(allowed("Read", { file_path: `${cwd}/repo/../repo/inside.txt` })).toBe(false);
    expect(allowed("Read", { file_path: "repo/linkdir/../inside.txt" })).toBe(false);
  });

  it("cwd 内から外を指す symlink(ファイル/ディレクトリ/未存在ターゲット配下)は拒否", () => {
    expect(allowed("Read", { file_path: join(cwd, "repo", "link-out.txt") })).toBe(false);
    expect(allowed("Read", { file_path: join(cwd, "repo", "linkdir", "secret.txt") })).toBe(false);
    expect(allowed("Read", { file_path: "repo/linkdir/secret.txt" })).toBe(false);
    expect(allowed("Read", { file_path: join(cwd, "repo", "linkdir", "missing.txt") })).toBe(false);
  });

  it("~ 始まり・NUL・文字列でないパスは拒否(fail-closed)", () => {
    expect(allowed("Read", { file_path: "~/.ssh/id_rsa" })).toBe(false);
    expect(allowed("Read", { file_path: "~bot/.bashrc" })).toBe(false);
    expect(allowed("Read", { file_path: `${cwd}/repo/inside.txt\0` })).toBe(false);
    expect(allowed("Read", { file_path: 42 })).toBe(false);
    expect(allowed("Read", { file_path: ["/etc/passwd"] })).toBe(false);
  });

  it("拒否理由は判定対象のパスを示す(root の実体パスや内容は含めない)", () => {
    const d = check("Read", { file_path: "/config/ops.yaml" });
    expect(d.allowed).toBe(false);
    if (!d.allowed) {
      expect(d.reason).toContain("/config/ops.yaml");
      expect(d.reason).not.toContain(cwd);
    }
  });

  it("realpath の想定外失敗は拒否", () => {
    const eloop: RealpathFn = () => {
      throw Object.assign(new Error("loop"), { code: "ELOOP" });
    };
    expect(
      checkToolPathContainment("Read", { file_path: "/clones/x" }, "/clones", eloop).allowed,
    ).toBe(false);
  });
});

describe("checkToolPathContainment: Grep", () => {
  it("path 省略(= cwd)・空文字・cwd 自身・cwd 内サブディレクトリは許可", () => {
    expect(allowed("Grep", { pattern: "secret" })).toBe(true);
    expect(allowed("Grep", { pattern: "x", path: "" })).toBe(true);
    expect(allowed("Grep", { pattern: "x", path: cwd })).toBe(true);
    expect(allowed("Grep", { pattern: "x", path: "repo/docs", glob: "*.md" })).toBe(true);
  });

  it("cwd 外・symlink 経由・'..' の path は拒否", () => {
    expect(allowed("Grep", { pattern: "x", path: secret })).toBe(false);
    expect(allowed("Grep", { pattern: "x", path: "/" })).toBe(false);
    expect(allowed("Grep", { pattern: "x", path: join(cwd, "repo", "linkdir") })).toBe(false);
    expect(allowed("Grep", { pattern: "x", path: join(cwd, "repo", "link-out.txt") })).toBe(false);
    expect(allowed("Grep", { pattern: "x", path: ".." })).toBe(false);
  });
});

describe("checkToolPathContainment: Glob", () => {
  it("相対 pattern(path 省略)・cwd 内の絶対 pattern は許可", () => {
    expect(allowed("Glob", { pattern: "**/*.md" })).toBe(true);
    expect(allowed("Glob", { pattern: "repo/docs/*.md" })).toBe(true);
    expect(allowed("Glob", { pattern: `${cwd}/repo/**/*.md` })).toBe(true);
    expect(allowed("Glob", { pattern: "*.md", path: join(cwd, "repo") })).toBe(true);
  });

  it("cwd 外を静的接頭辞に持つ絶対 pattern は拒否", () => {
    expect(allowed("Glob", { pattern: `${secret}/*` })).toBe(false);
    expect(allowed("Glob", { pattern: "/config/**/*.yaml" })).toBe(false);
    expect(allowed("Glob", { pattern: "/*" })).toBe(false); // "/" 直下の列挙も拒否
    expect(allowed("Glob", { pattern: "/proc/*/environ" })).toBe(false);
  });

  it("symlink ディレクトリ経由・'..'・~・ブレース内の絶対パスは拒否", () => {
    expect(allowed("Glob", { pattern: "repo/linkdir/*" })).toBe(false);
    expect(allowed("Glob", { pattern: "*", path: join(cwd, "repo", "linkdir") })).toBe(false);
    expect(allowed("Glob", { pattern: "../secret/*" })).toBe(false);
    expect(allowed("Glob", { pattern: "**/../../*" })).toBe(false);
    expect(allowed("Glob", { pattern: "~/.ssh/*" })).toBe(false);
    expect(allowed("Glob", { pattern: "{/config,/data}/*" })).toBe(false);
    expect(allowed("Glob", { pattern: "{repo,~}/*" })).toBe(false);
  });

  it("path が cwd 内でも pattern 側で外へ出れば拒否", () => {
    expect(allowed("Glob", { pattern: "linkdir/*", path: join(cwd, "repo") })).toBe(false);
    expect(allowed("Glob", { pattern: `${secret}/*`, path: cwd })).toBe(false);
  });
});

describe("checkToolPathContainment: 対象外ツール", () => {
  it("ファイル系以外(StructuredOutput 等)は入力に関わらず素通し(deny-only ガード)", () => {
    expect(allowed("StructuredOutput", { path: "/etc/passwd", answer: "x" })).toBe(true);
    expect(allowed("ToolSearch", { query: "x" })).toBe(true);
  });

  it("許可外のファイル系ツールも同じ境界で拒否する(設定ミスへの保険)", () => {
    expect(allowed("Write", { file_path: "/data/bot.db", content: "" })).toBe(false);
    expect(allowed("NotebookEdit", { notebook_path: "/tmp/x.ipynb" })).toBe(false);
  });

  it("入力がオブジェクトでなければ(パス無し=cwd)許可", () => {
    expect(allowed("Read", undefined)).toBe(true);
  });
});

describe("globStaticPrefix", () => {
  it("メタ文字を含むセグメントより前を返す", () => {
    expect(globStaticPrefix("/config/**/*.yaml")).toBe("/config");
    expect(globStaticPrefix("repo/docs/*.md")).toBe("repo/docs");
    expect(globStaticPrefix("**/*.md")).toBe("");
    expect(globStaticPrefix("/*")).toBe("/");
    expect(globStaticPrefix("repo/inside.txt")).toBe("repo/inside.txt");
  });
});
