# Тесты

Запуск: `npm test`. Это встроенный раннер Node (`node --test`), без сборки и без зависимостей:
Node 24 сам срезает типы TypeScript и запускает `.ts` как есть.

Команда в package.json — `node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --test "tests/**/*.test.ts"`:

- глоб в кавычках раскрывает сам Node — одинаково в cmd, PowerShell и bash. Просто `node --test tests/` в Node 24 папку не обходит, а пытается запустить её как файл;
- в package.json нет `"type": "module"` (electron-vite собирает main в CommonJS), поэтому Node на каждом `.ts` с `import` предупреждает, что перечитал его как ES-модуль. Предупреждение безвредно — оно выключено флагом.

## Что можно тестировать

Только **чистые модули** — те, что не тянут electron и не выполняют ничего при импорте.
Сейчас это `src/shared/*` и в main: `llm/types.ts`, `llm/queue.ts`, `llm/jsonrpc.ts`, `context/extract.ts`
и `context/store.ts` (папку хранилищу передают снаружи, поэтому тест гоняет его на временной папке).
Разбор протоколов CLI (строки JSONL → события) кладите в такие же чистые модули рядом с
транспортом, например `src/main/llm/providers/codexProtocol.ts`, а процесс и electron —
в сам адаптер. Тогда разбор проверяется здесь без запуска CLI.

Правила для чистого модуля — иначе голый Node его не загрузит:

1. **Импорты значений — относительные и с расширением `.ts`**: `import { LlmError } from './types.ts'`.
   Псевдоним `@shared/...` Node не знает; расширение без `.ts` не находит. tsconfig разрешает
   такие импорты (`allowImportingTsExtensions`), electron-vite тоже.
   Импорт **только типов** (`import type { ... } from '@shared/providers'`) можно писать как угодно —
   Node вырезает его целиком.
2. **Только стираемый синтаксис TypeScript**: без `enum`, `namespace`, параметров-свойств в
   конструкторе (`constructor(private x: number)`), без `import x = require()`. Поля класса
   объявлять явно и присваивать в конструкторе.
3. **Никаких побочных эффектов при импорте**: не читать `app.getPath`, не запускать процессы.

## Соглашения

- Файл теста — `tests/<тема>.test.ts`, импорт тестируемого — `../src/....ts`.
- `node:test` и `node:assert/strict`. Таймеры — `mock.timers` из `node:test`, не настоящие ожидания.
- Названия тестов — по-русски, как комментарии в коде: что проверяется и почему это важно.
- tsconfig включает `tests/`, так что `npm run typecheck` проверяет и тесты.
