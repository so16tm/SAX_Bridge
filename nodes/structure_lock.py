"""
SAX Structure Lock ノード — pipe に ControlNet 構造拘束の設定を載せる。

ノード配置 = 有効、未配置 = 完全素通し（「見えるのに効かない UI」を作らない）。
CN の実ロードは行わず設定のみを pipe に載せる（ロードは消費点の Detailer / Upscaler）。
"""
import logging

import folder_paths
from comfy_api.latest import io

from .io_types import PipeLine
from .structure_control import _VALID_LOCK_MODES, set_structure_control

logger = logging.getLogger("SAX_Bridge")

_MODES = ["tile", "depth", "openpose", "lineart"]


class SAX_Bridge_Structure_Lock(io.ComfyNode):
    """SDXL 向け ControlNet 構造拘束の設定キャリアノード。

    下流の Detailer / Upscaler が pipe["structure_control"] を消費し、
    処理対象画像から内部生成した構造ヒントで人体広域破綻を防止する。
    """

    @classmethod
    def define_schema(cls) -> io.Schema:
        return io.Schema(
            node_id="SAX_Bridge_Structure_Lock",
            display_name="SAX Structure Lock (SDXL)",
            category="SAX/Bridge/Control",
            description=(
                "Adds a ControlNet structure constraint to the pipe. "
                "Downstream Detailer / Upscaler nodes generate structure hints "
                "internally from the processed image and apply the ControlNet "
                "to prevent anatomical breakdown. Placing this node enables the "
                "constraint; removing it disables it completely."
            ),
            inputs=[
                PipeLine.Input("pipe"),
                io.Combo.Input(
                    "controlnet_name",
                    options=["None"] + folder_paths.get_filename_list("controlnet"),
                    default="None",
                    tooltip="ControlNet model for the structure constraint. "
                            "Union ControlNet (SDXL) is recommended.",
                ),
                io.Combo.Input(
                    "mode", options=_MODES, default="tile",
                    tooltip="Structure hint type. tile=blurred-structure lock (no extra deps), "
                            "depth=depth lock, openpose=pose skeleton lock, lineart=line art lock. "
                            "depth/openpose/lineart need controlnet_aux and fall back "
                            "to tile when unavailable.",
                ),
                io.Float.Input(
                    "strength", default=0.6, min=0.0, max=1.5, step=0.05,
                    tooltip="Structure constraint strength. 0.6=balanced. "
                            "Higher values lock structure more strongly.",
                ),
                io.Float.Input(
                    "start_percent", default=0.0, min=0.0, max=1.0, step=0.05,
                    optional=True,
                    tooltip="Sampling step range start for the ControlNet (0.0=first step).",
                ),
                io.Float.Input(
                    "end_percent", default=1.0, min=0.0, max=1.0, step=0.05,
                    optional=True,
                    tooltip="Sampling step range end for the ControlNet (1.0=last step).",
                ),
            ],
            outputs=[
                PipeLine.Output("PIPE"),
            ],
        )

    @classmethod
    def execute(
        cls,
        pipe: dict,
        controlnet_name: str,
        mode: str,
        strength: float,
        start_percent: float = 0.0,
        end_percent: float = 1.0,
    ) -> io.NodeOutput:
        # 配置した = 有効化の明示意図。不正設定は消費点まで遅延させず配置時点で fail-fast する。
        if mode not in _VALID_LOCK_MODES:
            raise ValueError(
                f"[SAX_Bridge] Structure Lock: unknown mode '{mode}'. "
                f"Expected one of {sorted(_VALID_LOCK_MODES)}."
            )
        if controlnet_name == "None":
            raise ValueError(
                "[SAX_Bridge] Structure Lock: controlnet_name is 'None'. "
                "Select a ControlNet model (Union ControlNet recommended) "
                "or remove this node."
            )
        available = folder_paths.get_filename_list("controlnet")
        if controlnet_name not in available:
            raise ValueError(
                f"[SAX_Bridge] Structure Lock: ControlNet '{controlnet_name}' "
                "was not found in the controlnet folder."
            )

        cfg = {
            "backend": "standard_cn",
            "mode": mode,
            "strength": strength,
            "start_percent": start_percent,
            "end_percent": end_percent,
            "controlnet_name": controlnet_name,
        }
        return io.NodeOutput(set_structure_control(pipe, cfg))
