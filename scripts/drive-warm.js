// Сценарий для COPILOT_SHOT_JS: прогреть сессию и задать два вопроса подряд.
// Замеры смотрим в логе главного процесса — там печатается время ответа.
(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  console.log('[drive] прогрев')
  await window.copilot.warmupLlm()
  console.log('[drive] прогрет, вопрос 1')
  window.__copilotAsk('Чем регистр остатков отличается от оборотного?')
  await sleep(20000)
  console.log('[drive] вопрос 2')
  window.__copilotAsk('Почему план обмена, а не HTTP-сервис?')
  await sleep(20000)
  console.log('[drive] готово')
})()
