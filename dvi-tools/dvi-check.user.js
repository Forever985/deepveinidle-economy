// ==UserScript==
// @name         DVI 最小自检（诊断用，装完可删）
// @namespace    dvi.diag
// @version      2026.10.03.7
// @description  只有一个菜单项：判断主干是否在运行、插件是否初始化成功、内联是否命中。装完可随时删除。
// @author       -
// @match        https://deepveinidle.com/*
// @grant        GM_registerMenuCommand
// @run-at       document-idle
// ==/UserScript==

/*
 * 为什么单独做一个小脚本：
 *   大脚本出问题时，「代码有 bug」和「脚本没装上 / 被禁用」很难区分。
 *   这个脚本只做一件事，能干净地把它们分开。
 *
 * 2026.10.02.3 更新：
 *   上一版只检查「有没有锚点」，却没检查「插件是否初始化失败」——
 *   而真实的 bug 恰恰就是插件 setup 抛错被静默吞掉。现在会明确报出来。
 */

(function () {
  'use strict';

  function section(title) { return '\n【' + title + '】'; }

  function run() {
    const out = [];
    const D = (window.DVI ||
               (typeof unsafeWindow !== 'undefined' && unsafeWindow && unsafeWindow.DVI) || null);

    out.push('① 自检脚本本身');
    out.push('   运行中 ✓  域名：' + location.host);

    out.push(section('② DVI 主干'));
    if (!D) {
      out.push('   未找到 ✗ —— 主干脚本没有在运行');
      out.push('   可能原因：没安装 / 被禁用 / 域名不匹配 / 加载时报错');
    } else {
      out.push('   已加载 ✓');
      out.push('   版本：' + (D.version || D.VERSION || '(无版本字段，可能是很旧的构建)'));
      out.push('   沙箱：' + ((typeof unsafeWindow !== 'undefined' && unsafeWindow)
        ? '有 unsafeWindow（正常）' : '无 unsafeWindow'));
    }

    out.push(section('③ 插件'));
    let broken = [];
    if (D && D.plugin && D.plugin.list) {
      const list = D.plugin.list();
      if (!list.length) {
        out.push('   没有注册任何插件 ✗ —— 插件脚本没被加载进来');
      } else {
        for (const p of list) {
          const st = p.setupError ? '初始化失败 ✗'
                   : (p.enabled ? '已启用 ✓' : '已禁用');
          out.push('   ' + p.id + ' → ' + st);
          if (p.setupError) out.push('      ⚠ ' + p.setupError);
        }
        broken = list.filter(p => p.setupError);
      }
    } else if (D) {
      out.push('   主干没有 plugin 模块 —— 你装的是旧版本主干');
    } else {
      out.push('   无法检查（主干未运行）');
    }

    // ★ 决定性的证据：插件那段代码到底被执行了没有
    out.push('   ── 启动痕迹（判断插件代码是否被执行）──');
    const m10 = document.documentElement &&
                document.documentElement.getAttribute('data-dvi-plugin-10');
    const m20 = document.documentElement &&
                document.documentElement.getAttribute('data-dvi-plugin-20');
    out.push('   DOM 痕迹 10-example-job-yield ：' + (m10 ? '已执行 ✓' : '未执行 ✗'));
    out.push('   DOM 痕迹 20-job-level-estimate：' + (m20 ? '已执行 ✓' : '未执行 ✗'));
    let boot = [];
    try {
      const r = (typeof unsafeWindow !== 'undefined' && unsafeWindow) || window;
      boot = r.__dviBoot || [];
    } catch (e) {}
    out.push('   全局 __dviBoot ：' + (boot.length ? boot.join(', ') : '（空）'));

    // 插件脚本自身启动失败时留下的痕迹
    let loadErrors = [];
    try {
      const r = (typeof unsafeWindow !== 'undefined' && unsafeWindow) || window;
      loadErrors = r.__dviPluginErrors || [];
    } catch (e) {}
    let loaded = 0;
    try { loaded = (D && D.plugin && D.plugin.list) ? D.plugin.list().length : 0; } catch (e) {}

    if (loadErrors.length) {
      out.push('   插件脚本未能启动 ✗：');
      for (const x of loadErrors) out.push('      ' + x.plugin + '：' + x.reason);
    } else if (!m10 && !m20) {
      out.push('   ⚠ 两个插件都「未执行」且无失败记录');
      out.push('     → 插件那一段代码没有运行，属打包层面的问题');
    } else if (loaded === 0) {
      out.push('   ⚠ 插件代码已执行，但一个都没注册进来');
      out.push('     → 看上面是否有失败原因；没有就说明注册环节被跳过了');
    } else {
      out.push('   → 插件代码已执行，且已注册 ' + loaded + ' 个，正常');
    }

    out.push(section('④ 页面元素（决定锚点能否命中）'));
    const probes = ['#app', '[data-routes]', '[data-job]', 'button.route', '.route', 'body'];
    for (const sel of probes) {
      let n;
      try { n = document.querySelectorAll(sel).length; } catch (e) { n = '非法'; }
      out.push('   ' + sel.padEnd(16) + ' → ' + n + ' 个');
    }
    out.push('   提示：作业标注只可能在 [data-job] 或 button.route 大于 0 时出现');

    out.push(section('⑤ 内联注入'));
    let anchorCount = 0, totalInjected = 0, totalHosts = 0;
    if (D && D.ui && D.ui.inline && D.ui.inline.report) {
      const rep = D.ui.inline.report();
      anchorCount = rep.length;
      if (!rep.length) {
        out.push('   没有任何锚点注册 ✗');
        if (broken.length) out.push('   ↑ 但插件初始化失败了，这就是原因（见 ③）');
        else out.push('   ↑ 插件可能没跑起来，看 ③');
      } else {
        for (const r of rep) {
          totalInjected += r['已注入'] || 0;
          totalHosts += r['找到宿主'] || 0;
          out.push('   锚点 ' + r['锚点']);
          out.push('     候选：' + r['候选选择器']);
          out.push('     命中：' + r['命中的']);
          out.push('     宿主 ' + r['找到宿主'] + ' 个 / 注入 ' + r['已注入'] + ' 个');
          if (r['错误']) out.push('     ⚠ ' + r['错误']);
        }
      }
    } else if (D) {
      out.push('   主干没有内联模块 —— 你装的是旧版本主干');
    } else {
      out.push('   无法检查（主干未运行）');
    }

    out.push(section('⑥ 最近日志'));
    if (D && D.diag && D.diag.tail) {
      const rows = D.diag.tail(12);
      if (!rows.length) out.push('   （暂无）');
      else {
        for (const e of rows) {
          const ms = e.ms;
          const clk = String(Math.floor(ms / 60000)).padStart(2, '0') + ':' +
                      String(Math.floor(ms / 1000) % 60).padStart(2, '0');
          out.push('   ' + clk + ' ' + e.level.toUpperCase().padEnd(5) + ' ' +
                   e.tag.padEnd(10) + ' ' + e.msg);
        }
        out.push('   （完整日志请用主干的「📄 保存运行日志」）');
      }
    } else {
      out.push('   （主干无日志模块，或未运行）');
    }

    out.push(section('⑦ 结论'));
    if (!D) {
      out.push('   → 主干没在运行。确认它在油猴里存在且已启用。');
    } else if (broken.length) {
      out.push('   → 插件初始化失败（' + broken.map(p => p.id).join('、') + '）。');
      out.push('     这是代码问题，请把上面 ③ 的错误信息发给开发者。');
    } else if (!D.ui || !D.ui.inline) {
      out.push('   → 主干版本过旧，请重新安装最新版（@version 应形如 2026.xx.xx.x）。');
    } else if (anchorCount === 0) {
      out.push('   → 主干正常，但没有任何锚点注册。请把这份报告发给开发者。');
    } else if (totalInjected > 0) {
      out.push('   → 一切正常，作业列表已标注 ' + totalInjected + ' 处。');
    } else if (totalHosts === 0) {
      out.push('   → 插件已就绪，但页面还没有作业列表。');
      out.push('     请在游戏里打开作业/技能面板，然后重新运行本检查。');
    } else {
      out.push('   → 找到了宿主但没渲染成功，这是主干内部问题，请反馈 ⑤ 的内容。');
    }

    const text = out.join('\n');
    console.info('[DVI 最小自检]\n' + text);
    alert('DVI 最小自检\n════════════════════\n' + text);
  }

  GM_registerMenuCommand('▶ 运行 DVI 最小自检', run);
  console.info('[DVI 最小自检] 已加载。请从油猴菜单点「▶ 运行 DVI 最小自检」。');
})();
