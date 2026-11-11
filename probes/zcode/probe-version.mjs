// probes/zcode/probe-version.mjs — 零成本：验证 ZCode CLI 版本与 app-server 入口
//
// 用法：
//   node probes/zcode/probe-version.mjs [--json] [--timeout ms]
//
// 只运行：
//   ZCode.exe zcode.cjs --version
//   ZCode.exe zcode.cjs --help
//
// 不启动 app-server、不打开 TUI/GUI、不调用模型。
// --help 只输出非敏感摘要（命令是否存在、关键参数是否存在），不整段回显。

import { DEFAULT_CLI, DEFAULT_EXE, redact, spawnFile } from './lib.mjs';

const args = process.argv.slice(2);
const opt = { json: false, timeoutMs: 20000 };
for (let i = 0; i < args.length; i += 1) {
  const a = args[i];
  if (a === '--json') opt.json = true;
  else if (a === '--timeout') opt.timeoutMs = Number(args[++i]) || opt.timeoutMs;
  else if (a === '-h' || a === '--help') {
    console.log('用法: probe-version.mjs [--json] [--timeout ms]');
    process.exit(0);
  } else {
    console.error(`未知参数：${a}`);
    process.exit(2);
  }
}

const FLAGS = [
  '--version',
  '--help',
  '--surface',
  '--cwd',
  '--resume',
  '--prompt',
  '--json',
  '--mode',
];

function summarizeHelp(text) {
  const hasAppServer = /^\s{2}app-server\b/m.test(text);
  const flags = Object.fromEntries(FLAGS.map((f) => [f, text.includes(f)]));
  const surfaces = [];
  if (/terminal/.test(text)) surfaces.push('terminal');
  if (/desktop/.test(text)) surfaces.push('desktop');
  const commandLines = text
    .split(/\r?\n/)
    .filter((line) => /^\s{2}[a-z][\w-]*\b/.test(line) && !line.trim().startsWith('-'))
    .map((line) => line.trim().split(/\s+/)[0])
    .filter((name) => /^[a-z][\w-]*$/.test(name));
  return {
    hasAppServer,
    flags,
    surfaces,
    commands: [...new Set(commandLines)],
  };
}

const versionRun = await spawnFile(DEFAULT_EXE, [DEFAULT_CLI, '--version'], {
  timeoutMs: opt.timeoutMs,
});
const versionText = versionRun.stdout.trim();
const versionMatch = versionText.match(/(\d+\.\d+\.\d+(?:[-+][\w.-]+)?)/);
const version = versionMatch ? versionMatch[1] : null;

const helpRun = await spawnFile(DEFAULT_EXE, [DEFAULT_CLI, '--help'], {
  timeoutMs: opt.timeoutMs,
});
const help = summarizeHelp(helpRun.stdout);

const checks = [
  { name: 'CLI 可执行（--version 退出码 0）', pass: versionRun.ok },
  { name: '版本号可解析', pass: !!version, detail: version },
  { name: '--help 退出码 0', pass: helpRun.ok },
  { name: 'app-server 命令存在', pass: help.hasAppServer },
  { name: '--surface 参数存在', pass: help.flags['--surface'] },
  { name: 'desktop surface 可用', pass: help.surfaces.includes('desktop') },
];
const pass = checks.every((c) => c.pass);

const report = {
  ok: pass,
  exe: DEFAULT_EXE,
  cli: DEFAULT_CLI,
  version,
  versionExit: versionRun.code,
  helpExit: helpRun.code,
  appServer: help.hasAppServer,
  surfaces: help.surfaces,
  flags: help.flags,
  commands: help.commands,
  checks,
};

if (opt.json) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log(`ZCode CLI: ${version ?? '(无法解析)'}`);
  console.log(`  可执行文件: ${DEFAULT_EXE}`);
  console.log(`  入口脚本:   ${DEFAULT_CLI}`);
  console.log(`  app-server: ${help.hasAppServer ? '存在' : '不存在'}`);
  console.log(`  --surface:  ${help.flags['--surface'] ? `存在（${help.surfaces.join(' / ') || '未识别'}）` : '不存在'}`);
  console.log(`  命令:       ${help.commands.join(', ')}`);
  console.log(`  关键参数:   ${FLAGS.filter((f) => help.flags[f]).join(' ')}`);
  console.log('');
  for (const c of checks) {
    console.log(`${c.pass ? 'PASS' : 'FAIL'}  ${c.name}${c.detail ? ` (${c.detail})` : ''}`);
  }
  if (!versionRun.ok || !helpRun.ok) {
    const detail = redact(versionRun.stderr || helpRun.stderr || versionRun.error || helpRun.error || '');
    if (detail) console.log(`\n错误摘要: ${detail.split(/\r?\n/).slice(0, 5).join(' | ')}`);
  }
}

process.exit(pass ? 0 : 1);
