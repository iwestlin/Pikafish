/*
  Browser-friendly C ABI for the Pikafish UCI engine.
*/
#include <emscripten/emscripten.h>

#include <algorithm>
#include <memory>
#include <string>

#include "bitboard.h"
#include "evaluate.h"
#include "misc.h"
#include "position.h"
#include "psqt.h"
#include "search.h"
#include "thread.h"
#include "tune.h"
#include "uci.h"

using namespace Stockfish;

namespace {

bool initialized = false;
std::unique_ptr<UCI::EngineSession> session;

constexpr int DefaultThreads = 1;
constexpr int DefaultHashMB = 16;

int clampThreads(int value) {
    return std::clamp(value > 0 ? value : DefaultThreads, 1, PIKAFISH_WASM_MAX_THREADS);
}

int clampHashMB(int value) {
    return std::clamp(value > 0 ? value : DefaultHashMB, 1, PIKAFISH_WASM_MAX_HASH_MB);
}

} // namespace

extern "C" {

EMSCRIPTEN_KEEPALIVE
void pikafish_init(int threads, int hashMB) {
    if (initialized)
        return;

    static char executableName[] = "pikafish.wasm";
    char* argv[] = { executableName };

    CommandLine::init(1, argv);
    UCI::init(Options);
    Tune::init();
    PSQT::init();
    Bitboards::init();
    Position::init();
    Threads.set(1);
    Search::clear();
    Eval::NNUE::init();

    const int requestedThreads = clampThreads(threads);
    const int requestedHashMB = clampHashMB(hashMB);
    if (size_t(Options["Threads"]) != size_t(requestedThreads))
        Options["Threads"] = std::to_string(requestedThreads);
    if (size_t(Options["Hash"]) != size_t(requestedHashMB))
        Options["Hash"] = std::to_string(requestedHashMB);
    session = std::make_unique<UCI::EngineSession>();
    initialized = true;
}

EMSCRIPTEN_KEEPALIVE
void pikafish_command(const char* command) {
    if (!session || !command)
        return;
    session->execute(command);
}

EMSCRIPTEN_KEEPALIVE
void pikafish_stop() {
    Threads.stop = true;
}

} // extern "C"
