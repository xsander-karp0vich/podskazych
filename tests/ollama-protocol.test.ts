import { mock, test } from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_OLLAMA_URL,
  LOAD_HEARTBEAT_CAP_MS,
  LOAD_HEARTBEAT_MS,
  NdjsonSplitter,
  chatBody,
  classifyOllamaError,
  errorFromBody,
  isChatModel,
  isLoopbackUrl,
  loadBody,
  ollamaBaseUrl,
  ollamaErrorText,
  ollamaUnreachable,
  parseChatLine,
  parseShow,
  parseTags,
  startHeartbeat,
  thinkValue,
  toModelInfo,
} from '../src/main/llm/providers/ollamaProtocol.ts'

test('ollama: адрес из OLLAMA_HOST — как envconfig.Host, адрес «слушать всё» — в loopback', () => {
  assert.equal(ollamaBaseUrl(undefined), 'http://127.0.0.1:11434')
  assert.equal(ollamaBaseUrl('  '), 'http://127.0.0.1:11434')
  assert.equal(ollamaBaseUrl('0.0.0.0'), 'http://127.0.0.1:11434', 'к 0.0.0.0 на Windows не подключиться')
  assert.equal(ollamaBaseUrl('0.0.0.0:8080'), 'http://127.0.0.1:8080')
  assert.equal(ollamaBaseUrl('localhost'), 'http://localhost:11434')
  assert.equal(ollamaBaseUrl('http://box.local'), 'http://box.local:80', 'схема задана — порт по умолчанию схемы')
  assert.equal(ollamaBaseUrl('https://example.com:8443/ollama/'), 'https://example.com:8443/ollama')
  assert.equal(ollamaBaseUrl('[::]:11434'), 'http://[::1]:11434')
  assert.equal(ollamaBaseUrl('::1'), 'http://[::1]:11434')
  assert.equal(ollamaBaseUrl('127.0.0.1:99999'), 'http://127.0.0.1:11434', 'неверный порт — по умолчанию')
  assert.equal(ollamaBaseUrl('ollama.com'), 'https://ollama.com:443')
  assert.equal(isLoopbackUrl('http://127.0.0.1:11434'), true)
  assert.equal(isLoopbackUrl('http://[::1]:11434'), true)
  assert.equal(isLoopbackUrl('https://ollama.com:443'), false)
})

test('ollama: /api/tags — модели, размер, облачные и битые записи', () => {
  const tags = parseTags({
    models: [
      {
        name: 'deepseek-r1:latest',
        model: 'deepseek-r1:latest',
        size: 4683075271,
        details: { family: 'qwen2', parameter_size: '7.6B', quantization_level: 'Q4_K_M' },
        capabilities: ['completion', 'thinking'],
      },
      { name: 'gpt-oss:120b-cloud', remote_host: 'https://ollama.com:443', details: { parameter_size: '116.8B' } },
      { name: 'nomic-embed-text:latest', capabilities: ['embedding'] },
      { name: 42 },
      'мусор',
      { name: 'deepseek-r1:latest' },
    ],
  })
  assert.deepEqual(
    tags.map((t) => [t.name, t.parameterSize, t.remote, t.capabilities]),
    [
      ['deepseek-r1:latest', '7.6B', false, ['completion', 'thinking']],
      ['gpt-oss:120b-cloud', '116.8B', true, undefined],
      ['nomic-embed-text:latest', undefined, false, ['embedding']],
    ],
  )
  assert.deepEqual(parseTags(null), [])
  assert.equal(isChatModel(['embedding']), false, 'эмбеддинги отвечать не умеют')
  assert.equal(isChatModel(undefined), true, 'не знаем — пробуем')

  const info = toModelInfo(tags[0]!, tags[0]!.capabilities)
  assert.deepEqual(info, { id: 'deepseek-r1:latest', name: 'deepseek-r1', short: 'deepseek-r1', hint: '7.6B · думает', efforts: null, images: false })
  const cloud = toModelInfo(tags[1]!, ['completion', 'vision'])
  assert.equal(cloud.images, true)
  assert.match(cloud.hint, /облако.*сеть/, 'облачная модель честно помечена')
  assert.equal(toModelInfo({ name: 'x/llava:7b', remote: false }, null).images, undefined, 'зрение неизвестно — undefined')
})

