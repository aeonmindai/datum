"""pytest's discovery contract is the `test_` prefix, which is what makes `kind: test` derivable."""

from pypkg.codec import Widener, build_widener


def test_build_widener():
    assert build_widener(2).decode(1) == 4


def widener_helper():
    return Widener(1)
