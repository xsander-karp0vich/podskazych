// podskazych-vk — отдельный процесс распознавания речи на видеокарте через Vulkan
// (whisper.cpp + ggml-vulkan). Нужен для AMD и Intel: путь CTranslate2 работает только
// на NVIDIA (CUDA), а на остальных картах сейчас остаётся процессор.
//
// Почему отдельный процесс, а не библиотека внутри Python: сбой драйвера (TDR, потеря
// устройства, abort внутри ggml) убивает только этот процесс, сайдкар видит обрыв трубы
// и переходит на процессорный путь.
//
// Почему stdin/stdout, а не whisper-server: у сервера CORS * и /load без токена, который
// при ошибке делает exit(1) — любая открытая в браузере страница могла бы уронить
// распознавание посреди созвона. Труба доступна только родителю.
//
// Почему всё передаётся по трубе, а не в командной строке: argv на Windows приходит в
// кодировке ANSI (cp1251), и кириллический путь к модели или подсказка ломаются или роняют
// процесс (проверено на whisper-cli и whisper-server). В argv — только ASCII-флаг
// --parent-pid.
//
// Протокол описан в README.md рядом.

#include <windows.h>
#include <delayimp.h>
#include <io.h>
#include <fcntl.h>
#include <intrin.h>

#include <algorithm>
#include <atomic>
#include <chrono>
#include <csignal>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <exception>
#include <map>
#include <mutex>
#include <string>
#include <vector>

// Только C API ядра Vulkan (без vulkan.hpp): у ggml-vulkan свой диспетчер vulkan.hpp,
// и второй экземпляр его настроек в этом файле дал бы нарушение ODR.
#include <vulkan/vulkan.h>

#include "ggml-backend.h"
#include "whisper.h"

namespace {

// ---------------------------------------------------------------------------
// Ограничения протокола
// ---------------------------------------------------------------------------

// Строка-заголовок больше 64 КБ — заведомо ошибка клиента (подсказка — не больше 223
// токенов), и читать её дальше значит позволить одной строке съесть память.
constexpr size_t kMaxHeaderBytes = 64 * 1024;
// Одна фраза сайдкара не длиннее 30 с; двойной запас на случай склейки, но не больше,
// чтобы ошибка в размере не заставила выделить гигабайты.
constexpr int64_t kMaxSamples = 30 * 16000 * 2;
// Предел поля samples, до которого лишний звук ещё вычитывается и пропускается (около
// 4 ГБ). Больше — заведомо испорченный заголовок: пропускать нечего, samples×4 ещё и
// переполнил бы счётчик. Такой поток считается рассинхронизированным (kExitDesync).
constexpr int64_t kMaxFrameSamples = (int64_t) 1 << 30;
// Вложенность объектов и массивов в неизвестных полях; глубже — ошибка разбора.
constexpr int kMaxJsonDepth = 32;
// Окно подсказки whisper: n_text_ctx/2 = 224, один слот занимает <|startofprev|>.
// Если отдать больше, whisper.cpp молча отрежет НАЧАЛО, а там у нас самые важные
// термины, поэтому лишнее отклоняем явно.
constexpr size_t kMaxPromptTokens = 223;
// Меньше 100 мс whisper не распознаёт (whisper_full_with_state выходит без сегментов),
// а при samples = 0 он ещё и не пересчитывает мел (src/whisper.cpp: n_samples > 0) и
// заново распознаёт звук прошлого вызова. Такие фрагменты до whisper_full не доходят.
constexpr size_t kMinSamples = 1600;

// ---------------------------------------------------------------------------
// Завершение процесса
// ---------------------------------------------------------------------------

// Коды выхода (описаны в README.md). 3 помощник не использует: так UCRT завершает abort(),
// если обработчик SIGABRT почему-то не сработал.
constexpr UINT kExitOk = 0;
constexpr UINT kExitException = 1;
constexpr UINT kExitUsage = 2;
constexpr UINT kExitStdoutClosed = 4;
constexpr UINT kExitParentGone = 5;
constexpr UINT kExitDesync = 6;
constexpr UINT kExitFatal = 7;

// Выходим через TerminateProcess, а не через return/exit: статические объекты
// ggml-vulkan разрушаются уже после выгрузки драйвера, и на части драйверов Windows это
// зависание или падение на выходе. Всё нужное (ответы) к этому моменту уже записано
// в трубу напрямую через WriteFile, буферов, которые надо сбросить, у протокола нет.
[[noreturn]] void hard_exit(UINT code) {
    fflush(stderr);
    TerminateProcess(GetCurrentProcess(), code);
    ExitProcess(code);  // на случай, если TerminateProcess почему-то вернулся
}

// Аварийный путь: пишем прямо в дескриптор stderr, минуя CRT (его блокировку может
// держать поток, на котором всё и сломалось), и сразу завершаемся.
void raw_stderr(const char * s) {
    HANDLE e = GetStdHandle(STD_ERROR_HANDLE);
    if (!s || e == nullptr || e == INVALID_HANDLE_VALUE) return;
    DWORD written = 0;
    WriteFile(e, s, (DWORD) strlen(s), &written, nullptr);
}

// GGML_ABORT и GGML_ASSERT (в том числе внутри ggml-vulkan после сбоя драйвера).
// Без обработчика ggml зовёт abort(), и код выхода не отличался бы от других падений.
void ggml_fatal(const char * message) {
    raw_stderr("podskazych-vk: аварийная остановка ggml: ");
    raw_stderr(message);
    raw_stderr("\n");
    TerminateProcess(GetCurrentProcess(), kExitFatal);
    ExitProcess(kExitFatal);
}

// abort() и std::terminate (исключение из деструктора, noexcept и т. п.).
void on_sigabrt(int) {
    raw_stderr("podskazych-vk: abort()\n");
    TerminateProcess(GetCurrentProcess(), kExitFatal);
    ExitProcess(kExitFatal);
}

// ---------------------------------------------------------------------------
// Вывод протокола
// ---------------------------------------------------------------------------

// Отдельная копия исходного stdout. Сам stdout процесса (fd 1 и STD_OUTPUT_HANDLE)
// перенаправляется в stderr: внутри whisper.cpp есть printf в stdout (print_realtime,
// отладка), и одна случайная строка сломала бы разбор протокола на стороне клиента.
HANDLE g_proto_out = INVALID_HANDLE_VALUE;

void proto_write_line(const std::string & line) {
    std::string buf = line;
    buf.push_back('\n');
    const char * p = buf.data();
    size_t left = buf.size();
    while (left > 0) {
        DWORD chunk = (DWORD) std::min<size_t>(left, 1 << 20);
        DWORD written = 0;
        if (!WriteFile(g_proto_out, p, chunk, &written, nullptr) || written == 0) {
            // Клиент закрыл свой конец трубы — отвечать больше некому.
            fprintf(stderr, "podskazych-vk: stdout закрыт (ошибка %lu), выходим\n", GetLastError());
            hard_exit(kExitStdoutClosed);
        }
        p += written;
        left -= written;
    }
    // WriteFile в анонимную трубу не буферизуется на нашей стороне: строка уже у клиента.
    // FlushFileBuffers здесь не нужен — на трубе он ждёт, пока клиент всё прочитает.
}

// ---------------------------------------------------------------------------
// JSON: кодировщик
// ---------------------------------------------------------------------------

// Текст токенов whisper — байты BPE: один русский символ может разрезаться между
// токенами, а maxTokens может оборвать фразу посреди символа. Невалидный UTF-8 в ответе
// уронил бы json.loads на стороне сайдкара, поэтому битые последовательности заменяем
// на U+FFFD, а корректный UTF-8 выводим как есть.
size_t utf8_valid_len(const unsigned char * s, size_t n) {
    unsigned char c = s[0];
    if (c < 0x80) return 1;
    size_t need;
    unsigned char lo = 0x80, hi = 0xBF;
    if (c >= 0xC2 && c <= 0xDF) { need = 1; }
    else if (c == 0xE0) { need = 2; lo = 0xA0; }
    else if ((c >= 0xE1 && c <= 0xEC) || c == 0xEE || c == 0xEF) { need = 2; }
    else if (c == 0xED) { need = 2; hi = 0x9F; }  // без суррогатов
    else if (c == 0xF0) { need = 3; lo = 0x90; }
    else if (c >= 0xF1 && c <= 0xF3) { need = 3; }
    else if (c == 0xF4) { need = 3; hi = 0x8F; }
    else return 0;
    if (n < need + 1) return 0;
    if (s[1] < lo || s[1] > hi) return 0;
    for (size_t i = 2; i <= need; ++i) {
        if (s[i] < 0x80 || s[i] > 0xBF) return 0;
    }
    return need + 1;
}

// Обрыв декодера на лимите токенов (maxTokens или зацикливание до n_text_ctx) оставляет
// в самом конце начало многобайтного символа. Это обрезка, а не мусор в тексте, поэтому
// такой хвост отбрасываем, а не превращаем в U+FFFD.
void trim_incomplete_utf8_tail(std::string & s) {
    const size_t n = s.size();
    size_t cont = 0;  // байты продолжения 10xxxxxx в конце
    while (cont < 3 && cont < n && ((unsigned char) s[n - 1 - cont] & 0xC0) == 0x80) ++cont;
    if (cont == n) return;
    const size_t lead = n - 1 - cont;
    const unsigned char c = (unsigned char) s[lead];
    size_t need;
    unsigned char lo = 0x80, hi = 0xBF;
    if (c >= 0xC2 && c <= 0xDF) { need = 1; }
    else if (c == 0xE0) { need = 2; lo = 0xA0; }
    else if ((c >= 0xE1 && c <= 0xEC) || c == 0xEE || c == 0xEF) { need = 2; }
    else if (c == 0xED) { need = 2; hi = 0x9F; }
    else if (c == 0xF0) { need = 3; lo = 0x90; }
    else if (c >= 0xF1 && c <= 0xF3) { need = 3; }
    else if (c == 0xF4) { need = 3; hi = 0x8F; }
    else return;          // не начало многобайтного символа
    if (cont >= need) return;  // символ полный (или лишние байты) — решит json_escape_into
    if (cont >= 1 && ((unsigned char) s[lead + 1] < lo || (unsigned char) s[lead + 1] > hi)) return;
    s.resize(lead);
}

void json_escape_into(std::string & out, const std::string & s) {
    static const char * hex = "0123456789abcdef";
    const unsigned char * p = (const unsigned char *) s.data();
    size_t n = s.size();
    size_t i = 0;
    while (i < n) {
        unsigned char c = p[i];
        if (c < 0x80) {
            switch (c) {
                case '"':  out += "\\\""; break;
                case '\\': out += "\\\\"; break;
                case '\n': out += "\\n";  break;
                case '\r': out += "\\r";  break;
                case '\t': out += "\\t";  break;
                case '\b': out += "\\b";  break;
                case '\f': out += "\\f";  break;
                default:
                    if (c < 0x20 || c == 0x7F) {
                        out += "\\u00";
                        out.push_back(hex[c >> 4]);
                        out.push_back(hex[c & 0xF]);
                    } else {
                        out.push_back((char) c);
                    }
            }
            ++i;
            continue;
        }
        size_t len = utf8_valid_len(p + i, n - i);
        if (len == 0) {
            out += "\xEF\xBF\xBD";
            ++i;
        } else {
            out.append((const char *) p + i, len);
            i += len;
        }
    }
}

// Плоский объект ответа: ключи — ASCII-литералы из этого файла.
class JsonWriter {
public:
    JsonWriter() : s_("{") {}
    JsonWriter & str(const char * key, const std::string & v) {
        this->key(key);
        s_.push_back('"');
        json_escape_into(s_, v);
        s_.push_back('"');
        return *this;
    }
    JsonWriter & num(const char * key, int64_t v) {
        this->key(key);
        s_ += std::to_string(v);
        return *this;
    }
    JsonWriter & real(const char * key, double v) {
        this->key(key);
        char buf[64];
        snprintf(buf, sizeof(buf), "%.1f", v);
        s_ += buf;
        return *this;
    }
    JsonWriter & boolean(const char * key, bool v) {
        this->key(key);
        s_ += v ? "true" : "false";
        return *this;
    }
    // Готовый JSON-фрагмент (массив устройств).
    JsonWriter & raw(const char * key, const std::string & v) {
        this->key(key);
        s_ += v;
        return *this;
    }
    std::string done() const { return s_ + "}"; }

private:
    void key(const char * k) {
        if (!first_) s_.push_back(',');
        first_ = false;
        s_.push_back('"');
        s_ += k;
        s_ += "\":";
    }
    std::string s_;
    bool first_ = true;
};

void send_error(const char * code, const std::string & message, bool has_id = false, int64_t id = 0) {
    JsonWriter w;
    w.str("type", "error");
    if (has_id) w.num("id", id);
    if (code) w.str("code", code);
    w.str("message", message);
    proto_write_line(w.done());
}

// ---------------------------------------------------------------------------
// JSON: разборщик плоских сообщений
// ---------------------------------------------------------------------------

// Полноценная библиотека JSON ради пяти плоских сообщений не нужна, но разбор обязан
// быть строгим: неверный JSON даёт ответ-ошибку, а не падение или чтение за границей
// буфера. При этом любой КОРРЕКТНЫЙ JSON разбирается целиком: пакет GPU скачивается
// отдельно от приложения, и новое поле сайдкара (дробное число, объект, массив строк)
// не должно ломать старого помощника. Неподходящий тип отвергают только get_*.
struct JsonValue {
    enum class Kind {
        Null,
        Bool,
        Int,       // целое в пределах int64
        Number,    // дробное, с экспонентой или вне int64 — значение не хранится
        String,
        IntArray,  // массив только из целых (в том числе пустой)
        Array,     // любой другой массив — содержимое не хранится
        Object,    // вложенный объект — содержимое не хранится
    } kind = Kind::Null;
    bool b = false;
    int64_t i = 0;
    std::string s;
    std::vector<int64_t> arr;
};

using JsonObject = std::map<std::string, JsonValue>;

class JsonParser {
public:
    JsonParser(const char * data, size_t size) : p_(data), end_(data + size) {}

