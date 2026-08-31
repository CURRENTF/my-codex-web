#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export const setupSteps = [
  { label: "安装锁定依赖（包含构建和测试工具）", args: ["ci", "--include=dev", "--no-audit", "--no-fund"] },
  { label: "构建 Codex Web", args: ["run", "build"] },
  { label: "链接 codex-web 命令", args: ["link", "--no-audit", "--no-fund"] },
];

export function supportsNodeVersion(version) {
  const [major = 0, minor = 0] = version.replace(/^v/, "").split(".").map(Number);
  return major > 22 || (major === 22 && minor >= 22);
}

function npmInvocation(args) {
  const npmExecPath = process.env.npm_execpath;
  if (npmExecPath) return { command: process.execPath, args: [npmExecPath, ...args] };
  return { command: process.platform === "win32" ? "npm.cmd" : "npm", args };
}

export function runSetup() {
  if (!supportsNodeVersion(process.version)) {
    console.error(`需要 Node.js 22.22 或更高版本，当前为 ${process.version}。`);
    return 1;
  }
  for (const [index, step] of setupSteps.entries()) {
    console.log(`\n[${index + 1}/${setupSteps.length}] ${step.label}`);
    const invocation = npmInvocation(step.args);
    const result = spawnSync(invocation.command, invocation.args, { cwd: repository, env: process.env, stdio: "inherit" });
    if (result.error) {
      console.error(result.error.message);
      return 1;
    }
    if (result.status !== 0) return result.status ?? 1;
  }
  console.log("\n安装完成。运行 codex-web 即可启动。");
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = runSetup();
}
