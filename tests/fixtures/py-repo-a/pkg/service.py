import os
from .util import helper


class Base:
    def run(self):
        raise NotImplementedError


class Worker(Base):
    def run(self):
        value = helper(21)
        os.path.join("a", value.__str__())
        return value


def helper(y):
    """A second, unrelated top-level function that collides by name with
    pkg.util.helper — this is the deliberate ambiguous-call fixture."""
    return y
