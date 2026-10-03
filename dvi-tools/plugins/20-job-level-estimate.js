// ==UserScript==
// @name         DVI Tools · 作业升级预估（内联）
// @namespace    dvi.tools.plugins
// @version      1.0.0
// @description  在游戏的作业列表里就地显示「还需几次行动、多长时间才能升到目标等级」。直接注入到游戏界面，不是悬浮窗。只读。
// @author       -
// @match        https://deepveinidle.com/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

/*
 * 这是「融入游戏」的示范：内容长在游戏自己的作业行里。
 *
 * 锚点 button.route[data-job] 是从客户端代码里读出来的——
 * 游戏的作业行就是 <button class="route" data-job="{配方id}">，
 * 并且它有一套原生 tooltip 约定（data-tip-name / data-tip-lines），
 * 所以注入的提示看起来和游戏自带的没有区别。
 */

(function () {
  'use strict';

  /* ── 启动痕迹 ──
   * 目的只有一个：证明「这段代码到底有没有被执行」。
   * 同时写到 DOM 属性（元素面板里直接可见）和页面全局，双保险，
   * 且都包 try/catch —— 任何情况下都不会因此中断。 */
  try {
    if (document.documentElement) {
      document.documentElement.setAttribute('data-dvi-plugin-20', '1');
    }
  } catch (e) {}
  try {
    const r0 = (typeof unsafeWindow !== 'undefined' && unsafeWindow) || window;
    (r0.__dviBoot = r0.__dviBoot || []).push('20-job-level-estimate');
  } catch (e) {}
  try { console.info('[DVI] 插件 20-job-level-estimate 代码已执行'); } catch (e) {}

  /* ── 引导：等主干就绪，并且失败时要留痕 ──
   * 之前这里是一句 `if (!DVI) return;` —— 找不到主干就静默退出。
   * 后果是：功能完全不出现，而用户和开发者都看不到任何原因。
   * 现在改成重试 + 把失败原因写到一个诊断能读到的地方。 */
  const PLUGIN_ID = 'job-level-estimate';

  function pageRoot() {
    try { return (typeof unsafeWindow !== 'undefined' && unsafeWindow) || window; }
    catch (e) { return window; }
  }
  function findTrunk() {
    try { return pageRoot().DVI || window.DVI; } catch (e) { return null; }
  }
  function noteFailure(reason) {
    try {
      const r = pageRoot();
      const list = r.__dviPluginErrors || (r.__dviPluginErrors = []);
      list.push({ plugin: PLUGIN_ID, reason: String(reason), at: new Date().toISOString() });
    } catch (e) { /* 尽力而为 */ }
    try { console.error('[DVI 升级预估] ' + reason); } catch (e) {}
  }

  function whenTrunk(fn) {
    let tries = 0;
    (function attempt() {
      const D = findTrunk();
      if (D) {
        try { fn(D); }
        catch (e) { noteFailure('注册时抛异常：' + ((e && e.message) || e)); }
        return;
      }
      if (++tries >= 50) {          // 约 5 秒
        noteFailure('等待 5 秒仍未找到 DVI 主干（插件未注册）');
        return;
      }
      setTimeout(attempt, 100);
    })();
  }

  whenTrunk(function (DVI) {
  const { calc, data } = DVI;

  DVI.plugin.register({
    id: 'job-level-estimate',
    name: '作业升级预估',
    nameEn: 'Job level estimate',
    description: '在每个作业旁就地显示还需几次行动升级',
    api: 1,
    defaultEnabled: true,

    settings: [
      { key: 'target', label: '目标等级（0 = 下一级）', type: 'number',
        default: 0, min: 0, max: 120 },
      { key: 'showTime', label: '同时显示所需时间', type: 'bool', default: true },
      { key: 'refreshMode', label: '刷新方式（0 = 按需，1 = 自动）', type: 'number',
        default: 0, min: 0, max: 1 },
    ],

    /* 快捷操作：主干会在面板里渲染成按钮，并挂到油猴菜单。
     * 「升到第几级」这件事用一个数字框来表达太别扭 ——
     * 得先知道目标等级是多少，还得先翻面板。给个直接问的入口。 */
    quickActions: [
      {
        label: '设置目标等级',
        menuIcon: '🎯',
        run(ctx) {
          // 用数据层的技能表，而不是写死技能名 —— 游戏加技能时自动跟上
          const skills = [...data.BY_SKILL.keys()];
          const me = ctx.state.me;
          const lv = (k) => calc.levelForXp((me && me.skills && me.skills[k]) || 0);
          const lows = me ? skills.map(lv) : [];
          const range = lows.length ? `${Math.min(...lows)} ~ ${Math.max(...lows)}` : '未知';

          const now = Number(ctx.settings.get('target')) || 0;
          const input = prompt(
            '升到指定等级\n' +
            `（当前各技能等级：${range}）\n\n` +
            '填 0 = 只看下一级\n' +
            '填具体等级 = 一直算到那一级为止',
            now > 0 ? String(now) : '0'
          );
          if (input === null) return;                 // 用户取消
          const v = Math.max(0, Math.min(120, Math.floor(Number(input)) || 0));
          ctx.settings.set('target', v);
          this.recompute(ctx, true);
          ctx.core.ui.toast(v > 0 ? `目标等级已设为 ${v}` : '目标等级已设为「下一级」');
        },
      },
    ],

    /* ══════════ 为什么是「按需」而不是「即时」 ══════════
     * 计算（actionsToLevel）比重新注入贵得多：
     * 前者要按等级逐级累加经验，后者只是 Map 查表 + 插一个节点。
     * 而游戏每次重绘都会重跑 render，如果每次都重算，
     * 每秒几十次地做无用功，对浏览器和设备都是负担。
     *
     * 所以拆成两件事：
     *   render（便宜、高频）→ 只读缓存
     *   recompute（贵、低频）→ 只在「页面加载 / 用户点刷新 / 自动模式且已隔 ≥30 秒」时跑
     */
    setup(ctx) {
      this.ctx = ctx;
      this.cache = new Map();      // jobId → 渲染好的 HTML
      this.lastCalc = 0;           // 上次重算的时间戳
      this.MIN_GAP = 30 * 1000;    // 自动模式下的最小重算间隔

      // 关键：注入到游戏界面，而不是另开窗口。
      // 候选选择器按可靠度排序，逐个回退 —— 游戏改版时不会一步失效。
      //   [data-routes] 是客户端里作业列表的容器（rowFor 的父级）
      //   button.route[data-job] 是每一行本身
      //   [data-job] 是最宽的回退
      ctx.ui.inline({
        id: 'job-level-estimate',
        selector: ['[data-routes] [data-job]', 'button.route[data-job]', '[data-job]'],
        where: 'beforeend',
        render: (host) => this.renderRow(ctx, host),
      });

      /* 刷新入口**不新增任何 DOM 节点**。
       * 曾经在列表上下各插过一个独立按钮，两次都把游戏面板的排版撑坏 ——
       * 那个容器多半是 flex/grid，多一个兄弟节点就改变整个布局。
       * 改成：直接让**标注自己**可点。标注本来就长在作业行内部，
       * 不引入新节点，也就不会影响任何布局。
       * （游戏会吞掉落在 data-tip-name 上的点击，所以这里必须自己接管。） */
      this.attachClick(ctx);

      // 用户主动要求重算
      ctx.bus.on(ctx.EVT.REFRESH, () => this.recompute(ctx, true));

      // 自动模式：只在状态真的变了、且距上次重算超过 MIN_GAP 时才重算
      ctx.bus.on(ctx.EVT.SNAPSHOT, () => {
        if (this.isAuto(ctx)) this.recompute(ctx, false);
      });
      ctx.core.settings.onChange((k) => {
        if (k.startsWith(ctx.id + '.')) this.recompute(ctx, true);
      });

      // 首次进入：算一次
      this.recompute(ctx, true);
      ctx.log('已注入作业列表');
    },

    /** 自动模式？（设置项 refreshMode = 1） */
    isAuto(ctx) {
      return Number(ctx.settings.get('refreshMode')) === 1;
    },

    /**
     * 重算并刷新。
     * @param {boolean} force 忽略节流立即重算（用户主动触发时为 true）
     */
    recompute(ctx, force) {
      const now = Date.now();
      if (!force && now - this.lastCalc < this.MIN_GAP) return false;
      this.cache.clear();          // 丢掉旧结果，下次 render 会重新算
      this.lastCalc = now;
      ctx.ui.inline.refresh();
      return true;
    },

    /** 安装「点标注 → 重算」的委托监听。幂等：重复调用不会装两遍。 */
    attachClick(ctx) {
      if (this.onDocClick) return;
      this.onDocClick = (e) => {
        const t = e.target;
        const note = t && t.closest && t.closest('.dvi-inline-note');
        if (note) {
          e.preventDefault();
          e.stopPropagation();
          this.recompute(ctx, true);
          ctx.log('点击标注 → 重算');
        }
      };
      document.addEventListener('click', this.onDocClick, true);
    },

    detachClick() {
      if (this.onDocClick) {
        document.removeEventListener('click', this.onDocClick, true);
        this.onDocClick = null;
      }
    },

    enable(ctx) {
      this.attachClick(ctx);      // disable 时摘掉了，启用必须装回来
      ctx.ui.inline.refresh();
      ctx.log('已启用');
    },

    disable(ctx) {
      this.detachClick();
      if (this.cache) this.cache.clear();
      ctx.ui.uninline();
    },

    /* ── 目标等级：0 表示「下一级」 ── */
    resolveTarget(ctx, skill, xp) {
      const cur = calc.levelForXp(xp);
      const want = Number(ctx.settings.get('target')) || 0;
      if (want > 0) return want;
      return cur + 1;
    },

    /* ── 每个作业行渲染一次 ──
     * 高频路径，只读缓存：游戏每次重绘都会走这里，
     * 所以这里**绝不能做重活**。缓存未命中时才算一次（懒计算）。 */
    renderRow(ctx, host) {
      const jobId = Number(host.dataset.job);
      if (!Number.isFinite(jobId)) return null;

      if (this.cache.has(jobId)) return this.cache.get(jobId);

      const html = this.computeRow(ctx, jobId);
      this.cache.set(jobId, html);
      return html;
    },

    /* ── 真正计算一行（贵）── */
    computeRow(ctx, jobId) {
      const action = data.ACTION.get(jobId);
      if (!action) return null;

      const me = ctx.state.me;
      if (!me) return null;                       // 还没登录，什么都不显示

      const skill = action.skill;
      const xp = (me.skills && me.skills[skill]) || 0;
      const level = calc.levelForXp(xp);

      // 未达技能等级要求：这行游戏自己会标灰，我们只在行末给一句提示
      if (level < action.levelReq) {
        return `<span class="dvi-inline-note" data-tone="warn"
          ${ctx.ui.tip('升级预估', [
            `需要 ${data.skillName(skill)} ${action.levelReq} 级`,
            `当前 ${level} 级，还差 ${action.levelReq - level} 级`,
            `这个行动暂时做不了`,
          ])}>差 ${action.levelReq - level} 级</span>`;
      }

      // 不求经验的行动（比如某些采集）直接跳过
      if (!action.xp) return null;

      // 即时取「当前配置」：等级、当前装备的工具、特长、增益、社区活动、精通。
      // 全部从实时状态现算 —— 换装备或增益到期，下一次渲染就变。
      const opts = ctx.state.actionContext(action);

      const target = this.resolveTarget(ctx, skill, xp);
      if (target <= level) {
        return `<span class="dvi-inline-note" data-tone="done"
          ${ctx.ui.tip('升级预估', [`已经是 ${level} 级`])}>已达标</span>`;
      }

      const est = calc.actionsToLevel(action, xp, target, opts);
      if (!est) return null;

      const showTime = ctx.settings.get('showTime');
      const label = showTime
        ? `需 ${est.actions.toLocaleString()} 次 · ${calc.humanDuration(est.seconds)}`
        : `需 ${est.actions.toLocaleString()} 次`;

      // tooltip 必须有节制：游戏的原生提示框没有滚动条，
      // 行数一多就撑破屏幕（曾经堆到 22 行，直接「爆」了）。
      // 所以这里硬性裁剪，只保留最该看的，分段明细最多 4 行且超出就汇总。
      const lines = [
        `${data.skillName(skill)} ${est.fromLevel} → ${est.toLevel} 级`,
        `共 ${est.actions.toLocaleString()} 次 · 每次 ${est.xpPerAction} 经验`,
        `纯作业耗时 ${calc.humanDuration(est.seconds)}`,
      ];

      // 当前配置：只列「非默认」的项，最多 4 条 —— 全是默认值时不占篇幅
      const cfg = ctx.state.configSummary(action)
        .filter(c => c.label === '工具' ? !c.value.includes('未装备') : true)
        .slice(0, 4);
      if (cfg.length) {
        lines.push('— 当前配置 —');
        for (const c of cfg) lines.push(`${c.label}：${c.value}`);
      }

      // 分段明细：只在跨越不多时给，最多 4 段，超出就只说平均
      if (est.perLevel.length > 1 && est.perLevel.length <= 4) {
        lines.push('— 分段 —');
        for (const seg of est.perLevel) {
          lines.push(`${seg.level}→${seg.level + 1}：${seg.actions} 次`);
        }
      } else if (est.perLevel.length > 4) {
        lines.push(`跨 ${est.perLevel.length} 级，平均每级 ${Math.round(est.actions / est.perLevel.length)} 次`);
      }

      lines.push('不含赶路时间');
      const tgt = Number(ctx.settings.get('target')) || 0;
      // 两种情况都写明修改入口 —— 设了目标之后更应该能记起怎么改回来
      lines.push((tgt > 0 ? `目标：升到第 ${tgt} 级` : '目标：下一级') +
                 '（菜单「🎯 设置目标等级」可改）');
      lines.push(this.isAuto(ctx)
        ? '自动模式：状态变化后会自动重算'
        : '点一下这条标注即可重算');

      return `<span class="dvi-inline-note" data-tone="${est.actions > 1000 ? 'warn' : ''}"
        ${ctx.ui.tip('升级预估 · ' + action.name, lines)}>${label}</span>`;
    },
  });

  });   // whenTrunk
})();