test('ollama: /api/show — capabilities и семейство', () => {
  assert.deepEqual(parseShow({ details: { family: 'llama' }, capabilities: ['completion', 'Vision'] }), {
    capabilities: ['completion', 'vision'],
    family: 'llama',
  })
  assert.deepEqual(parseShow({ details: {} }), { capabilities: null, family: undefined }, 'старый сервер без capabilities')
})

test('ollama: think — только думающим моделям, у GPT-OSS — уровни', () => {
  const thinker = { capabilities: ['completion', 'thinking'] }
  assert.equal(thinkValue('qwen3:8b', thinker, true), true)
  assert.equal(thinkValue('qwen3:8b', thinker, false), false)
  assert.equal(thinkValue('llama3.2', { capabilities: ['completion'] }, true), undefined, 'иначе Ollama ответит «does not support thinking»')
  assert.equal(thinkValue('llama3.2', { capabilities: null }, true), undefined)
  assert.equal(thinkValue('gpt-oss:20b', thinker, false), 'low', 'GPT-OSS булево значение игнорирует')
  assert.equal(thinkValue('gpt-oss:20b', thinker, true), 'medium')
  assert.equal(thinkValue('my-model', { capabilities: ['thinking'], family: 'gptoss' }, true, 'max'), 'high')
})

test('ollama: тело /api/chat — системное сообщение, картинки base64, think только если задан', () => {
  const body = chatBody({
    model: 'llava:7b',
    system: 'СИСТЕМА',
    text: 'Что на экране?',
    images: [{ mediaType: 'image/jpeg', data: 'QUJD' }],
    keepAlive: '20m',
  })
  assert.deepEqual(body, {
    model: 'llava:7b',
    messages: [
      { role: 'system', content: 'СИСТЕМА' },
      { role: 'user', content: 'Что на экране?', images: ['QUJD'] },
    ],
    stream: true,
    keep_alive: '20m',
  })
  assert.ok(!('think' in body))
  assert.equal(chatBody({ model: 'm', system: 's', text: 't', think: false }).think, false, 'false тоже передаётся')
  assert.deepEqual(loadBody('m'), { model: 'm', messages: [] })
})

test('ollama: поток NDJSON — строка может порваться между кусками', () => {
  const split = new NdjsonSplitter()
  assert.deepEqual(split.push('{"a":1}\n{"b"'), ['{"a":1}'])
  assert.deepEqual(split.push(':2}\r\n\n{"c":3}'), ['{"b":2}'])
  assert.deepEqual(split.flush(), ['{"c":3}'])
  assert.deepEqual(split.flush(), [])
})

test('ollama: строки ответа — текст, размышления, конец, ошибка посреди потока', () => {
  assert.deepEqual(parseChatLine('{"model":"m","message":{"role":"assistant","content":"The","images":null},"done":false}'), {
    type: 'chunk',
    content: 'The',
    thinking: '',
    done: false,
    doneReason: undefined,
  })
  assert.deepEqual(parseChatLine('{"message":{"role":"assistant","content":"","thinking":"хм"},"done":false}'), {
    type: 'chunk',
    content: '',
    thinking: 'хм',
    done: false,
    doneReason: undefined,
  })
  const last = parseChatLine('{"message":{"role":"assistant","content":""},"done":true,"done_reason":"stop","eval_count":282}')
  assert.equal(last?.type === 'chunk' && last.done, true)
  assert.deepEqual(parseChatLine('{"error":"an error was encountered while running the model"}'), {
    type: 'error',
    message: 'an error was encountered while running the model',
  })
  assert.equal(parseChatLine('не json'), null)
})

