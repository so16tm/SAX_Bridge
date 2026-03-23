class _AnyType(str):
    """任意の型と互換性を持つワイルドカード型。"""
    def __eq__(self, other: object) -> bool: return True
    def __ne__(self, other: object) -> bool: return False
    def __hash__(self) -> int: return hash(str(self))


ANY = _AnyType("*")
MAX_SLOTS = 16

PIPE_LINE = "PIPE_LINE"


class SAX_Bridge_Pipe_Collector:
    """
    Pipe Collector — ピッカーで登録したソースノードの PIPE 出力を収集し、
    先頭から走査して最初に見つかった非 None の PIPE を返す。

    JS ピッカーがソースノードの PIPE 出力を slot_0..slot_N に接続する。
    すべてのスロットが None の場合は None を返し、下流でエラーになる。
    """

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {},
            "optional": {f"slot_{i}": (ANY,) for i in range(MAX_SLOTS)},
        }

    RETURN_TYPES = (PIPE_LINE,)
    RETURN_NAMES = ("pipe",)
    FUNCTION     = "collect"
    CATEGORY     = "SAX/Bridge/Collect"
    OUTPUT_NODE  = False
    DESCRIPTION  = (
        "Collects PIPE outputs from registered source nodes and returns the first "
        "non-None PIPE found. Use the JS picker to register source nodes."
    )

    def collect(self, **kwargs):
        for i in range(MAX_SLOTS):
            val = kwargs.get(f"slot_{i}")
            if val is not None:
                return (val,)
        return (None,)