    bool parse(JsonObject & out, std::string & err) {
        skip_ws();
        if (!eat('{')) return fail(err, "ожидался объект JSON");
        skip_ws();
        if (eat('}')) return finish(err);
        for (;;) {
            skip_ws();
            std::string key;
            if (!parse_string(key, err)) return false;
            skip_ws();
            if (!eat(':')) return fail(err, "ожидалось ':' после ключа");
            skip_ws();
            JsonValue v;
            if (!parse_value(v, err)) return false;
            if (out.count(key)) return fail(err, "повторяется ключ \"" + key + "\"");
            out.emplace(std::move(key), std::move(v));
            skip_ws();
            if (eat(',')) continue;
            if (eat('}')) return finish(err);
            return fail(err, "ожидалось ',' или '}'");
        }
    }

private:
    bool finish(std::string & err) {
        skip_ws();
        if (p_ != end_) return fail(err, "лишние символы после объекта");
        return true;
    }

    static bool fail(std::string & err, const std::string & msg) {
        err = msg;
        return false;
    }

    void skip_ws() {
        while (p_ < end_ && (*p_ == ' ' || *p_ == '\t' || *p_ == '\r' || *p_ == '\n')) ++p_;
    }

    bool eat(char c) {
        if (p_ < end_ && *p_ == c) {
            ++p_;
            return true;
        }
        return false;
    }

    bool literal(const char * word) {
        size_t n = strlen(word);
        if ((size_t) (end_ - p_) >= n && memcmp(p_, word, n) == 0) {
            p_ += n;
            return true;
        }
        return false;
    }

    bool parse_value(JsonValue & v, std::string & err, int depth = 0) {
        if (p_ >= end_) return fail(err, "обрыв строки на месте значения");
        char c = *p_;
        if (c == '"') {
            v.kind = JsonValue::Kind::String;
            return parse_string(v.s, err);
        }
        if (c == 't') {
            if (!literal("true")) return fail(err, "неверный литерал");
            v.kind = JsonValue::Kind::Bool;
            v.b = true;
            return true;
        }
        if (c == 'f') {
            if (!literal("false")) return fail(err, "неверный литерал");
            v.kind = JsonValue::Kind::Bool;
            v.b = false;
            return true;
        }
        if (c == 'n') {
            if (!literal("null")) return fail(err, "неверный литерал");
            v.kind = JsonValue::Kind::Null;
            return true;
        }
        if (c == '-' || (c >= '0' && c <= '9')) {
            return parse_number(v, err);
        }
        if (c == '[' || c == '{') {
            if (depth >= kMaxJsonDepth) return fail(err, "слишком глубокая вложенность");
        }
        if (c == '[') {
            ++p_;
            v.kind = JsonValue::Kind::IntArray;
            skip_ws();
            if (eat(']')) return true;
            for (;;) {
                skip_ws();
                JsonValue item;
                if (!parse_value(item, err, depth + 1)) return false;
                if (v.kind == JsonValue::Kind::IntArray) {
                    if (item.kind == JsonValue::Kind::Int) {
                        // Массив на миллионы элементов в 64 КБ не поместится: длина строки
                        // уже ограничена.
                        v.arr.push_back(item.i);
                    } else {
                        v.kind = JsonValue::Kind::Array;
                        v.arr.clear();
                    }
                }
                skip_ws();
                if (eat(',')) continue;
                if (eat(']')) return true;
                return fail(err, "ожидалось ',' или ']' в массиве");
            }
        }
        if (c == '{') {
            ++p_;
            v.kind = JsonValue::Kind::Object;
            skip_ws();
            if (eat('}')) return true;
            for (;;) {
                skip_ws();
                std::string key;
                if (!parse_string(key, err)) return false;
                skip_ws();
                if (!eat(':')) return fail(err, "ожидалось ':' после ключа");
                skip_ws();
                JsonValue item;
                if (!parse_value(item, err, depth + 1)) return false;
                skip_ws();
                if (eat(',')) continue;
                if (eat('}')) return true;
                return fail(err, "ожидалось ',' или '}'");
            }
        }
        return fail(err, "неизвестное значение");
    }

    // Число по грамматике JSON: -?(0|[1-9][0-9]*)(\.[0-9]+)?([eE][+-]?[0-9]+)?
    // Целое в пределах int64 — Kind::Int, любое другое корректное — Kind::Number.
    bool parse_number(JsonValue & v, std::string & err) {
        bool neg = eat('-');
        if (p_ >= end_ || *p_ < '0' || *p_ > '9') return fail(err, "ожидалась цифра");
        if (*p_ == '0' && p_ + 1 < end_ && p_[1] >= '0' && p_[1] <= '9') {
            return fail(err, "ведущие нули в числе");
        }
        uint64_t acc = 0;
        bool fits = true;
        const uint64_t limit = neg ? (uint64_t) INT64_MAX + 1 : (uint64_t) INT64_MAX;
        while (p_ < end_ && *p_ >= '0' && *p_ <= '9') {
            uint64_t d = (uint64_t) (*p_ - '0');
            if (fits && acc > (limit - d) / 10) fits = false;
            if (fits) acc = acc * 10 + d;
            ++p_;
        }
        bool integer = true;
        if (eat('.')) {
            integer = false;
            if (p_ >= end_ || *p_ < '0' || *p_ > '9') return fail(err, "ожидалась цифра после точки");
            while (p_ < end_ && *p_ >= '0' && *p_ <= '9') ++p_;
        }
        if (p_ < end_ && (*p_ == 'e' || *p_ == 'E')) {
            integer = false;
            ++p_;
            if (p_ < end_ && (*p_ == '+' || *p_ == '-')) ++p_;
            if (p_ >= end_ || *p_ < '0' || *p_ > '9') return fail(err, "ожидалась цифра в экспоненте");
            while (p_ < end_ && *p_ >= '0' && *p_ <= '9') ++p_;
        }
        if (!integer || !fits) {
            v.kind = JsonValue::Kind::Number;
            return true;
        }
        v.kind = JsonValue::Kind::Int;
        if (neg) {
            v.i = acc == (uint64_t) INT64_MAX + 1 ? INT64_MIN : -(int64_t) acc;
        } else {
            v.i = (int64_t) acc;
        }
        return true;
    }

    static int hex_val(char c) {
        if (c >= '0' && c <= '9') return c - '0';
        if (c >= 'a' && c <= 'f') return c - 'a' + 10;
        if (c >= 'A' && c <= 'F') return c - 'A' + 10;
        return -1;
    }

    bool parse_hex4(uint32_t & out, std::string & err) {
        if (end_ - p_ < 4) return fail(err, "обрыв \\u-последовательности");
        uint32_t v = 0;
        for (int k = 0; k < 4; ++k) {
            int h = hex_val(p_[k]);
            if (h < 0) return fail(err, "неверная \\u-последовательность");
            v = (v << 4) | (uint32_t) h;
        }
        p_ += 4;
        out = v;
        return true;
    }

    static void append_utf8(std::string & s, uint32_t cp) {
        if (cp < 0x80) {
            s.push_back((char) cp);
        } else if (cp < 0x800) {
            s.push_back((char) (0xC0 | (cp >> 6)));
            s.push_back((char) (0x80 | (cp & 0x3F)));
        } else if (cp < 0x10000) {
            s.push_back((char) (0xE0 | (cp >> 12)));
            s.push_back((char) (0x80 | ((cp >> 6) & 0x3F)));
            s.push_back((char) (0x80 | (cp & 0x3F)));
        } else {
            s.push_back((char) (0xF0 | (cp >> 18)));
            s.push_back((char) (0x80 | ((cp >> 12) & 0x3F)));
            s.push_back((char) (0x80 | ((cp >> 6) & 0x3F)));
            s.push_back((char) (0x80 | (cp & 0x3F)));
        }
    }

