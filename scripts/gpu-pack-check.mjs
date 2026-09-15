/**
 * Проверка перед сборкой установщика: пакет ускорения на видеокарте закреплён.
 *
 *   node scripts/gpu-pack-check.mjs
 *
 * Архив помощника пересобирается вместе с ним, и его sha256 и размер вписываются в
 * src/shared/gpuPack.ts (HELPER_ZIP_PIN) после сборки. С меткой вместо суммы приложение откажется
 * качать пакет у каждого пользователя — такой установщик выпускать нельзя.
 *
 * Node 22.18+ читает .ts сам, без сборки — как и тесты (tests/README.md).
 */
import { gpuPackProblems } from '../src/shared/gpuPack.ts'

const problems = gpuPackProblems()
if (problems.length) {
  console.error('Пакет ускорения на видеокарте не закреплён:')
  for (const p of problems) console.error(`  - ${p}`)
  console.error('Впишите sha256 и размер архива из релиза gpu-vulkan-v1 в HELPER_ZIP_PIN (src/shared/gpuPack.ts).')
  process.exit(1)
}
console.log('Пакет ускорения на видеокарте закреплён.')
