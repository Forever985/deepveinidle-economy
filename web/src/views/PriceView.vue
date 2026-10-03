<script setup lang="ts">
import { t } from '../i18n'
import { diagnoseHandle } from '../lib/handleStore'
import type { HandleDiag } from '../lib/handleStore'
import { computed, onMounted, onUnmounted, ref } from 'vue'
import type { GameData } from '../types'
import type { PriceBook } from '../calc/price'
import {
  priceState, supportsFileApi, connectPriceFile, readPriceFile, handleFiles,
  applyPasted, clearAll, loadCache, autoReconnect, isFileConnected,
  grantAndRead, disconnect, receipt,
} from '../stores/market'

const props = defineProps<{ data: GameData; book: PriceBook }>()

const msg = ref('')
const pasteText = ref('')
const showPaste = ref(false)
const diag = ref<HandleDiag | null>(null)
const diagBusy = ref(false)
const dragOver = ref(false)

onMounted(() => {
  if (!Object.keys(priceState.market).length) loadCache()
  void autoReconnect()
  window.addEventListener('dragover', onDragOver)
  window.addEventListener('drop', onDrop)
})
onUnmounted(() => {
  window.removeEventListener('dragover', onDragOver)
  window.removeEventListener('drop', onDrop)
})

function onDragOver(e: DragEvent) {
  if (!e.dataTransfer?.types.includes('Files')) return
  e.preventDefault()
  dragOver.value = true
}
function onDrop(e: DragEvent) {
  if (!e.dataTransfer?.files?.length) return
  e.preventDefault()
  dragOver.value = false
  const r = handleFiles(e.dataTransfer.files)
  msg.value = r.msg
  if (r.ok) setTimeout(() => { msg.value = `已载入 ${Object.keys(priceState.market).length} 个物品` }, 200)
}

async function doConnect() {
  const r = await connectPriceFile()
  msg.value = r.msg
}
async function doRead() {
  const r = await readPriceFile()
  msg.value = r.msg
}
/** 诊断结果的可读文案（放 script 里算，模板保持干净） */
const PERM_LABEL: Record<string, string> = {
  granted: '已授权', denied: '被拒绝', prompt: '需点一下确认',
}
const permLabel = computed(() => {
  const p = diag.value?.permission
  return p ? (PERM_LABEL[p] || p) : '—'
})
const readLabel = computed(() => {
  const d = diag.value
  if (!d) return '—'
  if (!d.stored) return '—'
  if (d.canRead) return `是（${d.count} 个物品）`
  return '否'
})

async function runDiag() {
  diagBusy.value = true
  diag.value = await diagnoseHandle()
  diagBusy.value = false
}

async function doGrant() {
  const r = await grantAndRead()
  msg.value = r.msg
}
async function doDisconnect() {
  await disconnect()
  msg.value = '已断开（下次打开需要重新选一次文件）'
}
function doClear() {
  clearAll()
  msg.value = '已清空本机价格数据（游戏快照文件不受影响）'
}
function doPaste() {
  const r = applyPasted(pasteText.value)
  msg.value = r.msg
  if (r.ok) { pasteText.value = ''; showPaste.value = false }
}

/* ── 统计 ── */
const stats = computed(() => {
  let withAsk = 0, withBid = 0, withBoth = 0, totalQty = 0
  for (const m of Object.values(priceState.market)) {
    if (m.ask) { withAsk++; totalQty += m.ask.qty || 0 }
    if (m.bid) withBid++
    if (m.ask && m.bid) withBoth++
  }
  return { n: Object.keys(priceState.market).length, withAsk, withBid, withBoth, totalQty }
})

/** 覆盖率：全站有多少物品因此有了市场价 */
const coverage = computed(() => {
  const total = props.data.items.length
  return { have: stats.value.n, total, pct: total ? (stats.value.n / total * 100) : 0 }
})

const when = computed(() => (priceState.at ? new Date(priceState.at).toLocaleString('zh-CN') : '—'))
const originLabel = computed(() => ({
  file: '本机文件', drop: '拖入文件', paste: '粘贴', cache: '本机缓存', none: '无数据',
}[priceState.origin]))

/** 价差最大的几个 —— 价差大但要看挂单量，量少的实际卖不掉 */
const spreads = computed(() => {
  const rows: { id: number; name: string; ask: number; bid: number; pct: number; qty: number }[] = []
  for (const [id, m] of Object.entries(priceState.market)) {
    if (!m.ask || !m.bid || m.bid.price <= 0) continue
    const pct = (m.ask.price - m.bid.price) / m.bid.price * 100
    rows.push({
      id: Number(id), name: props.book.itemName(Number(id)),
      ask: m.ask.price, bid: m.bid.price, pct,
      qty: Math.min(m.ask.qty || 0, m.bid.qty || 0),
    })
  }
  return rows.sort((a, b) => b.pct - a.pct).slice(0, 40)
})
</script>