    bool parse_string(std::string & out, std::string & err) {
        if (!eat('"')) return fail(err, "ожидалась строка");
        out.clear();
        while (p_ < end_) {
            unsigned char c = (unsigned char) *p_++;
            if (c == '"') return true;
            if (c < 0x20) return fail(err, "управляющий символ внутри строки");
            if (c != '\\') {
                out.push_back((char) c);
                continue;
            }
            if (p_ >= end_) break;
            char e = *p_++;
            switch (e) {
                case '"':  out.push_back('"');  break;
                case '\\': out.push_back('\\'); break;
                case '/':  out.push_back('/');  break;
                case 'b':  out.push_back('\b'); break;
                case 'f':  out.push_back('\f'); break;
                case 'n':  out.push_back('\n'); break;
                case 'r':  out.push_back('\r'); break;
                case 't':  out.push_back('\t'); break;
                case 'u': {
                    uint32_t cp = 0;
                    if (!parse_hex4(cp, err)) return false;
                    if (cp >= 0xD800 && cp <= 0xDBFF) {
                        if (!(end_ - p_ >= 2 && p_[0] == '\\' && p_[1] == 'u')) {
                            return fail(err, "одиночный старший суррогат в \\u");
                        }
                        p_ += 2;
                        uint32_t lo = 0;
                        if (!parse_hex4(lo, err)) return false;
                        if (lo < 0xDC00 || lo > 0xDFFF) return fail(err, "неверная суррогатная пара в \\u");
                        cp = 0x10000 + ((cp - 0xD800) << 10) + (lo - 0xDC00);
                    } else if (cp >= 0xDC00 && cp <= 0xDFFF) {
                        return fail(err, "одиночный младший суррогат в \\u");
                    }
                    if (cp == 0) return fail(err, "символ \\u0000 в строке не допускается");
                    append_utf8(out, cp);
                    break;
                }
                default:
                    return fail(err, "неизвестная escape-последовательность");
            }
        }
        return fail(err, "незакрытая строка");
    }

    const char * p_;
    const char * end_;
};

// Достаём поля с проверкой типа. Отсутствующее поле — значение по умолчанию.
enum class Field { Missing, Ok, WrongType };

Field get_int(const JsonObject & o, const char * key, int64_t & out) {
    auto it = o.find(key);
    if (it == o.end() || it->second.kind == JsonValue::Kind::Null) return Field::Missing;
    if (it->second.kind != JsonValue::Kind::Int) return Field::WrongType;
    out = it->second.i;
    return Field::Ok;
}

Field get_bool(const JsonObject & o, const char * key, bool & out) {
    auto it = o.find(key);
    if (it == o.end() || it->second.kind == JsonValue::Kind::Null) return Field::Missing;
    if (it->second.kind != JsonValue::Kind::Bool) return Field::WrongType;
    out = it->second.b;
    return Field::Ok;
}

Field get_str(const JsonObject & o, const char * key, std::string & out) {
    auto it = o.find(key);
    if (it == o.end() || it->second.kind == JsonValue::Kind::Null) return Field::Missing;
    if (it->second.kind != JsonValue::Kind::String) return Field::WrongType;
    out = it->second.s;
    return Field::Ok;
}

Field get_int_array(const JsonObject & o, const char * key, std::vector<int64_t> & out) {
    auto it = o.find(key);
    if (it == o.end() || it->second.kind == JsonValue::Kind::Null) return Field::Missing;
    if (it->second.kind != JsonValue::Kind::IntArray) return Field::WrongType;
    out = it->second.arr;
    return Field::Ok;
}

// ---------------------------------------------------------------------------
// Чтение stdin
// ---------------------------------------------------------------------------

// Читаем HANDLE напрямую, а не через CRT: заголовок и следом float32-отсчёты идут одним
// потоком, и нужно точно знать, где кончилась строка и начались байты звука.
class Input {
public:
    explicit Input(HANDLE h) : h_(h) { is_pipe_ = GetFileType(h) == FILE_TYPE_PIPE; }

    enum class Line { Ok, Eof, TooLong };

    // Строка до '\n' (сам '\n' и '\r' перед ним отбрасываются). Слишком длинная строка
    // дочитывается до конца и выбрасывается, чтобы поток не рассинхронизировался.
    Line read_line(std::string & out) {
        out.clear();
        bool too_long = false;
        for (;;) {
            if (pos_ >= len_ && !fill()) {
                return (out.empty() && !too_long) ? Line::Eof : (too_long ? Line::TooLong : Line::Ok);
            }
            const char * start = buf_ + pos_;
            const char * nl = (const char *) memchr(start, '\n', len_ - pos_);
            size_t take = nl ? (size_t) (nl - start) : len_ - pos_;
            if (!too_long) {
                if (out.size() + take > kMaxHeaderBytes) {
                    too_long = true;
                    out.clear();
                } else {
                    out.append(start, take);
                }
            }
            pos_ += take;
            if (nl) {
                ++pos_;
                if (too_long) return Line::TooLong;
                if (!out.empty() && out.back() == '\r') out.pop_back();
                return Line::Ok;
            }
        }
    }

    bool read_exact(char * dst, size_t n) {
        while (n > 0) {
            if (pos_ >= len_ && !fill()) return false;
            size_t take = std::min(n, len_ - pos_);
            memcpy(dst, buf_ + pos_, take);
            pos_ += take;
            dst += take;
            n -= take;
        }
        return true;
    }

    bool skip(uint64_t n) {
        while (n > 0) {
            if (pos_ >= len_ && !fill()) return false;
            size_t take = (size_t) std::min<uint64_t>(n, len_ - pos_);
            pos_ += take;
            n -= take;
        }
        return true;
    }

private:
    bool fill() {
        for (;;) {
            DWORD got = 0;
            if (!ReadFile(h_, buf_, sizeof(buf_), &got, nullptr)) return false;  // ERROR_BROKEN_PIPE = EOF
            if (got > 0) {
                pos_ = 0;
                len_ = got;
                return true;
            }
            // Нулевое чтение из файла — конец; из трубы бывает при пустой записи клиента.
            if (!is_pipe_) return false;
        }
    }

