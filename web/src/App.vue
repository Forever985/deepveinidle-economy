<script setup lang="ts">
import { computed, onMounted, ref, shallowRef, watch } from 'vue'
import { loadGameData, skillList, skillLabel } from './api/gamedata.ts'
import { PriceBook } from './calc/price.ts'
import { StepCalc } from './calc/steps.ts'
import { ChainCalc } from './calc/chain.ts'
import { Rank, SORTS, type Row, type SortKey } from './calc/rank.ts'
import { settings, calcOptions, resetSettings } from './stores/settings.ts'
import { loadPrices, priceState } from './stores/prices.ts'
import { player } from './stores/player.ts'
import { isPristine } from './calc/player.ts'
import type { GameData } from './types.ts'
import { VIEWS, useView } from './router.ts'
import DashboardView from './views/DashboardView.vue'
import EnhanceView from './views/EnhanceView.vue'
import CombatView from './views/CombatView.vue'
import ConsumableView from './views/ConsumableView.vue'
import DocsView from './views/DocsView.vue'
import ChainPanel from './components/ChainView.vue'
import PriceManager from './components/PriceManager.vue'

const data = shallowRef<GameData | null>(null)
const err = ref('')
const loading = ref(true)
const book = shallowRef<PriceBook | null>(null)
const rank = shallowRef<Rank | null>(null)
const selected = ref<Row | null>(null)
const sortDesc = ref(true)
const { current, go } = useView()

onMounted(async () => {
  loadPrices()
  try {
    const d = await loadGameData()
    data.value = d
    const b = new PriceBook(d)
    b.loadManual(priceState.manual)
    if (Object.keys(priceState.market).length) {
      b.setMarket(new Map(Object.entries(priceState.market).map(([k, v]) => [Number(k), v])))
    }
    book.value = b
    rebuild()
  } catch (e) {
    err.value = e instanceof Error ? e.message : String(e)
  } finally {
    loading.value = false
  }
})

function rebuild() {
  if (!data.value || !book.value) return
  const s = new StepCalc(data.value, book.value)
  const c = new ChainCalc(data.value, book.value, s)
  const r = new Rank(data.value, book.value, s, c)
  r.build(calcOptions())
  rank.value = r
  if (selected.value) {
    selected.value = r.rows.find((x: Row) => x.actionId === selected.value!.actionId) || null
  }
}

const opts = computed(() => calcOptions())
const skills = computed(() => (data.value ? skillList(data.value) : []))

watch(() => ({ ...settings }), () => { if (book.value) { book.value.loadManual(priceState.manual); rebuild() } }, { deep: true })
watch(() => ({ ...player }), () => rebuild(), { deep: true })
watch(() => priceState.manual, () => { if (book.value) { book.value.loadManual(priceState.manual); rebuild() } }, { deep: true })
watch(() => priceState.market, () => {
  if (book.value) book.value.setMarket(new Map(Object.entries(priceState.market).map(([k, v]) => [Number(k), v])))
  rebuild()
}, { deep: true })

const rows = computed<Row[]>(() => {
  if (!rank.value) return []
  const f = rank.value.filter({
    skill: settings.skill, maxLevel: settings.maxLevel,
    onlyMarket: settings.onlyMarket, onlyPositive: settings.onlyPositive, keyword: settings.keyword,
  })
  return rank.value.sort(f, settings.sortKey as SortKey, sortDesc.value)
})

const summary = computed(() => rank.value?.summary() ?? { total: 0, positive: 0, withMarket: 0, skills: 0 })
const chainCtx = computed(() => {
  if (!data.value || !book.value || !selected.value) return null
  const s = new StepCalc(data.value, book.value)
  return { chain: new ChainCalc(data.value, book.value, s), step: s, id: selected.value.actionId }
})

function fmt(n: number, d = 0): string {
  if (!Number.isFinite(n)) return '—'
  if (Math.abs(n) >= 1e9) return (n / 1e9).toFixed(2) + 'B'
  if (Math.abs(n) >= 1e6) return (n / 1e6).toFixed(2) + 'M'
  if (Math.abs(n) >= 1e4) return (n / 1e3).toFixed(1) + 'k'
  return n.toLocaleString('zh-CN', { maximumFractionDigits: d })
}
function dur(sec: number): string {
  if (!Number.isFinite(sec) || sec <= 0) return '—'
  if (sec < 60) return sec.toFixed(0) + ' 秒'
  if (sec < 3600) return (sec / 60).toFixed(1) + ' 分'
  return (sec / 3600).toFixed(1) + ' 小时'
}
function onReset() { resetSettings(); priceState.manual = {}; rebuild() }
</script>

