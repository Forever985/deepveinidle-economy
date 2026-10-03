/**
 * 本地 HTTPS CONNECT 反向代理（专供 git push 走加速通道）
 *
 * 解决的问题：
 *   本机用 Watt Toolkit(Steam++) 的「hosts 劫持 + 443 MITM」模式加速 GitHub，
 *   hosts 里把 github.com 等指向 127.0.0.1:443。
 *   但 **Git for Windows 的 libcurl 不读 hosts 文件**（实测：git 直连真实 IP 会超时），
 *   而把 git 直接指向 127.0.0.1:443 当代理也不行
 *   （Watt 对 CONNECT 请求返回 302 —— 它只处理被劫持的直连流量，不做隧道）。
 *
 * 本代理的做法：
 *   监听 127.0.0.1:<port>，接收 git 发来的 `CONNECT host:443`，
 *   回 200 建立隧道，然后把**原始字节流**转发到：
 *     - 目标主机在劫持名单里 → 连 127.0.0.1:443（交给 Watt 做 MITM）
 *     - 其它主机             → 按系统 DNS 解析后直连
 *   TLS 握手由客户端在隧道内发起。
 *
 * 于是 git 只需认识一个普通 HTTP 代理即可。
 *
 * 用法：node scripts/local-github-proxy.mjs [port]
 *   启动后打印 READY；随后打印 SELFTEST_OK / SELFTEST_FAIL 自检结论。
 *   部署脚本据此判断能不能开始推 —— 通道不通就停下，绝不空推。
 */
import http from 'node:http'
import net from 'node:net'
import tls from 'node:tls'

const PORT = Number(process.argv[2] || 7899)

/** hosts 被劫持到 127.0.0.1 的域名：隧道终点固定走 Watt 的 443 */
const HIJACKED = [
  'github.com',
  'api.github.com',
  'codeload.github.com',
  'github.io',
  'pages.github.com',
  'raw.githubusercontent.com',
  'githubusercontent.com',
  'githubassets.com',
  'objects.githubusercontent.com',
]

function isHijacked(host) {
  return HIJACKED.some(h => host === h || host.endsWith(`.${h}`))
}

/** 对接客户端与目标；TLS 由客户端在隧道内发起 */
function tunnel(clientSocket, head, host, port) {
  const targetHost = isHijacked(host) ? '127.0.0.1' : host
  const targetPort = isHijacked(host) ? 443 : port

  const target = net.connect({ host: targetHost, port: targetPort })
  target.setNoDelay(true)
  clientSocket.setNoDelay(true)

  target.on('connect', () => {
    clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
    if (head && head.length) target.write(head)
    target.pipe(clientSocket)
    clientSocket.pipe(target)
  })

  const cleanup = () => {
    target.destroy()
    clientSocket.destroy()
  }
  target.on('error', cleanup)
  clientSocket.on('error', cleanup)
  target.on('close', cleanup)
  clientSocket.on('close', cleanup)
}

/** 普通 HTTP 转发（git 偶尔会用 http:// 探测） */
function forwardHttp(req, res) {
  const host = (req.headers.host || '').split(':')[0]
  const targetHost = isHijacked(host) ? '127.0.0.1' : host

  const proxyReq = http.request(
    { host: targetHost, port: 80, method: req.method, path: req.url, headers: req.headers },
    (proxyRes) => {
      res.writeHead(proxyRes.statusCode || 502, proxyRes.headers)
      proxyRes.pipe(res)
    },
  )
  proxyReq.on('error', () => {
    res.writeHead(502)
    res.end('proxy error')
  })
  req.pipe(proxyReq)
}

const server = http.createServer(forwardHttp)

server.on('connect', (req, clientSocket, head) => {
  const [host, portStr] = (req.url || '').split(':')
  const port = Number(portStr || 443)
  if (!host) {
    clientSocket.destroy()
    return
  }
  tunnel(clientSocket, head, host, port)
})

server.listen(PORT, '127.0.0.1', () => {
  console.log(`READY http://127.0.0.1:${PORT}`)
})

server.on('error', (e) => {
  console.error(`LISTEN_FAIL ${e.code || e.message}`)
  process.exit(1)
})

// 自检：启动后立刻验证隧道能否真的把 github.com 打通（避免在坏通道上空推）
if (process.env.PROXY_SELFTEST !== '0') {
  setTimeout(() => {
    const probe = tls.connect(
      { host: '127.0.0.1', port: 443, servername: 'github.com', rejectUnauthorized: false },
      () => {
        console.log('SELFTEST_OK github.com reachable via accelerator')
        probe.destroy()
      },
    )
    probe.on('error', (e) => console.log(`SELFTEST_FAIL ${e.message}`))
  }, 50)
}