    HANDLE h_;
    bool is_pipe_ = false;
    char buf_[1 << 16];
    size_t pos_ = 0;
    size_t len_ = 0;
};

// ---------------------------------------------------------------------------
// Окружение: процессор, загрузчик Vulkan, родитель
// ---------------------------------------------------------------------------

// ggml-cpu собран с AVX2/FMA/F16C/BMI2 (GGML_NATIVE=OFF включает их по умолчанию, и
// в сборке они заданы явно). На процессоре без них первая же операция ggml-cpu — это
// "illegal instruction" без внятной причины, поэтому проверяем заранее и не трогаем ggml.
bool cpu_supported() {
    int r[4] = {0};
    __cpuid(r, 0);
    if (r[0] < 7) return false;
    __cpuid(r, 1);
    const bool fma = (r[2] & (1 << 12)) != 0;
    const bool osxsave = (r[2] & (1 << 27)) != 0;
    const bool avx = (r[2] & (1 << 28)) != 0;
    const bool f16c = (r[2] & (1 << 29)) != 0;
    if (!(fma && osxsave && avx && f16c)) return false;
    // ОС должна сохранять регистры YMM при переключении потоков
    if ((_xgetbv(0) & 6) != 6) return false;
    __cpuidex(r, 7, 0);
    const bool avx2 = (r[1] & (1 << 5)) != 0;
    const bool bmi2 = (r[1] & (1 << 8)) != 0;
    return avx2 && bmi2;
}

// vulkan-1.dll ставит драйвер видеокарты. Библиотека подключена отложенно
// (/DELAYLOAD), иначе без неё exe вообще не запустится и вместо понятного hello клиент
// получит системную ошибку загрузчика. Грузим строго из System32: копия рядом с exe
// или в текущей папке могла бы подменить загрузчик.
//
// Одного наличия библиотеки мало: exe импортирует из неё и функции Vulkan 1.1
// (vkGetPhysicalDeviceFeatures2), которых нет в загрузчике 1.0 от старого драйвера.
// Отложенный импорт такой функции при первом вызове бросает SEH-исключение 0xC06D007F,
// catch(...) под /EHsc его не ловит, и процесс упал бы до hello. Поэтому все отложенные
// импорты связываем заранее, под __try. Функция без C++-объектов: __try нельзя
// смешивать с раскруткой деструкторов.
bool bind_vulkan_imports() {
    HRESULT hr = E_FAIL;
    __try {
        hr = __HrLoadAllImportsForDll("vulkan-1.dll");
    } __except (EXCEPTION_EXECUTE_HANDLER) {
        hr = E_FAIL;
    }
    return SUCCEEDED(hr);
}

bool load_vulkan_loader() {
    HMODULE h = LoadLibraryExW(L"vulkan-1.dll", nullptr, LOAD_LIBRARY_SEARCH_SYSTEM32);
    if (h == nullptr) return false;
    // Модуль уже загружен из System32, и помощник отложенной загрузки получит именно его.
    if (!bind_vulkan_imports()) {
        fprintf(stderr, "podskazych-vk: vulkan-1.dll без нужных функций (загрузчик Vulkan старше 1.1)\n");
        return false;
    }
    return true;
}

DWORD WINAPI parent_watch_thread(LPVOID param) {
    HANDLE h = (HANDLE) param;
    WaitForSingleObject(h, INFINITE);
    fprintf(stderr, "podskazych-vk: родительский процесс завершился, выходим\n");
    hard_exit(kExitParentGone);
}

// Electron останавливает python.exe через TerminateProcess, atexit в Python не
// выполняется, и без этой проверки помощник остался бы жить, держа видеопамять.
// Главный поток может минутами сидеть в whisper_full или в компиляции шейдеров,
// поэтому смотрим за родителем отдельным потоком.
bool start_parent_watch(DWORD pid) {
    HANDLE h = OpenProcess(SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
    if (!h) {
        fprintf(stderr, "podskazych-vk: родитель %lu не найден (ошибка %lu)\n", pid, GetLastError());
        return false;
    }
    // PID мог освободиться и достаться другому процессу, пока нас запускали. Настоящий
    // родитель создан раньше нас, так что более поздний процесс с этим PID — чужой.
    FILETIME pc{}, pe{}, pk{}, pu{};
    FILETIME sc{}, se{}, sk{}, su{};
    if (GetProcessTimes(h, &pc, &pe, &pk, &pu) && GetProcessTimes(GetCurrentProcess(), &sc, &se, &sk, &su)) {
        if (CompareFileTime(&pc, &sc) > 0) {
            fprintf(stderr, "podskazych-vk: PID %lu принадлежит процессу младше нас, родителя уже нет\n", pid);
            CloseHandle(h);
            return false;
        }
    }
    HANDLE t = CreateThread(nullptr, 0, parent_watch_thread, h, 0, nullptr);
    if (!t) {
        fprintf(stderr, "podskazych-vk: не удалось запустить наблюдение за родителем\n");
        return false;
    }
    CloseHandle(t);
    return true;
}

// ---------------------------------------------------------------------------
// Логи whisper/ggml
// ---------------------------------------------------------------------------

// Пока идёт загрузка модели, ищем в логе признаки того, что видеокарта не поднялась.
// whisper.cpp в этом случае молча продолжает на процессоре, а нам нужен именно отказ:
// медленная загрузка «на GPU», которая на деле идёт на CPU, хуже честной ошибки.
std::atomic<bool> g_watch_load_log{false};
std::atomic<bool> g_gpu_init_failed{false};

// Во время первого перечисления устройств ggml-vulkan пишет отладочную строку на каждое
// устройство: «ggml_vulkan: N = <имя> (<драйвер>) | uma: … | fp16: … | int dot: … |
// matrix cores: …». Это ровно то, что ggml решил использовать, поэтому по ней сверяем
// собственные сведения из Vulkan (attach_vulkan_details). Ключ — индекс устройства
// внутри бэкенда Vulkan.
std::atomic<bool> g_capture_vk_info{false};
std::mutex g_vk_info_mutex;
std::map<int, std::string> g_vk_info_lines;

void capture_vk_info_line(const char * text) {
    static const char kPrefix[] = "ggml_vulkan: ";
    if (strncmp(text, kPrefix, sizeof(kPrefix) - 1) != 0) return;
    const char * p = text + sizeof(kPrefix) - 1;
    if (*p < '0' || *p > '9') return;
    char * end = nullptr;
    const long idx = strtol(p, &end, 10);
    if (!end || strncmp(end, " = ", 3) != 0 || idx < 0 || idx > 1024) return;
    std::string rest(end + 3);
    while (!rest.empty() && (rest.back() == '\n' || rest.back() == '\r')) rest.pop_back();
    std::lock_guard<std::mutex> lock(g_vk_info_mutex);
    g_vk_info_lines[(int) idx] = rest;
}

void log_callback(enum ggml_log_level level, const char * text, void * /*user*/) {
    if (!text) return;
    if (g_watch_load_log.load() &&
        (strstr(text, "whisper_backend_init_gpu: no GPU found") ||
         strstr(text, "whisper_backend_init_gpu: failed to initialize"))) {
        g_gpu_init_failed.store(true);
    }
    if (g_capture_vk_info.load()) {
        try {
            capture_vk_info_line(text);
        } catch (...) {
            // сверка — необязательная часть, без неё сведения просто не подтверждены
        }
    }
    if (level == GGML_LOG_LEVEL_DEBUG) return;
    fputs(text, stderr);
}

// ---------------------------------------------------------------------------
// Устройства
// ---------------------------------------------------------------------------

// Сведения о физическом устройстве из собственного запроса к Vulkan (vk_query_devices).
struct VkDetails {
    std::string name;
    std::string driver_name;
    std::string driver_info;
    // "dddd:bb:dd.f" — в том же виде, что ggml_backend_vk_get_device_pci_id; пусто без
    // VK_EXT_pci_bus_info.
    std::string pci;
    uint32_t type = VK_PHYSICAL_DEVICE_TYPE_OTHER;
    uint32_t vendor_id = 0;
    uint32_t device_id = 0;
    uint32_t driver_id = 0;
    uint32_t driver_version = 0;
    uint32_t api_version = 0;
    uint8_t uuid[VK_UUID_SIZE] = {};
    uint8_t luid[VK_LUID_SIZE] = {};
    bool luid_valid = false;
    bool has_driver_props = false;
    bool storage16 = false;  // условие ggml_vk_device_is_supported
    bool uma = false;
    bool coopmat = false;
    bool coopmat2 = false;
    bool integer_dot_product = false;
    bool fp16 = false;
    const char * architecture = "other";
};

struct DeviceInfo {
    int index = 0;  // тот же счёт, что gpu_device в whisper_context_params
    int vk_index = -1;  // номер внутри бэкенда Vulkan (порядок vk_instance.device_indices)
    std::string name;
    std::string type;  // discrete | integrated | other
    std::string pci;   // props.device_id ggml, может быть пустым
    int64_t vram_mb = 0;
    int64_t free_mb = 0;
    bool has_details = false;
    VkDetails vk;
};

bool g_cpu_ok = false;
bool g_vulkan_loader = false;

std::vector<DeviceInfo> list_devices() {
    std::vector<DeviceInfo> out;
    if (!g_cpu_ok || !g_vulkan_loader) return out;
    // whisper_backend_init_gpu считает gpu_device среди устройств типа GPU и IGPU в порядке
    // реестра ggml, поэтому индекс считаем точно так же, иначе загрузится не та карта.
    int counter = 0;
    int vk_counter = 0;
    const size_t n = ggml_backend_dev_count();
    for (size_t i = 0; i < n; ++i) {
        ggml_backend_dev_t dev = ggml_backend_dev_get(i);
        const enum ggml_backend_dev_type t = ggml_backend_dev_type(dev);
        if (t != GGML_BACKEND_DEVICE_TYPE_GPU && t != GGML_BACKEND_DEVICE_TYPE_IGPU) continue;
        const int index = counter++;
        ggml_backend_reg_t reg = ggml_backend_dev_backend_reg(dev);
        const char * reg_name = reg ? ggml_backend_reg_name(reg) : nullptr;
        if (!reg_name || strcmp(reg_name, "Vulkan") != 0) continue;

        ggml_backend_dev_props props{};
        ggml_backend_dev_get_props(dev, &props);

        DeviceInfo d;
        d.index = index;
        // У бэкенда Vulkan устройства типа GPU и IGPU идут подряд в порядке device_indices.
        d.vk_index = vk_counter++;
        d.pci = props.device_id ? props.device_id : "";
        d.name = props.description ? props.description : (props.name ? props.name : "");
        d.type = t == GGML_BACKEND_DEVICE_TYPE_GPU ? "discrete" : "integrated";
        // Vulkan поверх Direct3D 12 (Mesa Dozen из «пакета совместимости OpenCL/OpenGL/Vulkan»)
        // выдаёт себя за ту же видеокарту, но медленный и неполный. Выбирать его сами не
        // будем, только если клиент явно укажет индекс.
        if (d.name.find("Direct3D12") != std::string::npos || d.name.find("Microsoft Basic Render") != std::string::npos) {
            d.type = "other";
        }
        d.vram_mb = (int64_t) (props.memory_total / (1024 * 1024));
        d.free_mb = (int64_t) (props.memory_free / (1024 * 1024));
        out.push_back(std::move(d));
    }
    return out;
}

// ---------------------------------------------------------------------------
// Подробности устройств: прямые вызовы Vulkan
// ---------------------------------------------------------------------------

// Имени устройства сайдкару мало. Включать ли flash attention, зависит от вендора,
// драйвера и поколения карты: у фирменного драйвера AMD на GCN/RDNA1/RDNA2 свой путь
// шейдеров FA (флаг old_amd_windows в ggml-vulkan) с известными ошибками, а по имени
// «AMD Radeon(TM) Graphics» не отличить 680M от 780M. ggml-vulkan эти сведения наружу не
// отдаёт, поэтому спрашиваем драйвер сами, отдельным экземпляром Vulkan, и повторяем те же
// проверки, что делает ggml (whisper.cpp v1.9.4, ggml-vulkan.cpp: get_device_architecture,
// ggml_vk_print_gpu_info, ggml_vk_khr_cooperative_matrix_support): сайдкару нужно то, что
// ggml реально будет использовать, а не просто список расширений драйвера.

constexpr uint32_t kVendorAmd = 0x1002;
constexpr uint32_t kVendorIntel = 0x8086;
constexpr uint32_t kVendorNvidia = 0x10DE;
constexpr uint32_t kVendorQualcomm = 0x5143;

bool env_set(const char * name) {
    return getenv(name) != nullptr;
}

uint32_t api_major_minor(uint32_t v) {
    return VK_MAKE_API_VERSION(0, VK_API_VERSION_MAJOR(v), VK_API_VERSION_MINOR(v), 0);
}

// Звено цепочки pNext. Структуры заранее обнулены, sType выставлен.
class PNextChain {
public:
    explicit PNextChain(void * head) : last_((VkBaseOutStructure *) head) {}
    void add(void * s) {
        auto * b = (VkBaseOutStructure *) s;
        b->pNext = nullptr;
        last_->pNext = b;
        last_ = b;
    }

private:
    VkBaseOutStructure * last_;
};

std::string fixed_str(const char * s, size_t cap) {
    return std::string(s, strnlen(s, cap));
}

void query_one_device(VkPhysicalDevice pd, VkDetails & d) {
    VkPhysicalDeviceProperties p{};
    vkGetPhysicalDeviceProperties(pd, &p);
    d.name = fixed_str(p.deviceName, VK_MAX_PHYSICAL_DEVICE_NAME_SIZE);
    d.type = (uint32_t) p.deviceType;
    d.vendor_id = p.vendorID;
    d.device_id = p.deviceID;
    d.driver_version = p.driverVersion;
    d.api_version = p.apiVersion;
    d.uma = p.deviceType == VK_PHYSICAL_DEVICE_TYPE_INTEGRATED_GPU;

    std::vector<VkExtensionProperties> exts;
    for (int attempt = 0; attempt < 4; ++attempt) {
        uint32_t count = 0;
        if (vkEnumerateDeviceExtensionProperties(pd, nullptr, &count, nullptr) != VK_SUCCESS) break;
        exts.assign(count, VkExtensionProperties{});
        const VkResult r = vkEnumerateDeviceExtensionProperties(pd, nullptr, &count, exts.data());
        if (r == VK_INCOMPLETE) continue;  // список вырос между вызовами
        exts.resize(r == VK_SUCCESS ? count : 0);
        break;
    }
    auto has = [&exts](const char * name) {
        for (const auto & e : exts) {
            if (strncmp(e.extensionName, name, VK_MAX_EXTENSION_NAME_SIZE) == 0) return true;
        }
        return false;
    };

    const uint32_t api = api_major_minor(p.apiVersion);
    const bool api11 = api >= VK_API_VERSION_1_1;
    const bool api12 = api >= VK_API_VERSION_1_2;
    const bool ext_driver = api12 || has("VK_KHR_driver_properties");
    const bool ext_pci = has("VK_EXT_pci_bus_info");
    const bool ext_int_dot = has("VK_KHR_shader_integer_dot_product");
    const bool ext_subgroup_size = has("VK_EXT_subgroup_size_control");
    const bool ext_amd_core = has("VK_AMD_shader_core_properties");
    const bool ext_sm_builtins = has("VK_NV_shader_sm_builtins");
    const bool ext_coopmat = has("VK_KHR_cooperative_matrix");
    const bool ext_coopmat2 = has("VK_NV_cooperative_matrix2");
    const bool ext_fp16_storage = has("VK_KHR_16bit_storage");
    const bool ext_fp16_compute = has("VK_KHR_shader_float16_int8");

    // Выключатели ggml (ggml_vk_print_gpu_info): с ними устройство для ggml этого не умеет.
    const bool use_coopmat = ext_coopmat && !env_set("GGML_VK_DISABLE_COOPMAT");
    const bool use_coopmat2 = ext_coopmat2 && !env_set("GGML_VK_DISABLE_COOPMAT2");
    const bool use_int_dot = ext_int_dot && !env_set("GGML_VK_DISABLE_INTEGER_DOT_PRODUCT");

    // --- свойства ---
    // В цепочку идут только структуры, которые устройство поддерживает по версии или
    // расширению: незнакомый sType драйвер вправе не заполнить.
    VkPhysicalDeviceProperties2 p2{};
    p2.sType = VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_PROPERTIES_2;
    VkPhysicalDeviceDriverProperties driver{};
    driver.sType = VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_DRIVER_PROPERTIES;
    VkPhysicalDeviceIDProperties id{};
    id.sType = VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_ID_PROPERTIES;
    VkPhysicalDevicePCIBusInfoPropertiesEXT pci{};
    pci.sType = VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_PCI_BUS_INFO_PROPERTIES_EXT;
    VkPhysicalDeviceShaderIntegerDotProductProperties int_dot{};
    int_dot.sType = VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_SHADER_INTEGER_DOT_PRODUCT_PROPERTIES;
    VkPhysicalDeviceSubgroupSizeControlProperties subgroup_size{};
    subgroup_size.sType = VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_SUBGROUP_SIZE_CONTROL_PROPERTIES;
    VkPhysicalDeviceShaderCorePropertiesAMD amd_core{};
    amd_core.sType = VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_SHADER_CORE_PROPERTIES_AMD;
    VkPhysicalDeviceShaderSMBuiltinsPropertiesNV sm_builtins{};
    sm_builtins.sType = VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_SHADER_SM_BUILTINS_PROPERTIES_NV;

    PNextChain props_chain(&p2);
    if (ext_driver) props_chain.add(&driver);
    if (api11) props_chain.add(&id);
    if (ext_pci) props_chain.add(&pci);
    if (ext_int_dot) props_chain.add(&int_dot);
    if (ext_subgroup_size) props_chain.add(&subgroup_size);
    if (ext_amd_core) props_chain.add(&amd_core);
    if (ext_sm_builtins) props_chain.add(&sm_builtins);
    vkGetPhysicalDeviceProperties2(pd, &p2);

    if (ext_driver) {
        d.has_driver_props = true;
        d.driver_id = (uint32_t) driver.driverID;
        d.driver_name = fixed_str(driver.driverName, VK_MAX_DRIVER_NAME_SIZE);
        d.driver_info = fixed_str(driver.driverInfo, VK_MAX_DRIVER_INFO_SIZE);
    }
    if (api11) {
        memcpy(d.uuid, id.deviceUUID, VK_UUID_SIZE);
        memcpy(d.luid, id.deviceLUID, VK_LUID_SIZE);
        d.luid_valid = id.deviceLUIDValid == VK_TRUE;
    }
    if (ext_pci) {
        char buf[16] = {};
        snprintf(buf, sizeof(buf), "%04x:%02x:%02x.%x", pci.pciDomain, pci.pciBus, pci.pciDevice, (uint8_t) pci.pciFunction);
        d.pci = buf;
    }

    // --- поколение карты: get_device_architecture ---
    if (p.vendorID == kVendorAmd) {
        if (ext_amd_core && ext_int_dot && ext_subgroup_size) {
            if (subgroup_size.maxSubgroupSize == 64 && subgroup_size.minSubgroupSize == 64) {
                d.architecture = "amd-gcn";
            } else if (subgroup_size.maxSubgroupSize == 64 && subgroup_size.minSubgroupSize == 32) {
                if (amd_core.wavefrontsPerSimd == 20) {
                    d.architecture = "amd-rdna1";
                } else if (int_dot.integerDotProduct4x8BitPackedMixedSignednessAccelerated) {
                    d.architecture = "amd-rdna3";
                } else {
                    d.architecture = "amd-rdna2";
                }
            }
        }
    } else if (p.vendorID == kVendorIntel) {
        if (ext_subgroup_size && ext_int_dot) {
            if (subgroup_size.minSubgroupSize == 16) {
                d.architecture = "intel-xe2";
            } else if (subgroup_size.minSubgroupSize == 8 && int_dot.integerDotProduct4x8BitPackedSignedAccelerated) {
                d.architecture = "intel-xe1";
            }
        }
    } else if (p.vendorID == kVendorNvidia) {
        // Как в ggml: «до Turing» определяется по отсутствию coopmat у драйвера.
        if (!ext_coopmat) {
            d.architecture = "nvidia-pre-turing";
        } else if (ext_sm_builtins && sm_builtins.shaderWarpsPerSM == 32) {
            d.architecture = "nvidia-turing";
        }
    }

    // --- возможности: ggml_vk_device_is_supported и ggml_vk_print_gpu_info ---
    VkPhysicalDeviceFeatures2 f2{};
    f2.sType = VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_FEATURES_2;
    VkPhysicalDeviceVulkan11Features vk11{};
    vk11.sType = VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_VULKAN_1_1_FEATURES;
    VkPhysicalDeviceVulkan12Features vk12{};
    vk12.sType = VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_VULKAN_1_2_FEATURES;
    VkPhysicalDeviceCooperativeMatrixFeaturesKHR coopmat_f{};
    coopmat_f.sType = VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_COOPERATIVE_MATRIX_FEATURES_KHR;
    VkPhysicalDeviceShaderIntegerDotProductFeatures int_dot_f{};
    int_dot_f.sType = VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_SHADER_INTEGER_DOT_PRODUCT_FEATURES;
    VkPhysicalDeviceCooperativeMatrix2FeaturesNV coopmat2_f{};
    coopmat2_f.sType = VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_COOPERATIVE_MATRIX_2_FEATURES_NV;

    PNextChain features_chain(&f2);
    // Vulkan11/12Features существуют с Vulkan 1.2; ggml сам требует 1.2, и устройство
    // старше для него всё равно непригодно.
    if (api12) {
        features_chain.add(&vk11);
        features_chain.add(&vk12);
    }
    if (use_coopmat) features_chain.add(&coopmat_f);
    if (use_int_dot) features_chain.add(&int_dot_f);
    if (use_coopmat2) features_chain.add(&coopmat2_f);
    vkGetPhysicalDeviceFeatures2(pd, &f2);

    d.storage16 = api12 && vk11.storageBuffer16BitAccess == VK_TRUE;
    d.fp16 = !env_set("GGML_VK_DISABLE_F16") && ext_fp16_storage && ext_fp16_compute && api12 && vk12.shaderFloat16 == VK_TRUE;
    d.integer_dot_product = use_int_dot && int_dot.integerDotProduct4x8BitPackedSignedAccelerated && int_dot_f.shaderIntegerDotProduct;

    // ggml_vk_khr_cooperative_matrix_support: драйверы AMD объявляют coopmat на всех
    // картах, а Intel до Xe2 с ним медленнее, поэтому ggml включает его не везде.
    bool coopmat_allowed = true;
    if (p.vendorID == kVendorIntel) {
        const std::string arch = d.architecture;
        coopmat_allowed = arch == "intel-xe2" ||
                          (arch == "intel-xe1" && p.deviceType == VK_PHYSICAL_DEVICE_TYPE_INTEGRATED_GPU &&
                           d.driver_id == (uint32_t) VK_DRIVER_ID_INTEL_PROPRIETARY_WINDOWS);
    } else if (p.vendorID == kVendorAmd &&
               (d.driver_id == (uint32_t) VK_DRIVER_ID_AMD_PROPRIETARY || d.driver_id == (uint32_t) VK_DRIVER_ID_AMD_OPEN_SOURCE)) {
        coopmat_allowed = strcmp(d.architecture, "amd-rdna3") == 0;
    }
    d.coopmat = use_coopmat && coopmat_f.cooperativeMatrix && coopmat_allowed;
    d.coopmat2 = use_coopmat2 &&
                 coopmat2_f.cooperativeMatrixWorkgroupScope && coopmat2_f.cooperativeMatrixFlexibleDimensions &&
                 coopmat2_f.cooperativeMatrixReductions && coopmat2_f.cooperativeMatrixConversions &&
                 coopmat2_f.cooperativeMatrixPerElementOperations && coopmat2_f.cooperativeMatrixTensorAddressing &&
                 coopmat2_f.cooperativeMatrixBlockLoads;
}

// Все физические устройства в порядке vkEnumeratePhysicalDevices — том же, что видит ggml
// в этом процессе (те же загрузчик, драйверы и переменные окружения).
bool vk_query_devices(std::vector<VkDetails> * result, std::string * err) {
    try {
        uint32_t loader_api = VK_API_VERSION_1_0;
        if (vkEnumerateInstanceVersion(&loader_api) != VK_SUCCESS) loader_api = VK_API_VERSION_1_0;
        if (api_major_minor(loader_api) < VK_API_VERSION_1_2) {
            *err = "загрузчик Vulkan старше 1.2";
            return false;
        }
        VkApplicationInfo app{};
        app.sType = VK_STRUCTURE_TYPE_APPLICATION_INFO;
        app.pApplicationName = "podskazych-vk";
        app.apiVersion = loader_api;  // как в ggml_vk_instance_init
        VkInstanceCreateInfo ci{};
        ci.sType = VK_STRUCTURE_TYPE_INSTANCE_CREATE_INFO;
        ci.pApplicationInfo = &app;
        VkInstance instance = VK_NULL_HANDLE;
        const VkResult r = vkCreateInstance(&ci, nullptr, &instance);
        if (r != VK_SUCCESS) {
            *err = "vkCreateInstance вернул " + std::to_string((int) r);
            return false;
        }
        struct InstanceGuard {
            VkInstance h;
            ~InstanceGuard() { vkDestroyInstance(h, nullptr); }
        } guard{instance};

        std::vector<VkPhysicalDevice> pds;
        for (int attempt = 0; attempt < 4; ++attempt) {
            uint32_t count = 0;
            if (vkEnumeratePhysicalDevices(instance, &count, nullptr) != VK_SUCCESS) {
                *err = "vkEnumeratePhysicalDevices не удался";
                return false;
            }
            pds.assign(count, VK_NULL_HANDLE);
            const VkResult er = vkEnumeratePhysicalDevices(instance, &count, pds.data());
            if (er == VK_INCOMPLETE) continue;
            if (er != VK_SUCCESS) {
                *err = "vkEnumeratePhysicalDevices вернул " + std::to_string((int) er);
                return false;
            }
            pds.resize(count);
            break;
        }

        std::vector<VkDetails> out(pds.size());
        for (size_t i = 0; i < pds.size(); ++i) query_one_device(pds[i], out[i]);
        result->swap(out);
        return true;
    } catch (const std::exception & e) {
        *err = e.what();
        return false;
    }
}

// Сбой внутри драйвера или слоя (нарушение доступа) не должен ронять помощника до hello:
// сведения необязательны, без них сайдкар решает по имени устройства. Функция без
// C++-объектов: __try нельзя смешивать с раскруткой деструкторов, поэтому при таком сбое
// объекты внутри vk_query_devices просто утекают, а result не трогается.
bool vk_query_devices_guarded(std::vector<VkDetails> * result, std::string * err, DWORD * seh_code) {
    __try {
        return vk_query_devices(result, err);
    } __except (EXCEPTION_EXECUTE_HANDLER) {
        *seh_code = GetExceptionCode();
        return false;
    }
}

// Приоритет драйвера при двух физических устройствах одной карты: меньше — лучше.
int ggml_driver_priority(uint32_t vendor_of_first, uint32_t driver_id) {
    switch (vendor_of_first) {
        case kVendorAmd:
            if (driver_id == (uint32_t) VK_DRIVER_ID_MESA_RADV) return 1;
            if (driver_id == (uint32_t) VK_DRIVER_ID_AMD_OPEN_SOURCE) return 2;
            if (driver_id == (uint32_t) VK_DRIVER_ID_AMD_PROPRIETARY) return 3;
            break;
        case kVendorIntel:
            if (driver_id == (uint32_t) VK_DRIVER_ID_INTEL_OPEN_SOURCE_MESA) return 1;
            if (driver_id == (uint32_t) VK_DRIVER_ID_INTEL_PROPRIETARY_WINDOWS) return 2;
            break;
        case kVendorNvidia:
            if (driver_id == (uint32_t) VK_DRIVER_ID_NVIDIA_PROPRIETARY) return 1;
            if (driver_id == (uint32_t) VK_DRIVER_ID_MESA_NVK) return 2;
            break;
        case kVendorQualcomm:
            if (driver_id == (uint32_t) VK_DRIVER_ID_QUALCOMM_PROPRIETARY) return 1;
            if (driver_id == (uint32_t) VK_DRIVER_ID_MESA_TURNIP) return 2;
            break;
    }
    if (driver_id == (uint32_t) VK_DRIVER_ID_MESA_DOZEN) return 100;
    return INT32_MAX;
}

// Повтор выбора устройств из ggml_vk_instance_init: номер N бэкенда Vulkan — это
// физическое устройство order[N]. ok=false, если ggml на таком окружении сам откажется
// (неверный индекс в GGML_VK_VISIBLE_DEVICES).
std::vector<size_t> ggml_device_order(const std::vector<VkDetails> & devs, bool & ok) {
    ok = true;
    std::vector<size_t> order;
    if (const char * env = getenv("GGML_VK_VISIBLE_DEVICES")) {
        const char * p = env;
        for (;;) {
            while (*p == ' ' || *p == ',' || *p == '\t') ++p;
            if (*p < '0' || *p > '9') {
                if (*p != '\0') ok = false;  // ggml прочитал бы мусор иначе, не угадываем
                break;
            }
            char * end = nullptr;
            const unsigned long v = strtoul(p, &end, 10);
            if (v >= devs.size()) {
                ok = false;
                break;
            }
            order.push_back((size_t) v);
            p = end;
        }
        return order;
    }
    for (size_t i = 0; i < devs.size(); ++i) {
        const VkDetails & nd = devs[i];
        if (!(nd.type == VK_PHYSICAL_DEVICE_TYPE_DISCRETE_GPU || nd.type == VK_PHYSICAL_DEVICE_TYPE_INTEGRATED_GPU) || !nd.storage16) {
            continue;
        }
        auto old = std::find_if(order.begin(), order.end(), [&](size_t k) {
            const VkDetails & od = devs[k];
            bool same = memcmp(od.uuid, nd.uuid, VK_UUID_SIZE) == 0;
            same = same || (od.luid_valid && nd.luid_valid && memcmp(od.luid, nd.luid, VK_LUID_SIZE) == 0);
            const bool both_molten = od.driver_id == (uint32_t) VK_DRIVER_ID_MOLTENVK && nd.driver_id == (uint32_t) VK_DRIVER_ID_MOLTENVK;
            return same && !both_molten;
        });
        if (old == order.end()) {
            order.push_back(i);
            continue;
        }
        const size_t old_index = *old;
        const int old_priority = ggml_driver_priority(devs[old_index].vendor_id, devs[old_index].driver_id);
        const int new_priority = ggml_driver_priority(devs[old_index].vendor_id, nd.driver_id);
        if (new_priority < old_priority) {
            order.erase(std::remove(order.begin(), order.end(), old_index), order.end());
            order.push_back(i);
        }
    }
    if (order.empty()) {
        for (size_t i = 0; i < devs.size(); ++i) {
            if (devs[i].type != VK_PHYSICAL_DEVICE_TYPE_CPU) {
                order.push_back(i);
                break;
            }
        }
    }
    return order;
}

bool same_device(const VkDetails & v, const DeviceInfo & d) {
    return v.name == d.name && (d.pci.empty() || v.pci.empty() || v.pci == d.pci);
}

// Сверка с отладочной строкой ggml для того же номера устройства. false — строка про
// другое устройство (не совпали имя или драйвер): тогда сведения не отдаём вовсе.
// Возможности, которые видны в строке, берём у ggml: он решает, что использовать.
bool reconcile_with_ggml(const std::string & line, VkDetails & v, std::string & diff) {
    const std::string head = v.name + " (" + v.driver_name + ") | ";
    if (line.compare(0, head.size(), head) != 0) return false;
    std::map<std::string, std::string> kv;
    size_t pos = head.size();
    while (pos <= line.size()) {
        size_t next = line.find(" | ", pos);
        const std::string item = line.substr(pos, next == std::string::npos ? std::string::npos : next - pos);
        const size_t colon = item.find(": ");
        if (colon != std::string::npos) kv[item.substr(0, colon)] = item.substr(colon + 2);
        if (next == std::string::npos) break;
        pos = next + 3;
    }
    auto flag = [&](const char * key, bool & mine, bool theirs) {
        if (mine != theirs) {
            diff += std::string(diff.empty() ? "" : ", ") + key + " " + (mine ? "1" : "0") + "→" + (theirs ? "1" : "0");
            mine = theirs;
        }
    };
    if (kv.count("uma")) flag("uma", v.uma, kv["uma"] != "0");
    if (kv.count("fp16")) flag("fp16", v.fp16, kv["fp16"] != "0");  // "1" или "dot2"
    if (kv.count("int dot")) flag("int dot", v.integer_dot_product, kv["int dot"] != "0");
    if (kv.count("matrix cores")) {
        const std::string & cores = kv["matrix cores"];
        const bool cm2 = cores.compare(0, 11, "NV_coopmat2") == 0;
        flag("coopmat2", v.coopmat2, cm2);
        // При coopmat2 ggml не показывает, есть ли KHR coopmat, — остаётся наше значение.
        if (!cm2) flag("coopmat", v.coopmat, cores == "KHR_coopmat");
    }
    return true;
}

void attach_vulkan_details(std::vector<DeviceInfo> & devs) {
    if (devs.empty() || !g_vulkan_loader) return;
    const auto t0 = std::chrono::steady_clock::now();
    std::vector<VkDetails> phys;
    std::string err;
    DWORD seh = 0;
    if (!vk_query_devices_guarded(&phys, &err, &seh)) {
        if (seh) {
            fprintf(stderr, "podskazych-vk: сбой 0x%08lx при запросе сведений Vulkan, отдаём устройства без них\n", seh);
        } else {
            fprintf(stderr, "podskazych-vk: сведения Vulkan недоступны (%s)\n", err.c_str());
        }
        return;
    }
    const int64_t ms = std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::steady_clock::now() - t0).count();

    bool order_ok = true;
    const std::vector<size_t> order = ggml_device_order(phys, order_ok);
    std::map<int, std::string> lines;
    {
        std::lock_guard<std::mutex> lock(g_vk_info_mutex);
        lines = g_vk_info_lines;
    }

    for (auto & d : devs) {
        int found = -1;
        if (order_ok && d.vk_index >= 0 && (size_t) d.vk_index < order.size() && same_device(phys[order[(size_t) d.vk_index]], d)) {
            found = (int) order[(size_t) d.vk_index];
        }
        if (found < 0) {
            // Порядок не повторился (другая версия ggml или необычное окружение): годится
            // только однозначное совпадение по имени и PCI.
            for (size_t j = 0; j < phys.size(); ++j) {
                if (phys[j].type == VK_PHYSICAL_DEVICE_TYPE_CPU || !same_device(phys[j], d)) continue;
                if (found >= 0) {
                    found = -2;
                    break;
                }
                found = (int) j;
            }
        }
        if (found < 0) {
            fprintf(stderr, "podskazych-vk: устройство %d (%s) не сопоставлено с Vulkan, без подробностей\n", d.index, d.name.c_str());
            continue;
        }
        VkDetails v = phys[(size_t) found];
        if (!v.has_driver_props) {
            fprintf(stderr, "podskazych-vk: устройство %d (%s) без VkPhysicalDeviceDriverProperties, без подробностей\n", d.index, d.name.c_str());
            continue;
        }
        const char * checked = "нет строки ggml";
        std::string diff;
        auto it = lines.find(d.vk_index);
        if (it != lines.end()) {
            if (!reconcile_with_ggml(it->second, v, diff)) {
                fprintf(stderr, "podskazych-vk: устройство %d: ggml описывает его как «%s», сведения Vulkan не отдаём\n", d.index, it->second.c_str());
                continue;
            }
            checked = diff.empty() ? "совпало" : "расхождение, взято у ggml";
        }
        d.vk = v;
        d.has_details = true;
        fprintf(stderr,
                "podskazych-vk: устройство %d: %s, vendor 0x%04x, device 0x%04x, драйвер %s %s, arch %s, coopmat %d, coopmat2 %d, int dot %d, fp16 %d; сверка с ggml: %s%s%s (%lld мс)\n",
                d.index, v.name.c_str(), v.vendor_id, v.device_id, v.driver_name.c_str(), v.driver_info.c_str(), v.architecture,
                (int) v.coopmat, (int) v.coopmat2, (int) v.integer_dot_product, (int) v.fp16, checked,
                diff.empty() ? "" : ": ", diff.c_str(), (long long) ms);
    }
}

// Версия драйвера по-человечески. Кодировка у вендоров своя: NVIDIA — 10.8.8.6 бит
// (610.47), Intel на Windows — 18.14 (101.6130), остальные — как версия Vulkan.
std::string driver_version_text(const VkDetails & v) {
    const uint32_t x = v.driver_version;
    char buf[64];
    if (v.vendor_id == kVendorNvidia && v.driver_id == (uint32_t) VK_DRIVER_ID_NVIDIA_PROPRIETARY) {
        const uint32_t a = (x >> 6) & 0xff;
        const uint32_t b = x & 0x3f;
        if (a || b) {
            snprintf(buf, sizeof(buf), "%u.%02u.%u.%u", (x >> 22) & 0x3ff, (x >> 14) & 0xff, a, b);
        } else {
            snprintf(buf, sizeof(buf), "%u.%02u", (x >> 22) & 0x3ff, (x >> 14) & 0xff);
        }
    } else if (v.vendor_id == kVendorIntel && v.driver_id == (uint32_t) VK_DRIVER_ID_INTEL_PROPRIETARY_WINDOWS) {
        snprintf(buf, sizeof(buf), "%u.%u", x >> 14, x & 0x3fff);
    } else {
        snprintf(buf, sizeof(buf), "%u.%u.%u", x >> 22, (x >> 12) & 0x3ff, x & 0xfff);
    }
    return buf;
}

std::string devices_json(const std::vector<DeviceInfo> & devs) {
    std::string s = "[";
    for (size_t i = 0; i < devs.size(); ++i) {
        const DeviceInfo & d = devs[i];
        JsonWriter w;
        w.num("index", d.index)
         .str("name", d.name)
         .str("type", d.type)
         .num("vramMB", d.vram_mb)
         .num("freeMB", d.free_mb);
        // Подробности — все поля сразу или ни одного (не удалось спросить драйвер или
        // сопоставить устройство с ggml).
        if (d.has_details) {
            const VkDetails & v = d.vk;
            char api[32];
            snprintf(api, sizeof(api), "%u.%u.%u", VK_API_VERSION_MAJOR(v.api_version), VK_API_VERSION_MINOR(v.api_version),
                     VK_API_VERSION_PATCH(v.api_version));
            w.num("vendorId", v.vendor_id)
             .num("deviceId", v.device_id)
             .num("driverId", v.driver_id)
             .str("driverName", v.driver_name)
             .str("driverInfo", v.driver_info)
             .str("driverVersion", driver_version_text(v))
             .num("driverVersionRaw", v.driver_version)
             .str("apiVersion", api)
             .str("architecture", v.architecture)
             .boolean("uma", v.uma)
             .boolean("coopmat", v.coopmat)
             .boolean("coopmat2", v.coopmat2)
             .boolean("integerDotProduct", v.integer_dot_product)
             .boolean("fp16", v.fp16);
        }
        if (i) s.push_back(',');
        s += w.done();
    }
    s.push_back(']');
    return s;
}

// ---------------------------------------------------------------------------
// Модель
// ---------------------------------------------------------------------------

struct State {
    whisper_context * ctx = nullptr;
    // После потери устройства контекст нельзя ни использовать, ни безопасно освободить
    // (освобождение буферов на потерянном устройстве само может упасть), поэтому такой
    // контекст просто бросаем и ждём новый load.
    bool ctx_broken = false;
    int device = -1;
    std::string device_name;
    int threads = 2;
};

State g;

bool utf8_to_wide(const std::string & s, std::wstring & out) {
    if (s.empty()) return false;
    int n = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, s.data(), (int) s.size(), nullptr, 0);
    if (n <= 0) return false;
    out.assign((size_t) n, L'\0');
    return MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, s.data(), (int) s.size(), &out[0], n) == n;
}

