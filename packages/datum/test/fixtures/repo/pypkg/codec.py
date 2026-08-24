"""Python side of the fixture. `pypkg/__init__.py` makes this `pypkg.codec`."""

MAX_WIDTH = 8


class Codec:
    """An `implements` target for Widener below."""

    def decode(self, packed: int) -> int:
        raise NotImplementedError


class Widener(Codec):
    def __init__(self, width: int) -> None:
        self.width = width

    def decode(self, packed: int) -> int:
        # `self.widen` resolves against this class, not against every method named `widen`.
        return self.widen(packed)

    def widen(self, packed: int) -> int:
        return packed << self.width


def build_widener(width: int) -> Widener:
    # Reads as a call, means construction: the resolver retags it once it sees the target is a type.
    return Widener(width)


def calls_missing(value: int) -> int:
    # Nothing in the fixture defines this, so the edge must be recorded as unresolved.
    return absent_python_dependency(value)
