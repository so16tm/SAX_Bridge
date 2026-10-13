"""送信前に展開された文章から LoRA 指定だけを取り出す。"""

import math
import re


_LORA_TAG = re.compile(r"<lora:([^>]+)>")


def split_lora_tags(text: str) -> tuple[str, list[tuple]]:
    """文章と既存ローダー用の LoRA 指定を返す。動的構文は展開しない。

    ``<lora:name[:model_weight[:clip_weight]][:LBW=...][:LOADER=...]>``
    を扱う。LBW の名前付き preset は既存の ``preset:weights`` 表記も受け付ける。
    """
    loras = []
    seen = set()
    for match in _LORA_TAG.finditer(text):
        fields = match.group(1).split(":")
        name = fields[0].strip()
        if not name:
            raise ValueError("[SAX_Bridge] LoRA tag requires a name.")
        weights = []
        lbw = lbw_a = lbw_b = loader = None
        index = 1
        while index < len(fields):
            field = fields[index].strip()
            index += 1
            if field.startswith("LBW="):
                value = field[4:]
                if re.fullmatch(r"[A-Za-z][A-Za-z0-9_-]*", value) and index < len(fields):
                    following = fields[index].strip()
                    if not following.startswith(("LBW=", "LOADER=")):
                        value = following
                        index += 1
                for part in value.split(";"):
                    part = part.strip()
                    if part.startswith(("A=", "B=")):
                        try:
                            number = float(part[2:])
                        except ValueError:
                            number = 1.0
                        if not math.isfinite(number):
                            raise ValueError("[SAX_Bridge] LoRA block weights must be finite.")
                        if part.startswith("A="):
                            lbw_a = number
                        else:
                            lbw_b = number
                    elif part:
                        lbw = part
            elif field.startswith("LOADER="):
                loader = field[7:]
            elif field and len(weights) < 2:
                try:
                    weight = float(field)
                except ValueError:
                    continue
                if not math.isfinite(weight):
                    raise ValueError("[SAX_Bridge] LoRA weights must be finite.")
                weights.append(weight)
        model_weight = weights[0] if weights else 1.0
        clip_weight = weights[1] if len(weights) > 1 else model_weight
        if name not in seen:
            loras.append((name, model_weight, clip_weight, lbw, lbw_a, lbw_b, loader))
            seen.add(name)
    return _LORA_TAG.sub("", text), loras
