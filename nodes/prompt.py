import logging
import os

import folder_paths
import nodes
from nodes import ConditioningConcat
from comfy_api.latest import io

from .io_types import PipeLine, filter_new_loras, record_applied_loras


logger = logging.getLogger(__name__)


def _get_impact_wildcards():
    """
    impact.wildcards モジュールを遅延取得する。
    Impact Pack はオプション依存のため、未インストール時は None を返す。
    呼び出し側で None の場合はワイルドカード展開をスキップしてテキストをそのまま使う。
    """
    try:
        import impact.wildcards
        return impact.wildcards
    except ImportError:
        logger.warning(
            "[SAX_Bridge] ComfyUI-Impact-Pack is not installed. "
            "Wildcard expansion will be skipped."
        )
        return None


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

    # INTERNAL API: cond_stage_model / load_model / patcher.load_device は
    # ComfyUI 内部 API。バージョン更新時に要確認。
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

    try:
        result = None
        for chunk in chunks:
            o = cond_model.encode_token_weights(clip.tokenize(chunk))
            cond, pooled = o[:2]
            conditioning = [[cond, {"pooled_output": pooled}]]
            result = concat_node.concat(result, conditioning)[0] if result else conditioning

        return result
    finally:
        # vbar 復元
        for m, saved in saved_modules:
            m.__dict__.update(saved)


