import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { configureProxy } from '../src/main/llm/claude.ts'

/**
 * Прокси из окружения и NO_PROXY. ProxyAgent слал через прокси всё подряд: локальный адрес пакета для видеокарты
 * (COPILOT_GPU_PACK_URL=http://127.0.0.1:…) получал 503 от прокси, и загрузка «с GitHub» падала, не дойдя до сервера.
 * Глобальный диспетчер undici живёт до конца процесса — поэтому тест в своём файле: node --test гоняет файлы отдельно.
 */

async function listen(srv: Server): Promise<string> {
  await new Promise<void>((resolve) => srv.listen(0, '127.0.0.1', resolve))
  return `http://127.0.0.1:${(srv.address() as AddressInfo).port}`
}

const close = (srv: Server) =>
  new Promise<void>((resolve) => {
    srv.closeAllConnections()
    srv.close(() => resolve())
  })

test('прокси: свой компьютер и NO_PROXY — напрямую, остальное — через прокси', async () => {
  const proxyHits: string[] = []
  const proxy = createServer((req, res) => {
    proxyHits.push(req.url ?? '')
    res.writeHead(503).end()
  })
  // CONNECT (туннель) приходит отдельным событием: отвечаем тем же отказом.
  proxy.on('connect', (req, socket) => {
    proxyHits.push(req.url ?? '')
    socket.end('HTTP/1.1 503 Service Unavailable\r\n\r\n')
  })
  const target = createServer((_req, res) => res.writeHead(200).end('напрямую'))
  const mirror = createServer((_req, res) => res.writeHead(200).end('зеркало'))
  const saved = { HTTPS_PROXY: process.env.HTTPS_PROXY, HTTP_PROXY: process.env.HTTP_PROXY, NO_PROXY: process.env.NO_PROXY, no_proxy: process.env.no_proxy }
  try {
    const proxyUrl = await listen(proxy)
    const targetUrl = await listen(target)
    // Тот же сервер под именем, которого нет среди «своих» адресов: IPv4 через IPv6-запись. Имя без DNS —
    // проверка не зависит от сети машины и не ждёт разрешения выдуманного домена.
    await new Promise<void>((resolve) => mirror.listen(0, '::', resolve))
    const mirrorHost = '::ffff:7f00:1'
    const mirrorUrl = `http://[${mirrorHost}]:${(mirror.address() as AddressInfo).port}`
    delete process.env.no_proxy
    delete process.env.HTTP_PROXY
    process.env.HTTPS_PROXY = proxyUrl
    delete process.env.NO_PROXY
    assert.equal(configureProxy(), proxyUrl)

    // 127.0.0.1 в NO_PROXY не указан — всё равно мимо прокси.
    const res = await fetch(`${targetUrl}/podskazych-vk-win-x64.zip`)
    assert.equal(res.status, 200)
    assert.equal(await res.text(), 'напрямую')
    assert.deepEqual(proxyHits, [])

    // Прочее — через прокси, как раньше (запросы к Клоду при «включённом VPN»).
    await fetch(`${mirrorUrl}/x`).then(
      (r) => assert.equal(r.status, 503),
      () => {},
    )
    assert.equal(proxyHits.length, 1, 'запрос не дошёл до прокси')

    // Тот же адрес в NO_PROXY — напрямую.
    process.env.NO_PROXY = `example.com, ${mirrorHost}`
    configureProxy()
    const direct = await fetch(`${mirrorUrl}/x`)
    assert.equal(direct.status, 200)
    assert.equal(await direct.text(), 'зеркало')
    assert.equal(proxyHits.length, 1, 'адрес из NO_PROXY ушёл в прокси')
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
    await close(proxy)
    await close(target)
    if (mirror.listening) await close(mirror)
  }
})
