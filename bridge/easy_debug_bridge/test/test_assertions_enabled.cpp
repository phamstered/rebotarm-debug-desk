#include <cassert>

int main() {
  bool evaluated = false;
  assert((evaluated = true));
  // Deliberately not an assertion: the test must fail when NDEBUG removes it.
  return evaluated ? 0 : 1;
}