struct FileLoader {
    FILE * f = nullptr;
};

size_t loader_read(void * ctx, void * output, size_t read_size) {
    auto * fl = (FileLoader *) ctx;
    return fl->f ? fread(output, 1, read_size, fl->f) : 0;
}

bool loader_eof(void * ctx) {
    auto * fl = (FileLoader *) ctx;
    return !fl->f || feof(fl->f) != 0;
}

void loader_close(void * ctx) {
    auto * fl = (FileLoader *) ctx;
    if (fl->f) {
        fclose(fl->f);
        fl->f = nullptr;
    }
}

void drop_context() {
    if (g.ctx && !g.ctx_broken) {
        try {
            whisper_free(g.ctx);
        } catch (...) {
            fprintf(stderr, "podskazych-vk: исключение при освобождении контекста\n");
        }
    }
    g.ctx = nullptr;
    g.ctx_broken = false;
    g.device = -1;
    g.device_name.clear();
}

void handle_load(const JsonObject & msg) {
    std::string model;
    int64_t device = -1;
    bool flash_attn = true;
    int64_t threads = 2;

    if (get_str(msg, "model", model) != Field::Ok || model.empty()) {
        send_error("bad-model", "нужно строковое поле model с абсолютным путём к ggml .bin");
        return;
    }
    if (get_int(msg, "device", device) == Field::WrongType ||
        get_bool(msg, "flashAttn", flash_attn) == Field::WrongType ||
        get_int(msg, "threads", threads) == Field::WrongType) {
        send_error("load-failed", "неверный тип поля device, flashAttn или threads");
        return;
    }
    threads = std::max<int64_t>(1, std::min<int64_t>(threads, 64));

    if (!g_cpu_ok) {
        send_error("load-failed", "процессор без AVX2/FMA/F16C/BMI2 — эта сборка на нём не работает");
        return;
    }

    // Сначала файл: проверка дешёвая и не трогает видеокарту.
    std::wstring wpath;
    if (!utf8_to_wide(model, wpath)) {
        send_error("bad-model", "путь к модели — не корректный UTF-8");
        return;
    }
    {
        FILE * f = _wfopen(wpath.c_str(), L"rb");
        if (!f) {
            send_error("bad-model", "не удалось открыть файл модели: " + model);
            return;
        }
        uint32_t magic = 0;
        const size_t got = fread(&magic, 1, sizeof(magic), f);
        fclose(f);
        // GGML_FILE_MAGIC 'ggml' — тот же признак проверяет whisper_model_load
        if (got != sizeof(magic) || magic != 0x67676d6c) {
            send_error("bad-model", "файл не похож на модель whisper.cpp (нет сигнатуры ggml): " + model);
            return;
        }
    }

    if (!g_vulkan_loader) {
        send_error("no-device", "в системе нет vulkan-1.dll: драйвер видеокарты без Vulkan");
        return;
    }

    std::vector<DeviceInfo> devs;
    try {
        devs = list_devices();
    } catch (const std::exception & e) {
        send_error("no-device", std::string("ошибка перечисления устройств Vulkan: ") + e.what());
        return;
    }

    const DeviceInfo * chosen = nullptr;
    if (device >= 0) {
        for (const auto & d : devs) {
            if (d.index == device) chosen = &d;
        }
        if (!chosen) {
            send_error("no-device", "устройство Vulkan с индексом " + std::to_string(device) + " не найдено");
            return;
        }
    } else {
        // На ноутбуках встроенная графика часто перечисляется первой, а whisper по
        // умолчанию берёт устройство 0 — то есть самое слабое. Сначала дискретная.
        for (const auto & d : devs) {
            if (d.type == "discrete") { chosen = &d; break; }
        }
        if (!chosen) {
            for (const auto & d : devs) {
                if (d.type == "integrated") { chosen = &d; break; }
            }
        }
        if (!chosen) {
            send_error("no-device", "нет подходящей видеокарты с Vulkan");
            return;
        }
    }
    const DeviceInfo target = *chosen;

    drop_context();

    whisper_context_params cparams = whisper_context_default_params();
    cparams.use_gpu = true;
    cparams.gpu_device = target.index;
    // На AMD с фирменным драйвером Windows (RDNA1/2) у flash attention отдельный путь
    // шейдеров с известными ошибками — выключатель остаётся у клиента.
    cparams.flash_attn = flash_attn;
    cparams.dtw_token_timestamps = false;

    FileLoader fl;
    fl.f = _wfopen(wpath.c_str(), L"rb");
    if (!fl.f) {
        send_error("bad-model", "не удалось повторно открыть файл модели: " + model);
        return;
    }
    whisper_model_loader loader{};
    loader.context = &fl;
    loader.read = loader_read;
    loader.eof = loader_eof;
    loader.close = loader_close;

    const auto t0 = std::chrono::steady_clock::now();
    whisper_context * ctx = nullptr;
    std::string exc;
    g_gpu_init_failed.store(false);
    g_watch_load_log.store(true);
    try {
        ctx = whisper_init_with_params(&loader, cparams);
    } catch (const std::exception & e) {
        exc = e.what();
    } catch (...) {
        exc = "неизвестное исключение";
    }
    g_watch_load_log.store(false);
    loader_close(&fl);  // whisper сам закрывает загрузчик, но при исключении мог не успеть
    const int64_t ms = std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::steady_clock::now() - t0).count();

    if (!ctx) {
        send_error("load-failed", exc.empty() ? "whisper_init_with_params вернул NULL (подробности в stderr)"
                                              : "исключение при загрузке: " + exc);
        return;
    }
    if (g_gpu_init_failed.load()) {
        try {
            whisper_free(ctx);
        } catch (...) {
        }
        send_error("load-failed", "видеокарта не инициализировалась, whisper перешёл бы на процессор");
        return;
    }

    g.ctx = ctx;
    g.ctx_broken = false;
    g.device = target.index;
    g.device_name = target.name;
    g.threads = (int) threads;

    JsonWriter w;
    w.str("type", "loaded")
     .num("device", target.index)
     .str("name", target.name)
     .str("deviceType", target.type)
     .boolean("flashAttn", flash_attn)
     .num("ms", ms);
    proto_write_line(w.done());
}