<template>
  <div class="view" :class="{ dragging: dragOver }">
    <div class="vhead">
      <h2>价格</h2>
      <p>
        DVI 没有公开的价格接口，价格只存在于游戏内。
        这里用<b>本机文件</b>做桥：dvi-tools 写 <code>dvi-prices.json</code>，
        本站读<b>同一个文件</b> —— 数据闭环全在你自己的电脑上，不经过 GitHub。
      </p>
    </div>

    <!-- 数据来源：可核对的一手信息 -->
    <div class="card src-card">
      <h3>数据来源</h3>
      <div class="src-grid">
        <div class="src-row">
          <span>正在使用</span>
          <b :class="stats.n ? 'ok' : 'bad'">{{ stats.n ? '真实市场行情' : '兜底价（游戏内置价值）' }}</b>
        </div>
        <div class="src-row"><span>物品数</span><b>{{ stats.n }}</b></div>
        <div class="src-row"><span>数据指纹</span>
          <b class="mono">{{ priceState.fingerprint || '—' }}</b>
          <span class="tip" title="和游戏里「🔏 查看送出凭证」显示的指纹对比。两串一致 = 你在游戏里送出的数据，一字节不差地在这里被使用着。">?</span>
        </div>
        <div class="src-row"><span>快照时间</span><b>{{ when }}</b></div>
        <div class="src-row"><span>送达方式</span><b>{{ originLabel }}</b></div>
      </div>
      <p v-if="stats.n" class="tip2">
        核对方法：游戏里打开油猴菜单 →「🔏 查看送出凭证」，
        把那里的<b>指纹</b>和上面这一行对比。<b>一致</b>就证明本站正在用的就是你送出的那份数据。
      </p>

      <p v-else class="tip2">
        当前所有价格都是游戏内置的基础价值，<b>不是市场真实价格</b>，利润排序仅供参考。
        想用真实行情：游戏里点「📤 送到利润网站」。
      </p>

      <!-- 收货回执：逐环节显示，直接看出卡在哪一环 -->
      <div class="rcpt">
        <div class="rcpt-t">收货回执（本次打开网站时）</div>
        <div class="rcpt-row"><span>网址里带数据了吗</span>
          <b :class="receipt.hadHash ? 'ok' : 'no'">{{ receipt.hadHash ? `是（网址片段 ${receipt.hashLen} 字符）` : '否 —— 是直接打开网站的，没有带数据' }}</b></div>
        <div class="rcpt-row"><span>解开了吗</span>
          <b :class="receipt.parsed ? 'ok' : 'no'">{{ receipt.parsed ? `是（耗时 ${receipt.ms} ms）` : (receipt.hadHash ? '否' : '—') }}</b></div>
        <div class="rcpt-row"><span>入库了吗</span>
          <b :class="receipt.applied ? 'ok' : 'no'">{{ receipt.applied ? `是（${receipt.count} 个物品）` : '否' }}</b></div>
        <div v-if="receipt.error" class="rcpt-row"><span>错误</span><b class="bad">{{ receipt.error }}</b></div>
        <p class="tip2" style="margin-top:6px">
          若是「网址里带数据了吗 = 否」，说明<b>游戏那边的「送到利润网站」没成功打开新标签</b> ——
          可能是浏览器拦了弹窗，或网址太长被截断。
        </p>
      </div>
    </div>

    <!-- 状态 -->
    <div class="stats">
      <div><div class="k">物品数</div><div class="v">{{ stats.n }}</div></div>
      <div><div class="k">有卖价</div><div class="v">{{ stats.withAsk }}</div></div>
      <div><div class="k">有收购价</div><div class="v">{{ stats.withBid }}</div></div>
      <div><div class="k">覆盖全站</div><div class="v">{{ coverage.pct.toFixed(0) }}%</div></div>
      <div><div class="k">来源</div><div class="v" style="font-size:13px">{{ originLabel }}</div></div>
    </div>

    <div class="note" :class="{ warn: !stats.n }">
      <template v-if="stats.n">
        快照时间 <b>{{ when }}</b> · 来源 <b>{{ originLabel }}</b>
        <span v-if="priceState.lastRead"> · 本次读取 {{ new Date(priceState.lastRead).toLocaleTimeString('zh-CN') }}</span>
        <div style="margin-top:4px;font-size:12px;color:var(--fg3)">
          成本按 ask、收益按 bid 的保守口径计算；界面上每个数字旁的圆点标明它来自市场、兜底还是手动。
        </div>
      </template>
      <template v-else>
        <b>还没有任何价格数据</b>，当前全部使用兜底价（物品基础价值）。
        <div style="margin-top:4px;font-size:12px">
          在游戏里打开油猴菜单 → <b>「🔗 连接价格文件」</b>选一个位置保存，
          之后每次刷新页面与每小时都会自动写入；本站点下面的「连接」选同一个文件即可。
        </div>
      </template>
    </div>

    <!-- 需要一次点击授权：浏览器硬性要求用户手势，无法自动完成 -->
    <div v-if="priceState.needsGesture" class="note warn bar-fix">
      <div>
        浏览器需要你<b>点一下</b>才允许继续读取 <code>{{ priceState.fileName }}</code>。
        这是浏览器规定的安全机制，无法自动完成 —— 但<b>只需要这一次</b>，
        之后每次打开都会自动读取。
      </div>
      <div style="margin-top:6px;display:flex;gap:6px">
        <button class="primary" @click="doGrant">点一下继续（只此一次）</button>
        <button @click="doDisconnect">断开</button>
      </div>
    </div>

    <!-- 已记住文件：明确告诉用户「以后不用再弄了」 -->
    <div v-else-if="priceState.fileRemembered && priceState.fileConnected" class="note ok-note">
      ✓ 已记住 <code>{{ priceState.fileName }}</code>，
      <b>以后每次打开自动读取，不用再做任何操作</b>。关掉浏览器、重启电脑都不影响。
    </div>

    <!-- 三个入口 -->
    <div class="card">
      <h3>接入方式</h3>
      <div class="entries">
        <div class="entry">
          <div class="t">① 连接本机文件<span class="badge" v-if="supportsFileApi">推荐</span></div>
          <p>选一次 <code>dvi-prices.json</code>，之后每次打开本站自动重读。</p>
          <div class="acts">
            <button class="primary" @click="doConnect">连接价格文件</button>
            <button v-if="isFileConnected()" @click="doRead">立即重读</button>
            <button v-if="priceState.fileConnected" @click="doDisconnect">断开</button>
            <span v-if="priceState.fileConnected" class="muted">
              已连接：{{ priceState.fileName }}（{{ priceState.fileRemembered ? '已记住，永久有效' : '本次会话' }}）
            </span>
          </div>
          <p v-if="!supportsFileApi" class="muted">
            这个浏览器不支持 File System Access API，请用下面的拖放或粘贴。
          </p>
        </div>

        <div class="entry">
          <div class="t">② 拖放文件</div>
          <p>把 dvi-tools 下载的 json <b>直接拖到页面任意位置</b>。</p>
          <div class="acts"><span class="muted">无需任何授权</span></div>
        </div>

        <div class="entry">
          <div class="t">③ 粘贴 JSON</div>
          <p>把快照内容贴进文本框。</p>
          <div class="acts">
            <button v-if="!showPaste" @click="showPaste = true">打开输入框</button>
            <template v-else>
              <button class="primary" @click="doPaste">载入</button>
              <button @click="showPaste = false; pasteText = ''">取消</button>
            </template>
          </div>
          <textarea v-if="showPaste" v-model="pasteText" rows="4"
            placeholder='{"at":"...","market":{"1":{"a":{"p":3,"q":10}}}}'
            style="margin-top:6px;width:100%;font-family:var(--mono);font-size:12px;
                   border:1px solid var(--line);border-radius:6px;padding:6px"></textarea>
        </div>
      </div>

      <div v-if="msg" class="msg">{{ msg }}</div>
      <div v-if="priceState.error" class="msg err">{{ priceState.error }}</div>

      <div style="margin-top:10px;display:flex;gap:6px;flex-wrap:wrap">
        <button @click="runDiag" :disabled="diagBusy">{{ diagBusy ? '诊断中…' : '🔍 连接诊断' }}</button>
        <button @click="doClear">清空本机价格数据</button>
      </div>

      <!-- 诊断：把「为什么没连上」摆到台面上 -->
      <div v-if="diag" class="diag">
        <div class="diag-t">连接诊断</div>
        <div class="kv"><span>浏览器支持文件选择器</span>
          <span :class="diag.apiSupported ? 'ok' : 'bad'">{{ diag.apiSupported ? '是' : '否' }}</span></div>
        <div class="kv"><span>已记住文件句柄</span>
          <span :class="diag.stored ? 'ok' : 'no'">{{ diag.stored ? '是' : '否' }}</span></div>
        <div class="kv"><span>句柄方法完好</span>
          <span :class="diag.methodsOk ? 'ok' : (diag.stored ? 'bad' : 'no')">
            {{ diag.stored ? (diag.methodsOk ? '是' : '否') : '—' }}</span></div>
        <div class="kv"><span>读取权限</span>
          <span :class="diag.permission === 'granted' ? 'ok' : (diag.permission ? 'bad' : 'no')">
            {{ permLabel }}</span></div>
        <div class="kv"><span>能读到文件</span>
          <span :class="diag.canRead ? 'ok' : (diag.stored ? 'bad' : 'no')">{{ readLabel }}</span></div>
        <div class="kv"><span>本机缓存（localStorage）</span>
          <span :class="stats.n ? 'ok' : 'no'">{{ stats.n }} 个物品{{ priceState.at ? ' · ' + new Date(priceState.at).toLocaleString('zh-CN') : '' }}</span></div>
        <div v-if="diag.error" class="kv"><span>错误</span><span class="bad">{{ diag.error }}</span></div>
        <p v-if="!diag.stored" class="hint" style="margin:6px 0 0">
          说明还没绑定过 —— 点上面的「连接本机文件」选一次 dvi-prices.json 即可。
        </p>
      </div>
    </div>

    <!-- 价差 -->
    <div v-if="spreads.length" class="card">
      <h3>买卖价差最大的物品</h3>
      <p class="hint">
        价差大看着诱人，但<b>可成交量</b>才是关键 ——
        挂单量只有 1 的物品，价差再大也卖不掉一单。
      </p>
      <div class="tw">
        <table>
          <thead>
            <tr><th class="l">物品</th><th>卖价 ask</th><th>收购价 bid</th><th>价差</th><th>可成交量</th></tr>
          </thead>
          <tbody>
            <tr v-for="s in spreads" :key="s.id">
              <td class="l">{{ t(s.name) }}</td>
              <td class="num">{{ s.ask }}</td>
              <td class="num">{{ s.bid }}</td>
              <td class="num pos">{{ s.pct.toFixed(1) }}%</td>
              <td class="num" :class="s.qty === 0 ? 'neg' : ''">{{ s.qty }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  </div>
</template>

<style scoped>
.hint{font-size:12px;color:var(--fg2);margin:2px 0 8px}
code{font-family:var(--mono);background:#eceff3;padding:1px 4px;border-radius:3px}
.muted{font-size:12px;color:var(--fg3)}
.entries{display:grid;grid-template-columns:repeat(auto-fit,minmax(250px,1fr));gap:12px}
.entry{border:1px solid var(--line2);border-radius:8px;padding:10px 12px;background:#fbfcfd}
.entry .t{font-weight:600;font-size:13px;display:flex;align-items:center;gap:6px}
.entry p{font-size:12px;color:var(--fg2);margin:4px 0 8px}
.entry .acts{display:flex;gap:6px;align-items:center;flex-wrap:wrap}
.badge{font-size:10px;background:var(--accent-soft);color:var(--accent);padding:1px 5px;border-radius:3px}
.msg{margin-top:8px;font-size:12.5px;color:var(--up)}
.msg.err{color:var(--warn)}
.tw{max-height:420px;overflow:auto;border:1px solid var(--line);border-radius:7px}
.src-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:6px 16px}
.src-row{display:flex;align-items:center;gap:8px;font-size:12.5px}
.src-row>span:first-child{color:var(--fg3);min-width:56px}
.src-row b{font-weight:600}
.src-row b.ok{color:var(--up)} .src-row b.bad{color:var(--warn)}
.mono{font-family:var(--mono);letter-spacing:1px}
.tip{display:inline-flex;align-items:center;justify-content:center;width:14px;height:14px;
     border-radius:50%;background:var(--line2);color:var(--fg3);font-size:10px;cursor:help}
.tip2{font-size:12px;color:var(--fg2);margin:9px 0 0;line-height:1.6}
.rcpt{margin-top:11px;padding-top:10px;border-top:1px dashed var(--line2)}
.rcpt-t{font-size:12px;font-weight:600;margin-bottom:5px;color:var(--fg2)}
.rcpt-row{display:flex;justify-content:space-between;gap:12px;font-size:12.5px;padding:1px 0}
.rcpt-row>span:first-child{color:var(--fg3);white-space:nowrap}
.rcpt-row b{text-align:right;font-weight:600}
.rcpt-row b.ok{color:var(--up)} .rcpt-row b.bad{color:var(--warn)} .rcpt-row b.no{color:var(--fg3)}
.diag{margin-top:10px;border:1px solid var(--line);border-radius:7px;padding:9px 11px;background:#fbfcfd}
.diag-t{font-size:12.5px;font-weight:600;margin-bottom:5px}
.diag .kv{display:flex;justify-content:space-between;font-size:12.5px;padding:1px 0}
.diag .ok{color:var(--up)}
.diag .bad{color:var(--warn)}
.diag .no{color:var(--fg3)}
.ok-note{border-left-color:var(--up);background:#f0f8f2}
.bar-fix{display:flex;flex-direction:column;gap:6px}
.view.dragging{outline:3px dashed var(--accent);outline-offset:-6px;background:var(--accent-soft)}
</style>
