// src/main/llm/claudeCode.ts
import { query } from "@anthropic-ai/claude-agent-sdk";
var SYSTEM = `\u0422\u044B \u2014 \u0441\u0443\u0444\u043B\u0451\u0440 \u043D\u0430 \u0440\u0430\u0431\u043E\u0447\u0435\u043C \u0441\u043E\u0437\u0432\u043E\u043D\u0435. \u0422\u0435\u0431\u0435 \u043F\u0440\u0438\u0445\u043E\u0434\u0438\u0442 \u0440\u0430\u0441\u0448\u0438\u0444\u0440\u043E\u0432\u043A\u0430 \u0440\u0430\u0437\u0433\u043E\u0432\u043E\u0440\u0430;
\u0440\u0435\u043F\u043B\u0438\u043A\u0438 \u0441\u043E\u0431\u0435\u0441\u0435\u0434\u043D\u0438\u043A\u0430 \u043F\u043E\u043C\u0435\u0447\u0435\u043D\u044B [\u0421\u043E\u0431\u0435\u0441\u0435\u0434\u043D\u0438\u043A], \u0440\u0435\u043F\u043B\u0438\u043A\u0438 \u043F\u043E\u043B\u044C\u0437\u043E\u0432\u0430\u0442\u0435\u043B\u044F \u2014 [\u042F].

\u0422\u0432\u043E\u044F \u0437\u0430\u0434\u0430\u0447\u0430: \u0434\u0430\u0442\u044C \u043F\u043E\u043B\u044C\u0437\u043E\u0432\u0430\u0442\u0435\u043B\u044E \u0442\u043E, \u0447\u0442\u043E \u043E\u043D \u0441\u043A\u0430\u0436\u0435\u0442 \u0432\u0441\u043B\u0443\u0445 \u0441\u0432\u043E\u0438\u043C\u0438 \u0441\u043B\u043E\u0432\u0430\u043C\u0438.

\u041F\u0440\u0430\u0432\u0438\u043B\u0430:
- 3-5 \u043A\u043E\u0440\u043E\u0442\u043A\u0438\u0445 \u0442\u0435\u0437\u0438\u0441\u043E\u0432, \u043D\u0435 \u0430\u0431\u0437\u0430\u0446. \u041F\u0435\u0440\u0432\u044B\u0439 \u0442\u0435\u0437\u0438\u0441 \u2014 \u043F\u0440\u044F\u043C\u043E\u0439 \u043E\u0442\u0432\u0435\u0442 \u043D\u0430 \u0432\u043E\u043F\u0440\u043E\u0441.
- \u041F\u0438\u0448\u0438 \u043F\u043E-\u0440\u0443\u0441\u0441\u043A\u0438. \u0422\u0435\u0440\u043C\u0438\u043D\u044B \u0434\u043E\u043C\u0435\u043D\u0430 \u043E\u0441\u0442\u0430\u0432\u043B\u044F\u0439 \u043A\u0430\u043A \u0435\u0441\u0442\u044C.
- \u041D\u0435 \u0432\u044B\u0434\u0443\u043C\u044B\u0432\u0430\u0439 \u0446\u0438\u0444\u0440\u044B, \u043D\u0430\u0437\u0432\u0430\u043D\u0438\u044F \u0438 \u0441\u0440\u043E\u043A\u0438: \u043F\u043E\u043B\u044C\u0437\u043E\u0432\u0430\u0442\u0435\u043B\u044C \u043F\u0440\u043E\u0438\u0437\u043D\u0435\u0441\u0451\u0442 \u044D\u0442\u043E \u0432\u0441\u043B\u0443\u0445
  \u043F\u0435\u0440\u0435\u0434 \u043A\u043E\u043B\u043B\u0435\u0433\u0430\u043C\u0438. \u0415\u0441\u043B\u0438 \u0434\u0430\u043D\u043D\u044B\u0445 \u043D\u0435\u0442 \u2014 \u0442\u0430\u043A \u0438 \u0441\u043A\u0430\u0436\u0438 \u043E\u0434\u043D\u043E\u0439 \u0441\u0442\u0440\u043E\u043A\u043E\u0439.
- \u041D\u0438\u043A\u0430\u043A\u0438\u0445 \u0432\u0441\u0442\u0443\u043F\u043B\u0435\u043D\u0438\u0439, \u0432\u0435\u0436\u043B\u0438\u0432\u044B\u0445 \u043E\u0431\u043E\u0440\u043E\u0442\u043E\u0432 \u0438 \u0432\u0441\u0442\u0440\u0435\u0447\u043D\u044B\u0445 \u0432\u043E\u043F\u0440\u043E\u0441\u043E\u0432. \u0422\u043E\u043B\u044C\u043A\u043E \u0441\u0443\u0442\u044C.`;
var ClaudeCodeSuggester = class {
  session = null;
  pump = null;
  pending = [];
  current = null;
  loop = null;
  starting = null;
  get ready() {
    return this.session !== null;
  }
  /** Поднять сессию заранее — чтобы во время созвона не ждать десять секунд. */
  async warmup() {
    if (this.session) return;
    this.starting ??= this.start();
    await this.starting;
  }
  async start() {
    const self = this;
    async function* prompts() {
      while (true) {
        const msg = self.pending.length > 0 ? self.pending.shift() : await new Promise((r) => {
          self.pump = r;
        });
        if (msg === null) return;
        yield msg;
      }
    }
    this.session = query({
      prompt: prompts(),
      options: {
        systemPrompt: SYSTEM,
        // Инструменты, MCP и настройки проекта суфлёру не нужны, а каждый
        // пункт — это секунды на старте сессии.
        allowedTools: [],
        mcpServers: {},
        settingSources: [],
        permissionMode: "bypassPermissions",
        maxTurns: 1,
        includePartialMessages: true,
        // Внутри Electron process.execPath указывает на electron.exe, а не на
        // node.exe. SDK по умолчанию берёт его для запуска CLI — и тот молча
        // виснет, не выдавая ни ошибки, ни вывода. Поэтому явно требуем node,
        // а на случай, если всё же запустится electron.exe, включаем режим,
        // в котором он ведёт себя как node.
        executable: "node",
        env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
        // Без этого любая ошибка запуска остаётся невидимой.
        stderr: (data) => console.error("[claude-code]", data.trim())
      }
    });
    this.loop = this.consume();
  }
  async consume() {
    if (!this.session) return;
    let acc = "";
    try {
      for await (const ev of this.session) {
        const e = ev;
        if (e.type === "stream_event") {
          const d = e.event?.delta;
          if (d?.type === "text_delta" && d.text) {
            acc += d.text;
            this.current?.onDelta(d.text);
          }
          continue;
        }
        if (e.type === "result") {
          const done = this.current;
          const text = acc.trim() || (typeof e.result === "string" ? e.result : "");
          acc = "";
          this.current = null;
          if (done) {
            if (e.is_error) done.reject(new Error(text || "Claude Code \u0432\u0435\u0440\u043D\u0443\u043B \u043E\u0448\u0438\u0431\u043A\u0443"));
            else done.resolve(text);
          }
        }
      }
    } catch (err) {
      const done = this.current;
      this.current = null;
      this.session = null;
      this.starting = null;
      done?.reject(err instanceof Error ? err : new Error(String(err)));
    }
  }
  async ask(text, onDelta) {
    await this.warmup();
    if (this.current) throw new Error("\u041F\u0440\u0435\u0434\u044B\u0434\u0443\u0449\u0438\u0439 \u0437\u0430\u043F\u0440\u043E\u0441 \u0435\u0449\u0451 \u0432\u044B\u043F\u043E\u043B\u043D\u044F\u0435\u0442\u0441\u044F");
    return new Promise((resolve, reject) => {
      this.current = { text, onDelta, resolve, reject };
      const msg = {
        type: "user",
        message: { role: "user", content: [{ type: "text", text }] },
        parent_tool_use_id: null,
        session_id: ""
      };
      if (this.pump) {
        const p = this.pump;
        this.pump = null;
        p(msg);
      } else {
        this.pending.push(msg);
      }
    });
  }
  stop() {
    if (this.pump) {
      const p = this.pump;
      this.pump = null;
      p(null);
    } else {
      this.pending.push(null);
    }
    this.session = null;
    this.starting = null;
    this.current = null;
  }
};
export {
  ClaudeCodeSuggester
};
