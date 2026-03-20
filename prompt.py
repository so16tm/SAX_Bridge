import logging
import os

import folder_paths
import nodes
from nodes import ConditioningConcat
from typing_extensions import override

from comfy_api.latest import ComfyExtension, io

from .io_types import PipeLine


# ---------------------------------------------------------------------------
# Impact Pack ヘルパー（遅延インポート）
# ---------------------------------------------------------------------------
def _get_impact_wildcards():
    """
    impact.wildcards モジュールを遅延取得する。
    ノード実行時には Impact Pack は必ず初期化済みなので安全にインポートできる。
    """
    try:
        import impact.wildcards
        return impact.wildcards
    except ImportError:
        raise RuntimeError(
            "[CSB] ComfyUI-Impact-Pack がインストールされていません。"
            "Wildcard ノードを使用するには Impact Pack が必要です。"
        )


# ---------------------------------------------------------------------------
# LoRA 名キャッシュ（フォルダ mtime による自動無効化）
# ---------------------------------------------------------------------------
_lora_name_cache = None
_lora_cache_mtime = 0.0


def _get_lora_folders_mtime() -> float:
    """LoRA フォルダ群の最新更新時刻を返す"""
    try:
        mtimes = [
            os.path.getmtime(p)
            for p in folder_paths.get_folder_paths("loras")
            if os.path.isdir(p)
        ]
        return max(mtimes) if mtimes else 0.0
    except OSError:
        return 0.0


# ---------------------------------------------------------------------------
# GPU 安全 CLIP エンコード
# ---------------------------------------------------------------------------
def _encode_with_break(clip, text):
    """
    BREAK 構文をサポートした CLIP エンコード。

    ComfyUI の --fast フラグ（vbar/aimdo 動的VRAM）環境で、
    cast_bias_weight の vbar パスが weight を CPU 上のまま返す
    既知のバグを回避するため、エンコード中は _v 属性を一時除去する。

    性能のため、モデルロードと vbar 回避処理は全チャンクで 1 回のみ行う。
    """
    concat_node = ConditioningConcat()
    chunks = [c.strip() for c in text.split("BREAK") if c.strip()] or [""]

    # 1. 前処理 & モデルロード
    cond_model = clip.cond_stage_model
    cond_model.reset_clip_options()
    if clip.layer_idx is not None:
        cond_model.set_clip_options({"layer": clip.layer_idx})

    clip.load_model(clip.tokenize(text))
    cond_model.set_clip_options({"execution_device": clip.patcher.load_device})

    # 2. vbar 回避 (Workaround)
    # モジュール参照を直接保持し、復元時に named_modules() を再走査しない。
    saved_modules = []
    for _, m in cond_model.named_modules():
        d = m.__dict__
        if "_v" in d:
            saved_modules.append((m, {
                "_v": d["_v"],
                "_v_signature": d.get("_v_signature"),
                "_v_weight": d.get("_v_weight"),
                "_v_bias": d.get("_v_bias"),
            }))
            del m._v

    # 3. 各チャンクのエンコード
    try:
        result = None
        for chunk in chunks:
            o = cond_model.encode_token_weights(clip.tokenize(chunk))
            cond, pooled = o[:2]
            conditioning = [[cond, {"pooled_output": pooled}]]
            result = concat_node.concat(result, conditioning)[0] if result else conditioning

        return result
    finally:
        # 4. vbar 復元
        for m, saved in saved_modules:
            m.__dict__.update(saved)