test('ollama: ошибки — по коду и тексту, с понятным текстом для окна', () => {
  assert.equal(errorFromBody('{"error":"model \\"qwen9\\" not found, try pulling it first"}'), 'model "qwen9" not found, try pulling it first')
  assert.equal(errorFromBody('plain'), 'plain')
  assert.equal(classifyOllamaError(404, 'model "qwen9" not found, try pulling it first'), 'model-unavailable')
  assert.equal(classifyOllamaError(400, 'llama3.2 does not support images'), 'images-unsupported')
  assert.equal(classifyOllamaError(429, 'too many'), 'rate-limit')
  assert.equal(classifyOllamaError(502, 'cloud model cannot be reached'), 'network')
  assert.equal(classifyOllamaError(500, 'the model failed to generate a response'), 'unknown')
  assert.match(ollamaErrorText('model-unavailable', '', 'qwen9'), /ollama pull qwen9/)
  assert.match(ollamaErrorText('unknown', 'model requires more system memory (12 GiB) than is available', 'big'), /не хватает памяти/)
})

test('ollama: сервер не отвечает — «не установлена» только без программы на стандартном адресе', () => {
  const installed = ollamaUnreachable(DEFAULT_OLLAMA_URL, true)
  assert.notEqual(installed.kind, 'not-installed', 'установленная, но не запущенная — не «Как установить»')
  assert.match(installed.message, /установлена, но не отвечает.*запустите/)
  const custom = ollamaUnreachable('http://box.local:8080', false)
  assert.notEqual(custom.kind, 'not-installed', 'адрес из OLLAMA_HOST — сервер может быть на другой машине')
  assert.match(custom.message, /OLLAMA_HOST/)
  const missing = ollamaUnreachable(DEFAULT_OLLAMA_URL, false)
  assert.equal(missing.kind, 'not-installed')
})

test('ollama: пульс, пока модель грузится, — до первого байта, обрыва или предела', () => {
  mock.timers.enable({ apis: ['setInterval', 'Date'] })
  try {
    // Первый байт: пульс останавливает pump.
    let beats = 0
    const stop = startHeartbeat({ beat: () => beats++, alive: () => true })
    mock.timers.tick(LOAD_HEARTBEAT_MS * 3)
    assert.equal(beats, 3, 'таймаут по тишине перезаводится, пока Ollama молчит')
    stop()
    mock.timers.tick(LOAD_HEARTBEAT_MS * 3)
    assert.equal(beats, 3)

    // Вопрос оборвали (seq сменился) — пульс гаснет сам.
    let alive = true
    let beats2 = 0
    startHeartbeat({ beat: () => beats2++, alive: () => alive })
    mock.timers.tick(LOAD_HEARTBEAT_MS)
    alive = false
    mock.timers.tick(LOAD_HEARTBEAT_MS * 5)
    assert.equal(beats2, 1)

    // По-настоящему зависший сервер: после предела пульса нет, и обычный таймаут его оборвёт.
    let beats3 = 0
    startHeartbeat({ beat: () => beats3++, alive: () => true })
    // Шагами: подменённые часы за один большой tick сразу уходят в конец.
    for (let t = 0; t < LOAD_HEARTBEAT_CAP_MS + LOAD_HEARTBEAT_MS * 10; t += LOAD_HEARTBEAT_MS) mock.timers.tick(LOAD_HEARTBEAT_MS)
    assert.equal(beats3, LOAD_HEARTBEAT_CAP_MS / LOAD_HEARTBEAT_MS - 1)
    assert.ok(LOAD_HEARTBEAT_CAP_MS >= 3 * 60_000 && LOAD_HEARTBEAT_CAP_MS <= 5 * 60_000)
  } finally {
    mock.timers.reset()
  }
})
