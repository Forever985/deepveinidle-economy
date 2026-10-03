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

/** 跑 git，失败就把输出打出来并退出 —— 绝不「看起来成功」 */
function git(args, cwd) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf-8', shell: true })
  if (r.status !== 0) {
    process.stdout.write(r.stdout || '')
    process.stderr.write(r.stderr || '')
    process.exit(r.status || 1)
  }
  return (r.stdout || '').trim()
}

const tmp = mkdtempSync(join(tmpdir(), 'dvi-gh-pages-'))
const hasBranch = (() => {
  const r = spawnSync('git', ['ls-remote', '--heads', REPO, BRANCH], { encoding: 'utf-8', shell: true })
  return r.status === 0 && (r.stdout || '').trim().length > 0
})()

if (hasBranch) {
  console.log(`克隆已有 ${BRANCH} 分支 ...`)
  git(['clone', '--branch', BRANCH, '--single-branch', '--depth', '1', REPO, tmp], process.cwd())
} else {
  console.log(`${BRANCH} 分支不存在，新建 ...`)
  mkdirSync(tmp, { recursive: true })
  git(['init', '-q'], tmp)
  git(['remote', 'add', 'origin', REPO], tmp)
  git(['checkout', '-q', '--orphan', BRANCH], tmp)
}

git(['rm', '-rq', '--cached', '.'], tmp)
git(['rm', '-rfq', '.'], tmp)

console.log(`拷贝构建产物 ...`)
cpSync(DIR, tmp, { recursive: true })

git(['add', '-A'], tmp)
git(['commit', '-q', '-m', `deploy: ${new Date().toISOString()}`], tmp)

console.log(`推送到 ${BRANCH} ...`)
git(['push', 'origin', BRANCH], tmp)

rmSync(tmp, { recursive: true, force: true })
console.log('PUBLISH_OK')