# ---------------------------------------------------------------------------
# LoRA 適用
# ---------------------------------------------------------------------------
def _apply_loras(model, clip, loras):
    """
    extract_lora_values で取得した LoRA リストを適用する。
    loras: [(lora_name, model_weight, clip_weight, lbw, lbw_a, lbw_b, loader), ...]
    """
    for lora_name, model_weight, clip_weight, lbw, lbw_a, lbw_b, loader in loras:
        # 拡張子補完
        lora_name_ext = lora_name.split(".")
        if ("." + lora_name_ext[-1]) not in folder_paths.supported_pt_extensions:
            lora_name = lora_name + ".safetensors"

        orig_lora_name = lora_name
        lora_name = _resolve_lora_name(lora_name)

        if lora_name is not None:
            path = folder_paths.get_full_path("loras", lora_name)
        else:
            path = None

        if path is not None:
            logging.info(
                f"[CSB] LOAD LORA: {lora_name}: "
                f"model={model_weight}, clip={clip_weight}, "
                f"LBW={lbw}, LOADER={loader}"
            )

            if loader == "nunchaku":
                if "NunchakuFluxLoraLoader" in nodes.NODE_CLASS_MAPPINGS:
                    cls = nodes.NODE_CLASS_MAPPINGS["NunchakuFluxLoraLoader"]
                    model = cls().load_lora(model, lora_name, model_weight)[0]
                else:
                    logging.warning(
                        "[CSB] 'NunchakuFluxLoraLoader' not found. "
                        "LOADER=nunchaku is ignored."
                    )
            else:
                def default_lora():
                    return nodes.LoraLoader().load_lora(
                        model, clip, lora_name, model_weight, clip_weight
                    )

                if lbw is not None:
                    if "LoraLoaderBlockWeight //Inspire" in nodes.NODE_CLASS_MAPPINGS:
                        cls = nodes.NODE_CLASS_MAPPINGS["LoraLoaderBlockWeight //Inspire"]
                        model, clip, _ = cls().doit(
                            model, clip, lora_name,
                            model_weight, clip_weight,
                            False, 0, lbw_a, lbw_b, "", lbw
                        )
                    else:
                        logging.warning(
                            "[CSB] 'Inspire Pack' is not installed. "
                            "LBW= attribute is ignored."
                        )
                        model, clip = default_lora()
                else:
                    model, clip = default_lora()
        else:
            logging.warning(f"[CSB] LORA NOT FOUND: {orig_lora_name}")

    return model, clip


def _resolve_lora_name(name):
    """LoRA 名を解決する（フォルダ更新時に自動で再スキャン）"""
    global _lora_name_cache, _lora_cache_mtime
    if os.path.exists(name):
        return name

    current_mtime = _get_lora_folders_mtime()
    if _lora_name_cache is None or current_mtime > _lora_cache_mtime:
        _lora_name_cache = folder_paths.get_filename_list("loras")
        _lora_cache_mtime = current_mtime

    for x in _lora_name_cache:
        if x.endswith(name):
            return x

    return None


# ---------------------------------------------------------------------------
# SAX_Bridge_Prompt ノード（V1 スタイル）
# ---------------------------------------------------------------------------
class SAX_Bridge_Prompt:
    """
    Impact Pack の ImpactWildcardEncode を改良したノード。
    - Pipe 方式の入出力（Easy-Use 親和性）
    - populated prompt UI の撤去
    - CUDA デバイス不一致エラーの根本解消
    - BREAK 構文のサポート
    - LoRA 構文のサポート
    """

    @classmethod
    def INPUT_TYPES(s):
        # ワイルドカードリストを Impact Pack から取得（遅延インポート）
        wildcard_list = ["Select the Wildcard to add to the text"]
        try:
            import impact.wildcards
            wl = impact.wildcards.get_wildcard_list()
            if wl:
                wildcard_list = wildcard_list + wl
        except Exception:
            pass

        return {
            "required": {
                "pipe": ("PIPE_LINE",),
                "wildcard_text": (
                    "STRING",
                    {
                        "multiline": True,
                        "dynamicPrompts": False,
                        "tooltip": "ワイルドカード構文を使ってプロンプトを入力してください。LoRA構文・BREAK構文もサポートしています。",
                    },
                ),
                "seed": (
                    "INT",
                    {
                        "default": 0,
                        "min": 0,
                        "max": 0xFFFFFFFFFFFFFFFF,
                        "tooltip": "ワイルドカード処理に使用するランダムシード。",
                    },
                ),
                "select_to_add_lora": (
                    ["Select the LoRA to add to the text"]
                    + folder_paths.get_filename_list("loras"),
                ),
                "select_to_add_wildcard": (wildcard_list,),
            },
        }

    CATEGORY = "SAX/Bridge/Prompt"
    RETURN_TYPES = ("PIPE_LINE", "STRING")
    RETURN_NAMES = ("PIPE", "POPULATED_TEXT")
    FUNCTION = "doit"

    def doit(self, pipe, wildcard_text, seed, **kwargs):
        wildcards = _get_impact_wildcards()

        # --- 1. Pipe から model, clip を取得 ---
        model = pipe.get("model")
        clip = pipe.get("clip")

        if model is None:
            raise ValueError("[CSB] Pipe に model が含まれていません。")
        if clip is None:
            raise ValueError("[CSB] Pipe に clip が含まれていません。")

        # --- 2. ワイルドカード展開 ---
        populated = wildcards.process(wildcard_text, seed)

        # --- 3. LoRA タグ解析・除去 ---
        loras = wildcards.extract_lora_values(populated)
        clean_text = wildcards.remove_lora_tags(populated)

        # --- 4. LoRA 適用 ---
        if loras:
            model, clip = _apply_loras(model, clip, loras)

        # --- 5. BREAK 分割 + CLIP エンコード ---
        conditioning = _encode_with_break(clip, clean_text)

        # --- 6. Pipe を更新して出力 ---
        new_pipe = {
            **pipe,
            "model": model,
            "clip": clip,
            "positive": conditioning,
        }

        if "loader_settings" in new_pipe:
            new_pipe["loader_settings"] = {
                **new_pipe["loader_settings"],
                "positive": clean_text,
            }

        return (new_pipe, populated)


