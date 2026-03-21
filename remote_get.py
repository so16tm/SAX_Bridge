class _AnyType(str):
    """任意の型と互換性を持つワイルドカード型。"""
    def __eq__(self, other: object) -> bool: return True
    def __ne__(self, other: object) -> bool: return False
    def __hash__(self) -> int: return hash(str(self))


ANY = _AnyType("*")
MAX_SLOTS = 32


class SAX_Bridge_Remote_Get:
    """
    Remote Get Node — ピッカーで任意ノードの出力を直接参照する。

    JS ピッカーがソースノードの出力を slot_0..slot_N に接続し、
    対応する out_0..out_N として下流ノードへ転送する。
    未接続スロットは None を返す。
    """

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {},
            "optional": {f"slot_{i}": (ANY,) for i in range(MAX_SLOTS)},
        }

    RETURN_TYPES  = (ANY,) * MAX_SLOTS
    RETURN_NAMES  = tuple(f"out_{i}" for i in range(MAX_SLOTS))
    FUNCTION      = "passthrough"
    CATEGORY      = "SAX/Bridge/Utility"
    OUTPUT_NODE   = False

    def passthrough(self, **kwargs):
        return tuple(kwargs.get(f"slot_{i}") for i in range(MAX_SLOTS))
