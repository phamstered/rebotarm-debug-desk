#include "engine.hpp"
#include <iostream>
int main() {
  try {
    std::string input;
    char buffer[8192];
    while (std::cin.read(buffer, sizeof(buffer)) || std::cin.gcount()) {
      input.append(buffer, size_t(std::cin.gcount()));
      handeye::require(input.size() <= 32 * 1024 * 1024, "Request too large");
    }
    auto result = handeye::run(handeye::Json::parse(input));
    std::cout << handeye::Json({{"ok", true}, {"result", result}}).dump();
    return 0;
  } catch (const std::exception &ex) {
    std::cout << handeye::Json({{"ok", false}, {"error", ex.what()}}).dump();
    return 1;
  }
}