// samples уже проверен кадрированием в run(): 0..kMaxFrameSamples, байты звука ещё в потоке.
// Возвращает false, если поток ввода кончился (дальше работать нечем).
bool handle_transcribe(const JsonObject & msg, Input & in, int64_t samples) {
    int64_t id = 0;
    const bool has_id = get_int(msg, "id", id) == Field::Ok;
    if (samples > kMaxSamples) {
        // Байты всё равно вычитываем: иначе звук разобрался бы как следующие заголовки.
        if (!in.skip((uint64_t) samples * 4)) return false;
        send_error(nullptr, "слишком длинный фрагмент: " + std::to_string(samples) + " отсчётов, максимум " +
                   std::to_string(kMaxSamples), has_id, id);
        return true;
    }

    std::vector<float> pcm;
    try {
        pcm.resize((size_t) samples);
    } catch (const std::bad_alloc &) {
        if (!in.skip((uint64_t) samples * 4)) return false;
        send_error(nullptr, "не хватило памяти под звук", has_id, id);
        return true;
    }
    if (samples > 0 && !in.read_exact((char *) pcm.data(), (size_t) samples * 4)) return false;

    std::string language = "ru";
    int64_t audio_ctx = 0;
    int64_t max_tokens = 0;
    std::vector<int64_t> prompt;
    if (get_str(msg, "language", language) == Field::WrongType ||
        get_int(msg, "audioCtx", audio_ctx) == Field::WrongType ||
        get_int(msg, "maxTokens", max_tokens) == Field::WrongType ||
        get_int_array(msg, "promptTokens", prompt) == Field::WrongType) {
        send_error(nullptr, "неверный тип поля language, audioCtx, maxTokens или promptTokens", has_id, id);
        return true;
    }
    if (!g.ctx) {
        send_error(nullptr, "модель не загружена: сначала load", has_id, id);
        return true;
    }
    if (g.ctx_broken) {
        send_error(nullptr, "контекст потерян после ошибки видеокарты: нужен повторный load", has_id, id);
        return true;
    }
    if (prompt.size() > kMaxPromptTokens) {
        send_error(nullptr, "promptTokens длиннее " + std::to_string(kMaxPromptTokens), has_id, id);
        return true;
    }
    // Номер токена за пределами словаря — чтение за границей массива внутри whisper.
    const int n_vocab = whisper_n_vocab(g.ctx);
    std::vector<whisper_token> tokens;
    tokens.reserve(prompt.size());
    for (int64_t t : prompt) {
        if (t < 0 || t >= n_vocab) {
            send_error(nullptr, "токен подсказки вне словаря: " + std::to_string(t), has_id, id);
            return true;
        }
        tokens.push_back((whisper_token) t);
    }
    if (audio_ctx < 0 || audio_ctx > whisper_n_audio_ctx(g.ctx)) {
        send_error(nullptr, "audioCtx вне диапазона 0.." + std::to_string(whisper_n_audio_ctx(g.ctx)), has_id, id);
        return true;
    }
    if (max_tokens < 0 || max_tokens > 448) {
        send_error(nullptr, "maxTokens вне диапазона 0..448", has_id, id);
        return true;
    }
    if (language.empty() || (language != "auto" && whisper_lang_id(language.c_str()) < 0)) {
        send_error(nullptr, "неизвестный язык: " + language, has_id, id);
        return true;
    }
    if (pcm.size() < kMinSamples) {
        JsonWriter w;
        w.str("type", "result").num("id", id).str("text", "").num("ms", 0);
        proto_write_line(w.done());
        return true;
    }

    whisper_full_params p = whisper_full_default_params(WHISPER_SAMPLING_GREEDY);
    p.n_threads = g.threads;
    p.translate = false;
    // Каждая фраза сайдкара независима: текст прошлого вызова в подсказку не идёт,
    // словарь терминов приходит явно в promptTokens.
    p.no_context = true;
    p.no_timestamps = true;
    p.single_segment = false;
    p.print_special = false;
    p.print_progress = false;
    p.print_realtime = false;
    p.print_timestamps = false;
    p.token_timestamps = false;
    p.language = language.c_str();
    p.detect_language = false;
    p.suppress_blank = true;
    // По умолчанию в whisper.cpp false, а faster-whisper подавляет неречевые токены
    // (suppress_tokens=[-1]); без этого на шуме и эхе больше выдуманного текста.
    p.suppress_nst = true;
    p.temperature = 0.0f;
    // Без повторов с повышенной температурой: сайдкар сам отбрасывает зацикливания,
    // а каждая повторная попытка — это ещё один проход декодера на видеокарте.
    p.temperature_inc = 0.0f;
    p.greedy.best_of = 1;
    p.max_tokens = (int) max_tokens;
    p.audio_ctx = (int) audio_ctx;
    // Токены подсказки считает HF-токенизатор сайдкара: собственный токенизатор whisper.cpp
    // режет слова иначе и при переполнении отбрасывает начало подсказки.
    p.initial_prompt = nullptr;
    p.prompt_tokens = tokens.empty() ? nullptr : tokens.data();
    p.prompt_n_tokens = (int) tokens.size();
    p.vad = false;

    whisper_reset_timings(g.ctx);
    const auto t0 = std::chrono::steady_clock::now();
    int ret = -1;
    std::string exc;
    try {
        ret = whisper_full(g.ctx, p, pcm.data(), (int) pcm.size());
    } catch (const std::exception & e) {
        exc = e.what();
    } catch (...) {
        exc = "неизвестное исключение";
    }
    const int64_t ms = std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::steady_clock::now() - t0).count();

    if (!exc.empty()) {
        // Исключение из ggml-vulkan обычно означает потерю устройства (TDR, сброс драйвера).
        g.ctx_broken = true;
        send_error(nullptr, "исключение при распознавании: " + exc, has_id, id);
        return true;
    }
    if (ret != 0) {
        send_error(nullptr, "whisper_full вернул " + std::to_string(ret), has_id, id);
        return true;
    }

    std::string text;
    const int n_seg = whisper_full_n_segments(g.ctx);
    for (int i = 0; i < n_seg; ++i) {
        const char * seg = whisper_full_get_segment_text(g.ctx, i);
        if (seg) text += seg;
    }
    trim_incomplete_utf8_tail(text);

    JsonWriter w;
    w.str("type", "result").num("id", id).str("text", text).num("ms", ms);
    // whisper_get_timings отдаёт средние на один прогон (encode обычно один на фразу,
    // decode — на один шаг декодера) и выделяет структуру через new.
    if (whisper_timings * t = whisper_get_timings(g.ctx)) {
        w.real("encodeMs", t->encode_ms)
         .real("decodeMs", t->decode_ms)
         .real("batchdMs", t->batchd_ms)
         .real("promptMs", t->prompt_ms)
         .real("sampleMs", t->sample_ms);
        delete t;
    }
    proto_write_line(w.done());
    return true;
}