NODE_CLASS_MAPPINGS = {
    "SAX_Bridge_Prompt": SAX_Bridge_Prompt,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "SAX_Bridge_Prompt": "SAX Prompt",
}


# ---------------------------------------------------------------------------
# SAX_Bridge_Prompt_Concat ノード（V3 スタイル）
# ---------------------------------------------------------------------------
class SAX_Bridge_Prompt_Concat(io.ComfyNode):
    """
    可変テキスト入力に対応した Wildcard エンコーダー。
    テキストを改行で連結 → Wildcard/LoRA 展開 → CLIP エンコード → Pipe 更新。
    """

    @classmethod
    def define_schema(cls):
        # io.Autogrow.TemplatePrefix で可変テキストポート（min=1, max=10）を定義
        autogrow_template = io.Autogrow.TemplatePrefix(
            io.String.Input("text"),
            prefix="text",
            min=1,
            max=10,
        )
        return io.Schema(
            node_id="SAX_Bridge_Prompt_Concat",
            display_name="SAX Prompt Concat",
            description="複数テキストを連結し、Prompt/LoRA を展開して CLIP エンコードする",
            category="SAX/Bridge/Prompt",
            inputs=[
                PipeLine.Input("pipe"),
                io.Boolean.Input(
                    "target_positive",
                    default=True,
                    label_on="positive",
                    label_off="negative",
                ),
                io.Int.Input(
                    "seed",
                    default=0,
                    min=0,
                    max=0xFFFFFFFFFFFFFFFF,
                ),
                io.Autogrow.Input("texts", template=autogrow_template),
            ],
            outputs=[
                PipeLine.Output(display_name="PIPE"),
                io.Conditioning.Output(display_name="CONDITIONING"),
                io.String.Output(display_name="POPULATED_TEXT"),
            ],
        )

    @classmethod
    def execute(
        cls,
        pipe,
        target_positive,
        seed,
        texts: io.Autogrow.Type,
    ) -> io.NodeOutput:
        wildcards = _get_impact_wildcards()

        target_type = "positive" if target_positive else "negative"

        # texts は dict[str, str] — 各テキストポートの値
        text_values = []
        for val in texts.values():
            if val is not None and isinstance(val, str) and val.strip():
                text_values.append(val.strip())

        wildcard_text = "\n".join(text_values)

        # テキストが空の場合は pipe をそのまま返す
        if not wildcard_text.strip():
            empty_cond = pipe.get(target_type)
            return io.NodeOutput(pipe, empty_cond, "")

        # 基礎検証
        model = pipe.get("model")
        clip = pipe.get("clip")

        if model is None:
            raise ValueError("[CSB] Pipe に model が含まれていません。")
        if clip is None:
            raise ValueError("[CSB] Pipe に clip が含まれていません。")

        # 展開・エンコード処理
        populated = wildcards.process(wildcard_text, seed)
        loras = wildcards.extract_lora_values(populated)
        clean_text = wildcards.remove_lora_tags(populated)

        if loras:
            model, clip = _apply_loras(model, clip, loras)

        conditioning = _encode_with_break(clip, clean_text)

        # Pipe 更新
        new_pipe = {
            **pipe,
            "model": model,
            "clip": clip,
            target_type: conditioning,
        }

        if "loader_settings" in new_pipe:
            new_pipe["loader_settings"] = {
                **new_pipe["loader_settings"],
                target_type: clean_text,
            }

        return io.NodeOutput(new_pipe, conditioning, populated)


# ---------------------------------------------------------------------------
# ComfyExtension 登録
# ---------------------------------------------------------------------------
class WildcardEncodeExtension(ComfyExtension):
    @override
    async def get_node_list(self) -> list[type[io.ComfyNode]]:
        return [SAX_Bridge_Prompt_Concat]


async def comfy_entrypoint() -> WildcardEncodeExtension:
    return WildcardEncodeExtension()
