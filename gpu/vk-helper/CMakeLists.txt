# podskazych-vk: whisper.cpp с бэкендом Vulkan одним exe без DLL.
#
# Исходники whisper.cpp сюда не копируются: сборка (.github/workflows/gpu-vulkan.yml)
# кладёт их отдельно на закреплённом коммите тега и передаёт путь в WHISPER_CPP_DIR.
#
#   cmake -S gpu/vk-helper -B build -G Ninja -DCMAKE_BUILD_TYPE=Release -DWHISPER_CPP_DIR=<путь>
#   cmake --build build

cmake_minimum_required(VERSION 3.21)

# CMAKE_MSVC_RUNTIME_LIBRARY работает только при политике CMP0091=NEW. Корневой
# CMakeLists whisper.cpp объявляет cmake_minimum_required(VERSION 3.5), и в его папках
# политика осталась бы старой: библиотека whisper собралась бы с /MD, а ggml с /MT,
# и линковка упала бы на несовпадении рантайма (или exe потребовал бы VC++ redist).
set(CMAKE_POLICY_DEFAULT_CMP0091 NEW)

project(podskazych-vk C CXX)

if (NOT WIN32 OR NOT MSVC)
    message(FATAL_ERROR "podskazych-vk собирается только под Windows компилятором MSVC")
endif()

set(WHISPER_CPP_DIR "" CACHE PATH "Исходники whisper.cpp v1.9.4")
if (NOT EXISTS "${WHISPER_CPP_DIR}/include/whisper.h")
    message(FATAL_ERROR "WHISPER_CPP_DIR не указывает на исходники whisper.cpp: '${WHISPER_CPP_DIR}'")
endif()

# Статический рантайм MSVC: у пользователя может не быть VC++ Redistributable,
# а доустанавливать его ради GPU-пакета мы не хотим.
set(CMAKE_MSVC_RUNTIME_LIBRARY "MultiThreaded" CACHE STRING "" FORCE)

# Всё в один exe: пакет скачивается по требованию, и чем меньше в нём файлов, тем меньше
# шансов, что антивирус или неполная распаковка оставят его без половины библиотек.
set(BUILD_SHARED_LIBS OFF CACHE BOOL "" FORCE)

set(WHISPER_BUILD_EXAMPLES OFF CACHE BOOL "" FORCE)
set(WHISPER_BUILD_TESTS    OFF CACHE BOOL "" FORCE)
set(WHISPER_BUILD_SERVER   OFF CACHE BOOL "" FORCE)
# Сборка с тега релиза: whisper_version() должен вернуть "1.9.4", а не "1.9.4-dev".
set(WHISPER_BUILD_IS_DEV   OFF CACHE BOOL "" FORCE)
set(WHISPER_CURL           OFF CACHE BOOL "" FORCE)
set(WHISPER_SDL2           OFF CACHE BOOL "" FORCE)

set(GGML_VULKAN ON  CACHE BOOL "" FORCE)
set(GGML_CUDA   OFF CACHE BOOL "" FORCE)
# Без -march=native: собирается на раннере, запускается у пользователей.
set(GGML_NATIVE OFF CACHE BOOL "" FORCE)
# Набор инструкций задаём явно, а не полагаемся на умолчания ggml: main.cpp проверяет
# ровно этот набор (AVX2 в MSVC подразумевает FMA и F16C) перед первым вызовом ggml.
set(GGML_SSE42  ON  CACHE BOOL "" FORCE)
set(GGML_AVX    ON  CACHE BOOL "" FORCE)
set(GGML_AVX2   ON  CACHE BOOL "" FORCE)
set(GGML_BMI2   ON  CACHE BOOL "" FORCE)
set(GGML_AVX512 OFF CACHE BOOL "" FORCE)
# OpenMP в MSVC — это vcomp140.dll, которой нет без VC++ redist. Без OpenMP ggml-cpu
# использует свой пул потоков; основная работа всё равно на видеокарте.
set(GGML_OPENMP OFF CACHE BOOL "" FORCE)
set(GGML_BUILD_TESTS    OFF CACHE BOOL "" FORCE)
set(GGML_BUILD_EXAMPLES OFF CACHE BOOL "" FORCE)

add_subdirectory("${WHISPER_CPP_DIR}" whisper.cpp EXCLUDE_FROM_ALL)

add_executable(podskazych-vk main.cpp)
target_link_libraries(podskazych-vk PRIVATE whisper)
# main.cpp сам спрашивает драйвер о вендоре, драйвере и возможностях устройства (C API
# Vulkan): ggml-vulkan эти сведения наружу не отдаёт. Цель Vulkan::Vulkan, найденная внутри
# папки ggml, сюда не видна, поэтому ищем пакет ещё раз (путь уже в кэше). Импорты из
# vulkan-1.dll остаются отложенными — /DELAYLOAD ниже действует на весь exe.
find_package(Vulkan REQUIRED)
target_link_libraries(podskazych-vk PRIVATE Vulkan::Vulkan)
target_compile_features(podskazych-vk PRIVATE cxx_std_17)
target_compile_definitions(podskazych-vk PRIVATE UNICODE _UNICODE WIN32_LEAN_AND_MEAN NOMINMAX _CRT_SECURE_NO_WARNINGS)
# В main.cpp кириллица в строках: без /utf-8 MSVC прочитал бы исходник в ANSI-кодировке
# раннера и сообщения ушли бы в протокол испорченными.
target_compile_options(podskazych-vk PRIVATE /utf-8 /W3)

# vulkan-1.dll ставит драйвер видеокарты. С обычным импортом exe без неё не запустился
# бы вовсе (системное окно об ошибке вместо ответа hello); отложенная загрузка даёт
# main.cpp сначала проверить, есть ли библиотека, и честно ответить «устройств нет».
target_link_options(podskazych-vk PRIVATE "/DELAYLOAD:vulkan-1.dll")
target_link_libraries(podskazych-vk PRIVATE delayimp)
