/**
 * 把构建产物发布到 gh-pages 分支。
 *
 * 为什么自己写而不用 `npx gh-pages`：
 *   ① npx 要联网拉包 —— 本机网络受限，且部署时多一个失败点
 *   ② npx gh-pages 默认 CLEAN=true 会**清空整条分支**。
 *      对本项目来说 gh-pages 上只有构建产物，清空是对的；
 *      但一旦以后往 gh-pages 放需要长期保留的东西（数据快照等），
 *      一次部署就会把它冲掉Milkonomy 就吃过这个亏。
 *   所以这里显式实现「先删后拷」，行为可控。
 *
 * 用法：
 *   node scripts/publish-gh-pages.mjs --dir web/dist --repo <仓库地址>
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, cpSync, rmSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

function arg(name, fallback) {
  const i = process.argv.indexOf('--' + name)
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback
}

const DIR = resolve(arg('dir', 'web/dist'))
const REPO = arg('repo', '')
const BRANCH = arg('branch', 'gh-pages')

if (!REPO) {
  console.error('缺少 --repo 参数')
  process.exit(1)
}
if (!existsSync(join(DIR, 'index.html'))) {
  console.error(`构建产物不存在或缺少 index.html：${DIR}`)
  process.exit(1)
}

/**
 * 定位 git 可执行文件。
 *
 * 不用 `shell: true` 跑 git —— 那会经过 cmd.exe，
 * 而在有些环境（沙箱、受限终端）里**派生 cmd.exe 会直接 EBUSY**。
 * 直接 spawn git.exe 既绕开这个问题，也免掉 shell 带来的参数转义风险。
 */
function findGit() {
  if (process.env.GIT_BIN && existsSync(process.env.GIT_BIN)) return process.env.GIT_BIN
  const r = spawnSync('git', ['--version'], { encoding: 'utf-8' })
  if (r.status === 0) return 'git'                      // PATH 里就有
  // 常见安装位置兜底（Git for Windows / nvm4w / 环境自带）
  const guesses = [
    'C:/Program Files/Git/cmd/git.exe',
    'C:/Program Files/Git/bin/git.exe',
    'C:/Program Files (x86)/Git/cmd/git.exe',
  ]
  for (const g of guesses) if (existsSync(g)) return g
  return 'git'   // 交给下面报错
}

const GIT = findGit()

/** 跑 git，失败就把「是哪条命令」和输出一起打出来 —— 绝不静默退出 */
function git(args, cwd) {
  const r = spawnSync(GIT, args, { cwd, encoding: 'utf-8' })
  if (r.error) {
    console.error(`\nGIT_FAIL: 无法执行 ${GIT} —— ${r.error.message}`)
    process.exit(1)
  }
  if (r.status !== 0) {
    console.error(`\nGIT_FAIL: ${GIT} ${args.join(' ')}   (cwd=${cwd})`)
    if (r.stdout) process.stderr.write(r.stdout)
    if (r.stderr) process.stderr.write(r.stderr)
    process.exit(r.status || 1)
  }
  return (r.stdout || '').trim()
}

const tmp = mkdtempSync(join(tmpdir(), 'dvi-gh-pages-'))
const hasBranch = (() => {
  const r = spawnSync(GIT, ['ls-remote', '--heads', REPO, BRANCH], { encoding: 'utf-8' })
  return r.status === 0 && (r.stdout || '').trim().length > 0
})()

if (hasBranch) {
  console.log(`克隆已有 ${BRANCH} 分支 ...`)
  git(['clone', '--branch', BRANCH, '--single-branch', '--depth', '1', REPO, tmp], process.cwd())
  // 已有提交 → 先清空工作区与索引，再拷入新产物
  git(['rm', '-rq', '--cached', '.'], tmp)
  git(['rm', '-rfq', '--ignore-unmatch', '.'], tmp)
} else {
  console.log(`${BRANCH} 分支不存在，新建 ...`)
  mkdirSync(tmp, { recursive: true })
  git(['init', '-q'], tmp)
  git(['remote', 'add', 'origin', REPO], tmp)
  git(['checkout', '-q', '--orphan', BRANCH], tmp)
  // 新建分支时仓库还没有任何提交，**不能**跑 git rm ——
  // 它会报 "pathspec '.' did not match any files" 并返回非零。
  // 工作区本来就是空的，没什么可清的。
}

console.log(`拷贝构建产物 ...`)
cpSync(DIR, tmp, { recursive: true })

git(['add', '-A'], tmp)
git(['commit', '-q', '-m', `deploy: ${new Date().toISOString()}`], tmp)

console.log(`推送到 ${BRANCH} ...`)
git(['push', 'origin', BRANCH], tmp)

rmSync(tmp, { recursive: true, force: true })
console.log('PUBLISH_OK')
