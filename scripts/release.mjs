#!/usr/bin/env node
/**
 * 一条命令发版：检查 → 升版本 + 提交 + 打 tag → 推 GitHub，剩下的交给 CI。
 *
 * 用法：
 *   npm run release patch        # 0.3.1 -> 0.3.2
 *   npm run release minor|major
 *   npm run release 0.4.0        # 指定版本
 *   npm run release patch -- --dry-run       # 只检查、只打印将执行的命令
 *   npm run release patch -- --local-publish # 兜底：本机直接 npm publish（需要 ~/.npmrc 里的直发 token）
 *
 * 默认路径走 Trusted Publishing：推送 v* tag → .github/workflows/publish.yml
 * 用 OIDC 发 npm 并建 Release，本机不保存可直发的 token。
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import process from 'node:process';

const args = process.argv.slice(2);
const flags = new Set(args.filter((a) => a.startsWith('--')));
const positional = args.filter((a) => !a.startsWith('--'));
const bump = positional[0] || 'patch';
const dryRun = flags.has('--dry-run');
const skipRelease = flags.has('--no-release');
const localPublish = flags.has('--local-publish');
const pkgPath = new URL('../package.json', import.meta.url);

/** 跑一条命令并把输出透传给用户；失败直接退出，不吞错误。 */
function run(command, commandArgs, options = {}) {
  const shown = [command, ...commandArgs].join(' ');
  console.log(dryRun && !options.readOnly ? '  [dry-run] ' + shown : '  $ ' + shown);
  if (dryRun && !options.readOnly) return '';
  return execFileSync(command, commandArgs, {
    encoding: 'utf8',
    stdio: options.capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
  });
}

/** git 输出，永远捕获，避免污染日志。 */
function git(...gitArgs) {
  return execFileSync('git', gitArgs, { encoding: 'utf8' }).trim();
}

function fail(message) {
  console.error('\n✗ ' + message);
  process.exit(1);
}

/** 把 patch/minor/major 或显式版本号换算成下一个版本。 */
function nextVersion(current, input) {
  if (/^\d+\.\d+\.\d+/.test(input)) return input;
  const [major, minor, patch] = current.split('.').map((piece) => Number.parseInt(piece, 10));
  if (input === 'major') return (major + 1) + '.0.0';
  if (input === 'minor') return major + '.' + (minor + 1) + '.0';
  if (input === 'patch') return major + '.' + minor + '.' + (patch + 1);
  fail('版本参数只能是 patch / minor / major / x.y.z，收到：' + input);
  return '';
}

const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
const version = nextVersion(pkg.version, bump);
const tag = 'v' + version;

console.log('发布 dsh-session-smart-rename ' + pkg.version + ' -> ' + version + (dryRun ? '（dry-run）' : ''));

// 1. 仓库状态：干净、main、与远端同步
if (git('status', '--porcelain') !== '') fail('工作区不干净，先提交或 stash（想强行发布加 --dry-run 看看会做什么）');
const branch = git('rev-parse', '--abbrev-ref', 'HEAD');
if (branch !== 'main') fail('当前分支是 ' + branch + '，发布请在 main 上');
if (!dryRun) run('git', ['fetch', 'origin', '--tags']);
const ahead = git('rev-list', '--count', 'origin/main..HEAD');
const behind = git('rev-list', '--count', 'HEAD..origin/main');
if (ahead !== '0' || behind !== '0') fail('本地与 origin/main 不同步（ahead ' + ahead + ' / behind ' + behind + '），先 push 或 pull');
if (git('tag', '--list', tag) !== '') fail('tag ' + tag + ' 已存在');

// 2. 本地检查（和 AGENTS.md 的验证流程一致）
console.log('\n[1/5] 静态检查 + 冒烟');
run('node', ['--check', 'index.js'], { readOnly: true });
run('node', ['--check', 'client.js'], { readOnly: true });
run('node', ['smoke.mjs'], { readOnly: true });

// 3. 版本号 + 提交 + tag（npm version 会一起做掉，tag 消息用同一个）
console.log('\n[2/5] 升版本并打 tag');
run('npm', ['version', version, '-m', 'release: ' + tag]);

// 4. 推分支和 tag
console.log('\n[3/5] 推 GitHub');
run('git', ['push', 'origin', 'main', '--follow-tags']);

if (localPublish) {
  // 兜底路径：本机直发（依赖 ~/.npmrc 里可直发的 token，2027-01 起 npm 会停掉这种权限）
  console.log('\n[4/5] 本机发 npm（--local-publish）');
  run('npm', ['publish', '--access', 'public']);

  console.log('\n[5/5] 建 GitHub Release');
  if (skipRelease) {
    console.log('  （--no-release，跳过）');
  } else if (dryRun || which('gh')) {
    run('gh', ['release', 'create', tag, '--title', tag, '--generate-notes', '--verify-tag']);
  } else {
    console.log('  未安装 gh，跳过（之后可手动 gh release create ' + tag + ' --generate-notes）');
  }

  console.log('\n✓ ' + tag + ' 已发布：git + npm' + (skipRelease ? '' : ' + Release'));
  console.log('  验证：npm view ' + pkg.name + ' version');
  process.exit(0);
}

// 默认路径：CI 接手（.github/workflows/publish.yml，trusted publishing + Release）
console.log('\n[4/5] 等 CI 发 npm（trusted publishing）');
if (dryRun) {
  console.log('  [dry-run] gh run watch $(gh run list --workflow publish.yml --limit 1 --json databaseId -q \'.[0].databaseId\')');
} else if (which('gh')) {
  console.log('  已推送，CI 正在发布。跟进度：gh run watch $(gh run list --workflow publish.yml --limit 1 --json databaseId -q \'.[0].databaseId\')');
} else {
  console.log('  已推送，CI 正在发布。看进度：https://github.com/' + repoSlug() + '/actions');
}

console.log('\n✓ ' + tag + ' 已推送到 GitHub，npm 由 CI 发布');
console.log('  验证：npm view ' + pkg.name + ' version   /   gh release view ' + tag);

/** 从 package.json 的 repository.url 取出 owner/repo，用于打印 Actions 链接。 */
function repoSlug() {
  const url = String(pkg.repository?.url || '');
  const match = url.match(/github\.com[/:]([^/]+)\/([^/.]+)/);
  return match ? match[1] + '/' + match[2] : 'SonettoGu14/dsh-session-smart-rename';
}

/** 命令是否存在于 PATH。 */
function which(command) {
  try {
    execFileSync('sh', ['-c', 'command -v ' + command], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}
