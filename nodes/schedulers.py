"""
SAX_Bridge カスタムスケジューラ登録

ComfyUI の SCHEDULER_HANDLERS に AYS (Align Your Steps) スケジューラを追加し、
Pipe ワークフローのスケジューラドロップダウンから直接選択可能にする。

AYS は NVIDIA Research の手法で、少ステップでの最適シグマスケジュールを提供する。
参考: arXiv:2404.14507 (Sabour, Fidler, Kreis 2024)
参考実装: ComfyUI 本体 comfy_extras/nodes_align_your_steps.py
"""
import logging

import numpy as np
import torch
import comfy.samplers

logger = logging.getLogger("SAX_Bridge")


# ---------------------------------------------------------------------------
# AYS ノイズレベル定義（論文 Table 1 / NVIDIA 公式実装より）
# ---------------------------------------------------------------------------
_AYS_NOISE_LEVELS = {
    "sd1": [
        14.6146412293, 6.4745760956, 3.8636745985, 2.6946151520,
        1.8841921177, 1.3943805092, 0.9642583904, 0.6523686016,
        0.3977456272, 0.1515232662, 0.0291671582,
    ],
    "sdxl": [
        14.6146412293, 6.3184485287, 3.7681790315, 2.1811480769,
        1.3405244945, 0.8620721141, 0.5550693289, 0.3798540708,
        0.2332364134, 0.1114188177, 0.0291671582,
    ],
}


def _loglinear_interp(t_steps: list, num_steps: int) -> np.ndarray:
    """ノイズレベルの対数線形補間。任意のステップ数に対応する。"""
    xs = np.linspace(0, 1, len(t_steps))
    ys = np.log(t_steps[::-1])
    new_xs = np.linspace(0, 1, num_steps)
    new_ys = np.interp(new_xs, xs, ys)
    return np.exp(new_ys)[::-1].copy()


def _ays_scheduler(model_type: str):
    """指定モデルタイプの AYS スケジューラハンドラを返す。"""
    noise_levels = _AYS_NOISE_LEVELS[model_type]

    def handler(model_sampling, steps):
        sigmas = noise_levels[:]
        if (steps + 1) != len(sigmas):
            sigmas = _loglinear_interp(sigmas, steps + 1).tolist()
        sigmas[-1] = 0.0
        return torch.FloatTensor(sigmas)

    return handler


# ---------------------------------------------------------------------------
# ComfyUI スケジューラハンドラに登録
# ---------------------------------------------------------------------------
_AYS_HANDLERS = {
    "ays_sd1": comfy.samplers.SchedulerHandler(_ays_scheduler("sd1")),
    "ays_sdxl": comfy.samplers.SchedulerHandler(_ays_scheduler("sdxl")),
}


def register_schedulers():
    """AYS スケジューラを ComfyUI のグローバルハンドラに登録する。"""
    for name, handler in _AYS_HANDLERS.items():
        if name not in comfy.samplers.SCHEDULER_HANDLERS:
            comfy.samplers.SCHEDULER_HANDLERS[name] = handler
            comfy.samplers.SCHEDULER_NAMES.append(name)
            logger.debug(f"[SAX_Bridge] Registered scheduler: {name}")