def _apply_loras(model, clip, loras):
    """
    extract_lora_values で取得した LoRA リストを適用する。
    loras: [(lora_name, model_weight, clip_weight, lbw, lbw_a, lbw_b, loader), ...]
    戻り値: (model, clip, applied_names) — applied_names は実際に適用できたLoRA名のリスト
    """
    applied_names = []
    for lora_name, model_weight, clip_weight, lbw, lbw_a, lbw_b, loader in loras:
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
                f"[SAX_Bridge] LOAD LORA: {lora_name}: "
                f"model={model_weight}, clip={clip_weight}, "
                f"LBW={lbw}, LOADER={loader}"
            )

            if loader == "nunchaku":
                if "NunchakuFluxLoraLoader" in nodes.NODE_CLASS_MAPPINGS:
                    cls = nodes.NODE_CLASS_MAPPINGS["NunchakuFluxLoraLoader"]
                    model = cls().load_lora(model, lora_name, model_weight)[0]
                    applied_names.append(orig_lora_name)
                else:
                    logging.warning(
                        "[SAX_Bridge] 'NunchakuFluxLoraLoader' not found. "
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
                        applied_names.append(orig_lora_name)
                    else:
                        logging.warning(
                            "[SAX_Bridge] 'Inspire Pack' is not installed. "
                            "LBW= attribute is ignored."
                        )
                        model, clip = default_lora()
                        applied_names.append(orig_lora_name)
                else:
                    model, clip = default_lora()
                    applied_names.append(orig_lora_name)
        else:
            logging.warning(f"[SAX_Bridge] LORA NOT FOUND: {orig_lora_name}")

    return model, clip, applied_names


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


class SAX_Bridge_Prompt(io.ComfyNode):
    """
    Impact Pack の ImpactWildcardEncode を改良したノード。
    - Pipe 方式の入出力（Easy-Use 親和性）
    - populated prompt UI の撤去
    - CUDA デバイス不一致エラーの根本解消
    - BREAK 構文のサポート
    - LoRA 構文のサポート
    """

    @classmethod
    def define_schema(cls) -> io.Schema:
        wildcard_list = ["Select the Wildcard to add to the text"]
        try:
            import impact.wildcards
            wl = impact.wildcards.get_wildcard_list()
            if wl:
                wildcard_list = wildcard_list + wl
        except Exception:
            pass

        return io.Schema(
            node_id="SAX_Bridge_Prompt",
            display_name="SAX Prompt",
            category="SAX/Bridge/Prompt",
            inputs=[
                PipeLine.Input("pipe"),
                io.String.Input(
                    "wildcard_text",
                    multiline=True,
                    tooltip="Enter your prompt using wildcard syntax. LoRA syntax and BREAK syntax are also supported.",
                ),
                io.Combo.Input(
                    "select_to_add_lora",
                    options=["Select the LoRA to add to the text"] + folder_paths.get_filename_list("loras"),
                ),
                io.Combo.Input("select_to_add_wildcard", options=wildcard_list),
            ],
            outputs=[
                PipeLine.Output(display_name="PIPE"),
                io.String.Output(display_name="POPULATED_TEXT"),
            ],
        )

    @classmethod
    def execute(cls, pipe, wildcard_text, **kwargs) -> io.NodeOutput:
        wildcards = _get_impact_wildcards()

        model = pipe.get("model")
        clip = pipe.get("clip")

        if model is None:
            raise ValueError("[SAX_Bridge] Pipe does not contain a model.")
        if clip is None:
            raise ValueError("[SAX_Bridge] Pipe does not contain a CLIP model.")

        actual_seed = pipe.get("seed", 0)
        if wildcards is not None:
            populated = wildcards.process(wildcard_text, actual_seed)
            loras = wildcards.extract_lora_values(populated)
            clean_text = wildcards.remove_lora_tags(populated)
        else:
            populated = wildcard_text
            loras = []
            clean_text = wildcard_text

        new_loras = filter_new_loras(pipe, loras)
        applied_names = []
        if new_loras:
            model, clip, applied_names = _apply_loras(model, clip, new_loras)

        conditioning = _encode_with_break(clip, clean_text)

        new_pipe = {
            **pipe,
            "model": model,
            "clip": clip,
            "positive": conditioning,
        }

        record_applied_loras(new_pipe, applied_names)

        loader_settings = new_pipe.get("loader_settings")
        if isinstance(loader_settings, dict):
            new_pipe["loader_settings"] = {
                **loader_settings,
                "positive": clean_text,
            }

        return io.NodeOutput(new_pipe, populated)


class SAX_Bridge_Prompt_Concat(io.ComfyNode):
    """
    可変テキスト入力に対応した Wildcard エンコーダー。
    テキストを改行で連結 → Wildcard/LoRA 展開 → CLIP エンコード → Pipe 更新。
    """

    @classmethod
    def define_schema(cls):
        autogrow_template = io.Autogrow.TemplatePrefix(
            io.String.Input("text"),
            prefix="text",
            min=1,
            max=10,
        )
        return io.Schema(
            node_id="SAX_Bridge_Prompt_Concat",
            display_name="SAX Prompt Concat",
            description="Concatenates multiple text inputs, expands Wildcards/LoRA tags, and encodes them with CLIP.",
            category="SAX/Bridge/Prompt",
            inputs=[
                PipeLine.Input("pipe"),
                io.Boolean.Input(
                    "target_positive",
                    default=True,
                    label_on="positive",
                    label_off="negative",
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
        texts: io.Autogrow.Type,
    ) -> io.NodeOutput:
        wildcards = _get_impact_wildcards()

        target_type = "positive" if target_positive else "negative"

        text_values = []
        for val in texts.values():
            if val is not None and isinstance(val, str) and val.strip():
                text_values.append(val.strip())

        wildcard_text = "\n".join(text_values)

        if not wildcard_text.strip():
            empty_cond = pipe.get(target_type)
            return io.NodeOutput(pipe, empty_cond, "")

        model = pipe.get("model")
        clip = pipe.get("clip")

        if model is None:
            raise ValueError("[SAX_Bridge] Pipe does not contain a model.")
        if clip is None:
            raise ValueError("[SAX_Bridge] Pipe does not contain a CLIP model.")

        actual_seed = pipe.get("seed", 0)
        if wildcards is not None:
            populated = wildcards.process(wildcard_text, actual_seed)
            loras = wildcards.extract_lora_values(populated)
            clean_text = wildcards.remove_lora_tags(populated)
        else:
            populated = wildcard_text
            loras = []
            clean_text = wildcard_text

        new_loras = filter_new_loras(pipe, loras)
        applied_names = []
        if new_loras:
            model, clip, applied_names = _apply_loras(model, clip, new_loras)

        conditioning = _encode_with_break(clip, clean_text)

        new_pipe = {
            **pipe,
            "model": model,
            "clip": clip,
            target_type: conditioning,
        }

        record_applied_loras(new_pipe, applied_names)

        loader_settings = new_pipe.get("loader_settings")
        if isinstance(loader_settings, dict):
            new_pipe["loader_settings"] = {
                **loader_settings,
                target_type: clean_text,
            }

        return io.NodeOutput(new_pipe, conditioning, populated)