// Границу следующего сообщения определить нельзя: байты звука с 0x0A разобрались бы как
// десятки «строк» и съели бы настоящий запрос. Одна ошибка и выход с kExitDesync —
// клиент перезапускает процесс.
[[noreturn]] void desync(const char * code, const std::string & message, bool has_id, int64_t id) {
    send_error(code, message + "; граница следующего сообщения неизвестна, помощник завершается", has_id, id);
    drop_context();
    hard_exit(kExitDesync);
}

int run(int argc, wchar_t ** argv) {
    // Никаких окон «программа выполнила недопустимую операцию» и abort-диалогов:
    // процесс без окна, упавший помощник должен просто завершиться.
    SetErrorMode(SEM_FAILCRITICALERRORS | SEM_NOGPFAULTERRORBOX | SEM_NOOPENFILEERRORBOX);
    _set_abort_behavior(0, _WRITE_ABORT_MSG | _CALL_REPORTFAULT);
    // Аварийные остановки получают свой код выхода (kExitFatal), чтобы сайдкар отличал
    // сбой видеокарты от смерти родителя и от рассинхронизации протокола.
    signal(SIGABRT, on_sigabrt);
    ggml_set_abort_callback(ggml_fatal);
    // Текущая папка не участвует в поиске DLL.
    SetDllDirectoryW(L"");

    // --- stdout: оставляем себе копию, сам stdout процесса отправляем в stderr ---
    HANDLE orig_out = GetStdHandle(STD_OUTPUT_HANDLE);
    if (orig_out == nullptr || orig_out == INVALID_HANDLE_VALUE ||
        !DuplicateHandle(GetCurrentProcess(), orig_out, GetCurrentProcess(), &g_proto_out, 0, FALSE, DUPLICATE_SAME_ACCESS)) {
        fprintf(stderr, "podskazych-vk: нет stdout для протокола\n");
        return (int) kExitUsage;
    }
    _setmode(_fileno(stdin), _O_BINARY);
    _setmode(_fileno(stdout), _O_BINARY);
    fflush(stdout);
    HANDLE err_handle = GetStdHandle(STD_ERROR_HANDLE);
    if (_fileno(stderr) >= 0 && _dup2(_fileno(stderr), _fileno(stdout)) == 0) {
        SetStdHandle(STD_OUTPUT_HANDLE, err_handle);
    } else {
        // stderr не подключён — чужой вывод в stdout выбрасываем, но в протокол он не попадёт
        FILE * nul = nullptr;
        if (freopen_s(&nul, "NUL", "wb", stdout) != 0) {
            fprintf(stderr, "podskazych-vk: не удалось отвязать stdout\n");
        }
    }

    HANDLE in_handle = GetStdHandle(STD_INPUT_HANDLE);
    if (in_handle == nullptr || in_handle == INVALID_HANDLE_VALUE) {
        fprintf(stderr, "podskazych-vk: нет stdin\n");
        return (int) kExitUsage;
    }

    // --- аргументы: только --parent-pid ---
    for (int i = 1; i < argc; ++i) {
        if (wcscmp(argv[i], L"--parent-pid") == 0 && i + 1 < argc) {
            wchar_t * end = nullptr;
            unsigned long pid = wcstoul(argv[++i], &end, 10);
            if (!end || *end != L'\0' || pid == 0) {
                fprintf(stderr, "podskazych-vk: неверный --parent-pid\n");
                return (int) kExitUsage;
            }
            if (!start_parent_watch((DWORD) pid)) {
                hard_exit(kExitParentGone);
            }
        } else {
            fprintf(stderr, "podskazych-vk: неизвестный аргумент (допускается только --parent-pid <pid>)\n");
            return (int) kExitUsage;
        }
    }

    whisper_log_set(log_callback, nullptr);
    ggml_log_set(log_callback, nullptr);

    g_cpu_ok = cpu_supported();
    g_vulkan_loader = g_cpu_ok && load_vulkan_loader();

    std::vector<DeviceInfo> devs;
    std::string enum_error;
    // Первое обращение к реестру ggml поднимает экземпляр Vulkan, и именно тогда ggml пишет
    // строки о возможностях устройств — ловим их для сверки.
    g_capture_vk_info.store(true);
    try {
        devs = list_devices();
    } catch (const std::exception & e) {
        enum_error = e.what();
    } catch (...) {
        enum_error = "неизвестное исключение";
    }
    g_capture_vk_info.store(false);
    try {
        attach_vulkan_details(devs);
    } catch (const std::exception & e) {
        fprintf(stderr, "podskazych-vk: сведения Vulkan не собраны: %s\n", e.what());
        for (auto & d : devs) d.has_details = false;
    } catch (...) {
        fprintf(stderr, "podskazych-vk: сведения Vulkan не собраны\n");
        for (auto & d : devs) d.has_details = false;
    }

    {
        JsonWriter w;
        w.str("type", "hello")
         .str("version", whisper_version())
         .num("protocol", 1)
         .raw("devices", devices_json(devs))
         .boolean("cpuOk", g_cpu_ok)
         .boolean("vulkanLoader", g_vulkan_loader);
        if (!enum_error.empty()) w.str("error", enum_error);
        proto_write_line(w.done());
    }

    // Кадрирование потока: строка JSON, и если в объекте есть целое поле samples, за
    // строкой идут samples×4 байт (правило общее для всех type, чтобы старый помощник
    // пропускал звук и у сообщений, которых он не знает).
    Input in(in_handle);
    std::string line;
    for (;;) {
        const Input::Line r = in.read_line(line);
        if (r == Input::Line::Eof) break;
        if (r == Input::Line::TooLong) {
            desync("bad-json", "строка длиннее 64 КБ", false, 0);
        }
        if (line.empty()) continue;

        JsonObject msg;
        std::string err;
        JsonParser parser(line.data(), line.size());
        if (!parser.parse(msg, err)) {
            desync("bad-json", "неверный JSON: " + err, false, 0);
        }

        int64_t id = 0;
        const bool has_id = get_int(msg, "id", id) == Field::Ok;
        int64_t samples = -1;  // -1 — поля нет, звука за строкой нет
        {
            auto it = msg.find("samples");
            if (it != msg.end() && it->second.kind != JsonValue::Kind::Null) {
                if (it->second.kind != JsonValue::Kind::Int || it->second.i < 0) {
                    desync(nullptr, "samples должно быть целым неотрицательным числом", has_id, id);
                }
                if (it->second.i > kMaxFrameSamples) {
                    desync(nullptr, "samples = " + std::to_string(it->second.i) + " больше предела " +
                           std::to_string(kMaxFrameSamples), has_id, id);
                }
                samples = it->second.i;
            }
        }

        std::string type;
        const bool has_type = get_str(msg, "type", type) == Field::Ok;
        if (has_type && type == "transcribe" && samples < 0) {
            // Звук за заголовком transcribe почти наверняка есть, но сколько — неизвестно.
            desync(nullptr, "в transcribe нужно целое неотрицательное поле samples", has_id, id);
        }
        if (!(has_type && type == "transcribe") && samples > 0) {
            if (!in.skip((uint64_t) samples * 4)) break;
        }
        if (!has_type) {
            send_error("bad-json", "нет строкового поля type", has_id, id);
            continue;
        }

        try {
            if (type == "transcribe") {
                if (!handle_transcribe(msg, in, samples)) break;
            } else if (type == "load") {
                handle_load(msg);
            } else if (type == "quit") {
                break;
            } else {
                send_error("bad-json", "неизвестный type: " + type, has_id, id);
            }
        } catch (const std::bad_alloc &) {
            send_error(nullptr, "не хватило памяти");
        } catch (const std::exception & e) {
            send_error(nullptr, std::string("исключение: ") + e.what());
        }
    }

    // Явно отдаём видеопамять до выхода: TerminateProcess ниже её тоже вернёт, но так
    // драйвер получает нормальное освобождение ресурсов, а не аварийное.
    drop_context();
    return 0;
}

}  // namespace

int wmain(int argc, wchar_t ** argv) {
    int code = (int) kExitOk;
    try {
        code = run(argc, argv);
    } catch (const std::exception & e) {
        fprintf(stderr, "podskazych-vk: необработанное исключение: %s\n", e.what());
        code = (int) kExitException;
    } catch (...) {
        fprintf(stderr, "podskazych-vk: необработанное исключение\n");
        code = (int) kExitException;
    }
    hard_exit((UINT) code);
}