<template>
  <div class="wrap">
    <header class="top">
      <h1>DVI 利润网</h1>
      <span class="ver" v-if="data">数据 {{ data.meta.version }} · {{ data.actions.length }} 配方 · {{ data.monsters.length }} 怪物</span>
      <span class="spacer"></span>
      <span class="ver" v-if="book">{{ book.marketCount() }} 个市场价</span>
      <span class="ver ok" v-if="!isPristine(player)">玩家配置已生效</span>
    </header>

    <nav class="nav">
      <button v-for="v in VIEWS" :key="v.key" :class="{ on: current === v.key }"
              :title="v.desc" @click="go(v.key)">
        <span class="ic">{{ v.icon }}</span>{{ v.label }}
      </button>
    </nav>

    <div v-if="loading" class="note">正在加载游戏数据…</div>
    <div v-else-if="err" class="note warn">
      <b>加载失败：</b>{{ err }}
      <div style="margin-top:6px;font-size:12px">
        若是直接双击打开的 HTML，浏览器会拦截本地文件读取 ——
        请用 <code>npm run dev</code> 起本地服务，或部署到静态托管。
      </div>
    </div>

    <template v-else-if="data && book">
      <div v-if="isPristine(player) && !['dashboard', 'docs'].includes(current)" class="note warn">
        还没配置玩家数据，当前是<b>裸利润</b>（不含增益、工具、特权）。
        去「① 玩家配置」填一下，数字会明显不一样。
      </div>

      <DashboardView v-if="current === 'dashboard'" :data="data" :book="book" />

      <div v-else-if="current === 'profit'" class="view">
        <div class="vhead">
          <h2>利润排行</h2>
          <p>按<b>整链</b>净利排序 —— 一件成品的价格里含着原料成本，只看单步加价会严重误导。</p>
        </div>

        <div class="bar">
          <div class="grp">
            <label>技能</label>
            <select v-model="settings.skill">
              <option value="__all">全部</option>
              <option v-for="s in skills" :key="s" :value="s">{{ skillLabel(s) }}（{{ s }}）</option>
            </select>
          </div>
          <div class="grp">
            <label>最高等级</label>
            <input type="number" v-model.number="settings.maxLevel" min="0" max="120" step="5" style="width:70px">
          </div>
          <div class="grp">
            <label>搜索</label>
            <input type="text" v-model="settings.keyword" placeholder="物品 / 分类" style="width:130px">
          </div>
          <div class="grp">
            <label>排序</label>
            <select v-model="settings.sortKey">
              <option v-for="s in SORTS" :key="s.key" :value="s.key">{{ s.label }}</option>
            </select>
            <button @click="sortDesc = !sortDesc">{{ sortDesc ? '↓' : '↑' }}</button>
          </div>
          <div class="grp">
            <label>生长口径</label>
            <button :class="{on: settings.parallelGrow}" @click="settings.parallelGrow = true" title="等待期去干别的">并行</button>
            <button :class="{on: !settings.parallelGrow}" @click="settings.parallelGrow = false" title="种下去就干等">单线程</button>
          </div>
          <div class="grp">
            <label>收益口径</label>
            <button :class="{on: settings.revenueSide === 'bid'}" @click="settings.revenueSide = 'bid'">保守</button>
            <button :class="{on: settings.revenueSide === 'ask'}" @click="settings.revenueSide = 'ask'">乐观</button>
          </div>
          <div class="grp">
            <button :class="{on: settings.onlyPositive}" @click="settings.onlyPositive = !settings.onlyPositive">只看正利润</button>
          </div>
          <span class="spacer"></span>
          <div class="grp"><button @click="onReset">重置</button></div>
        </div>

        <div class="stats">
          <div><div class="k">配方</div><div class="v">{{ summary.total }}</div></div>
          <div><div class="k">正利润</div><div class="v" style="color:var(--up)">{{ summary.positive }}</div></div>
          <div><div class="k">有市场价</div><div class="v">{{ summary.withMarket }}</div></div>
          <div><div class="k">显示</div><div class="v">{{ rows.length }}</div></div>
        </div>

        <div class="tw">
          <table>
            <thead>
              <tr>
                <th class="l">配方</th><th class="l">技能</th>
                <th>整链净利/时</th><th>单步净利/时</th><th>单次加价</th>
                <th>经验/时</th><th>单次耗时</th><th>成品价值</th>
                <th>价来源</th><th>可成交量</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="r in rows" :key="r.actionId" :class="{sel: selected?.actionId === r.actionId}" @click="selected = r">
                <td class="l">{{ r.name }}<span class="lv" :class="{hi: r.levelReq > (player.levels[r.skill] ?? 99)}">{{ r.levelReq }}</span></td>
                <td class="l"><span class="skill">{{ skillLabel(r.skill) }}</span></td>
                <td class="num" :class="r.chainNetPerHour > 0 ? 'pos' : 'neg'">{{ fmt(r.chainNetPerHour) }}</td>
                <td class="num" :class="r.step.netPerHour > 0 ? 'pos' : 'neg'">{{ fmt(r.step.netPerHour) }}</td>
                <td class="num" :class="r.chainAdd > 0 ? 'pos' : 'neg'">{{ fmt(r.chainAdd) }}</td>
                <td class="num">{{ fmt(r.step.xpPerHour) }}</td>
                <td class="num">{{ dur(r.step.seconds) }}</td>
                <td class="num">{{ fmt(book.item(r.step.action.output!.itemId)?.value ?? 0) }}</td>
                <td><span class="dot" :class="r.priceSource"></span>{{ r.priceSource === 'market' ? '市场' : r.priceSource === 'manual' ? '手动' : '兜底' }}</td>
                <td class="num" :class="r.sellable === 0 ? 'neg' : ''">{{ r.sellable === Infinity ? '∞' : r.sellable }}</td>
              </tr>
            </tbody>
          </table>
          <div v-if="!rows.length" class="empty">没有符合筛选条件的配方</div>
        </div>

        <ChainPanel v-if="chainCtx" :ctx="chainCtx" :opts="opts" @close="selected = null" />
      </div>

      <div v-else-if="current === 'chain'" class="view">
        <div class="vhead">
          <h2>产业链</h2>
          <p>DVI 的链条<b>最深只有 3 层</b>，所以整张图能一次铺开算 —— 点任一成品看它的完整原料链与成本构成。</p>
        </div>
        <div class="card">
          <h3>选一个成品</h3>
          <select :value="selected?.actionId ?? 0" @change="(e) => {
            const id = Number((e.target as HTMLSelectElement).value)
            selected = rank?.rows.find(r => r.actionId === id) ?? null
          }">
            <option :value="0">请选择</option>
            <option v-for="r in rank?.rows ?? []" :key="r.actionId" :value="r.actionId">
              {{ r.name }}（{{ r.skill }} · 深度 {{ r.chainDepth }}）
            </option>
          </select>
        </div>
        <ChainPanel v-if="chainCtx" :ctx="chainCtx" :opts="opts" @close="selected = null" />
        <div v-else class="note">还没有选择成品。</div>
      </div>

      <EnhanceView v-else-if="current === 'enhance'" :data="data" :book="book" :opts="opts" />
      <CombatView v-else-if="current === 'combat'" :data="data" :book="book" :opts="opts" />
      <ConsumableView v-else-if="current === 'consumable'" :data="data" :book="book" :opts="opts" />

      <div v-else-if="current === 'market'" class="view">
        <div class="vhead">
          <h2>价格</h2>
          <p>没有市场数据时全部用兜底价。想看真实利润，导入快照或手动填价。</p>
        </div>
        <div class="card">
          <h3>当前数据来源分布</h3>
          <p style="font-size:12.5px;color:var(--fg2);margin:0">
            市场价 {{ book.marketCount() }} 个 · 手动价 {{ Object.keys(priceState.manual).length }} 个 ·
            其余 {{ data.items.length - book.marketCount() - Object.keys(priceState.manual).length }} 个用兜底价
          </p>
        </div>
        <PriceManager :book="book" @close="go('market')" />
      </div>

      <DocsView v-else-if="current === 'docs'" :data="data" />
    </template>

    <footer>
      <div>游戏数据 {{ data?.meta.version }}（{{ data?.meta.commit }}）· 提取自客户端 bundle，只读分析，不发送任何游戏指令</div>
      <div>静态页面无法直接读取游戏内实时行情；导入价格快照后，利润才接近真实。</div>
    </footer>
  </div>
</template>

<style scoped>
.nav{display:flex;flex-wrap:wrap;gap:6px;margin:0 0 12px}
.nav .ic{font-size:11px;opacity:.55;margin-right:1px}
.ver.ok{color:var(--up)}
.vhead{margin-bottom:10px}
.vhead h2{margin:0 0 3px;font-size:17px}
.vhead p{margin:0;font-size:12.5px;color:var(--fg2)}
.tw{background:var(--panel);border:1px solid var(--line);border-radius:9px;overflow:auto;max-height:70vh}
.empty{padding:36px 14px;text-align:center;color:var(--fg3)}
</style>
