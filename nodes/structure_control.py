"""
ControlNet 構造拘束（カプセル化）ユーティリティ。

SDXL / アニメ SDXL の i2i・アップスケール・Detailer で発生する人体広域破綻
（臍・胸・四肢・構図崩れ）を、処理対象画像から内部生成した構造ヒントと
ControlNet（Union tile / depth / openpose / lineart）で防止する。

設定は SAX Structure Lock ノードが pipe["structure_control"] に載せ、
Detailer / Upscaler が消費点で CN をロード・適用する
（ノード配置 = 有効、未配置 = 完全素通し）。

VAE encode/decode は一切呼ばない（構造ヒントは pixel 空間で渡す）。
"""
import logging
import threading
from dataclasses import dataclass
from typing import Callable, Protocol

import torch
import nodes

from .noise import SAXNoiseEngine

logger = logging.getLogger("SAX_Bridge")

# pipe 上の設定キャリアキー（Structure Lock ノードが設定、Detailer / Upscaler が消費）
STRUCTURE_CONTROL_KEY = "structure_control"


class ControlNetLike(Protocol):
    """ControlNet の最小インタフェース（ダックタイピング用）。"""

    def copy(self) -> "ControlNetLike": ...

    def set_extra_arg(self, key: str, value: object) -> None: ...


# Tile ヒント生成の経験値（マジックナンバー回避）
_TILE_DOWNSCALE_FACTOR = 0.5  # 入力をこの倍率で縮小してから元サイズへ戻す
_TILE_BLUR_SIGMA = 1.0        # 縮小復元後に軽くぼかす強度

# ControlNetApplyAdvanced の percent 既定値（cfg 未指定時は全ステップ適用）
_START_PERCENT = 0.0
_END_PERCENT = 1.0

# mode → UNION_CONTROLNET_TYPES のキー名。
# openpose / depth / tile は単独キー、lineart は複合キーに属する。
_UNION_TYPE_KEY_MAP = {
    "openpose": "openpose",
    "depth": "depth",
    "lineart": "canny/lineart/anime_lineart/mlsd",
    "tile": "tile",
}

# Union control type のフォールバック値（実値は UNION_CONTROLNET_TYPES から引く）
_UNION_TYPE_MAP = {"openpose": 0, "depth": 1, "lineart": 3, "tile": 6}

# mode の許容値（"off" は存在しない: Structure Lock ノード配置 = 有効）
_VALID_LOCK_MODES = frozenset({"tile", "depth", "openpose", "lineart"})

# ヒント生成失敗時のフォールバック連鎖。
# 「劣化して効く」ケースなので fail-fast 対象外（連鎖全滅時のみ raise）。
_HINT_FALLBACK_CHAINS = {
    "tile": ("tile",),
    "depth": ("depth", "tile"),
    "openpose": ("openpose", "depth", "tile"),
    "lineart": ("lineart", "tile"),
}

# strength の実行時クランプ上限（UI の max と一致）
_MAX_STRUCTURE_STRENGTH = 1.5

# 検出器系ヒントは controlnet_aux 依存のため遅延 import（tile は依存ゼロを維持）
try:
    import controlnet_aux  # noqa: F401

    _HAS_CONTROLNET_AUX = True
except ImportError:
    _HAS_CONTROLNET_AUX = False

# annotator のウェイト供給元（controlnet_aux の既定リポジトリ）
_ANNOTATOR_PRETRAINED_REPO = "lllyasviel/Annotators"


class _DetectorCache:
    """detector をプロセス内で 1 度だけロードするスレッドセーフキャッシュ。

    detector はモデルウェイトのロードを伴うため、ComfyUI のワーカースレッドからの
    並行呼び出しに備え Lock + 二重チェックで初期化を保護する。一度準備に失敗したら
    failed sentinel を立て、毎回の再ロード試行（エアギャップ環境での不要な
    ネットワークアクセス）を避ける。
    """

    def __init__(self, name: str, loader: Callable[[], Callable[..., object]]) -> None:
        self._name = name
        self._loader = loader
        self._detector: Callable[..., object] | None = None
        self._failed = False
        self._lock = threading.Lock()

    def get(self) -> Callable[..., object] | None:
        if self._detector is not None:
            return self._detector
        if self._failed:
            return None
        with self._lock:
            if self._detector is not None:
                return self._detector
            if self._failed:
                return None
            try:
                self._detector = self._loader()
            except Exception as exc:  # noqa: BLE001 — 準備失敗はフォールバックに委ねる
                logger.warning(
                    "[SAX_Bridge] StructureControl: %s detector unavailable: %s",
                    self._name, exc,
                )
                self._failed = True
                return None
        return self._detector


def _load_depth_detector() -> Callable[..., object]:
    """MiDaS depth detector をロードする。"""
    from controlnet_aux import MidasDetector

    logger.info(
        "[SAX_Bridge] StructureControl: loading MiDaS depth estimator "
        "(downloads '%s' on first run)", _ANNOTATOR_PRETRAINED_REPO,
    )
    return MidasDetector.from_pretrained(_ANNOTATOR_PRETRAINED_REPO)


def _load_pose_detector() -> Callable[..., object]:
    """pose detector をロードする。DWPose を優先し、不可なら Openpose へフォールバック。

    pip 版 controlnet_aux の DWposeDetector は mmpose 系の設定引数を要求するため
    from_pretrained を持つ実装（フォーク版等）のみ試行する。
    """
    import controlnet_aux as aux

    dwpose_cls = getattr(aux, "DWposeDetector", None)
    if dwpose_cls is not None and hasattr(dwpose_cls, "from_pretrained"):
        try:
            logger.info("[SAX_Bridge] StructureControl: loading DWPose detector")
            return dwpose_cls.from_pretrained(_ANNOTATOR_PRETRAINED_REPO)
        except Exception as exc:  # noqa: BLE001 — Openpose へフォールバック
            logger.warning(
                "[SAX_Bridge] StructureControl: DWPose unavailable (%s); "
                "falling back to OpenposeDetector", exc,
            )
    from controlnet_aux import OpenposeDetector

    logger.info(
        "[SAX_Bridge] StructureControl: loading Openpose detector "
        "(downloads '%s' on first run)", _ANNOTATOR_PRETRAINED_REPO,
    )
    return OpenposeDetector.from_pretrained(_ANNOTATOR_PRETRAINED_REPO)


def _load_lineart_detector() -> Callable[..., object]:
    """lineart detector をロードする。LineartAnime を優先し、不可なら Lineart へ。"""
    import controlnet_aux as aux

    anime_cls = getattr(aux, "LineartAnimeDetector", None)
    if anime_cls is not None:
        try:
            logger.info("[SAX_Bridge] StructureControl: loading LineartAnime detector")
            return anime_cls.from_pretrained(_ANNOTATOR_PRETRAINED_REPO)
        except Exception as exc:  # noqa: BLE001 — LineartDetector へフォールバック
            logger.warning(
                "[SAX_Bridge] StructureControl: LineartAnime unavailable (%s); "
                "falling back to LineartDetector", exc,
            )
    from controlnet_aux import LineartDetector

    logger.info(
        "[SAX_Bridge] StructureControl: loading Lineart detector "
        "(downloads '%s' on first run)", _ANNOTATOR_PRETRAINED_REPO,
    )
    return LineartDetector.from_pretrained(_ANNOTATOR_PRETRAINED_REPO)


_depth_detector_cache = _DetectorCache("depth", _load_depth_detector)
_pose_detector_cache = _DetectorCache("pose", _load_pose_detector)
_lineart_detector_cache = _DetectorCache("lineart", _load_lineart_detector)


def _get_depth_detector() -> Callable[..., object] | None:
    """MiDaS depth detector を遅延生成してキャッシュする（スレッドセーフ）。失敗時は None。"""
    return _depth_detector_cache.get()


def _get_pose_detector() -> Callable[..., object] | None:
    """pose detector を遅延生成してキャッシュする（スレッドセーフ）。失敗時は None。"""
    return _pose_detector_cache.get()


def _get_lineart_detector() -> Callable[..., object] | None:
    """lineart detector を遅延生成してキャッシュする（スレッドセーフ）。失敗時は None。"""
    return _lineart_detector_cache.get()


def _union_type_number(mode: str) -> int:
    """mode に対応する Union control type 番号を返す。

    実体の UNION_CONTROLNET_TYPES を優先し、import 不可・キー欠落時は
    _UNION_TYPE_MAP にフォールバックする。列挙外 mode は -1（type 未設定）。
    """
    key = _UNION_TYPE_KEY_MAP.get(mode)
    if key is None:
        return -1
    try:
        from comfy.cldm.control_types import UNION_CONTROLNET_TYPES

        return UNION_CONTROLNET_TYPES.get(key, _UNION_TYPE_MAP[mode])
    except ImportError:
        return _UNION_TYPE_MAP[mode]


def load_structure_controlnet(controlnet_name: str) -> ControlNetLike | None:
    """ControlNet モデルをロードする。"None" / ロード失敗時は None を返す。"""
    if controlnet_name == "None":
        return None
    try:
        control_net = nodes.ControlNetLoader().load_controlnet(controlnet_name)[0]
    except Exception as exc:  # noqa: BLE001 — 失敗は警告ログ後 None 返却し呼び出し側で fail-fast 判断
        logger.warning(
            "[SAX_Bridge] StructureControl: failed to load ControlNet '%s': %s",
            controlnet_name, exc,
        )
        return None
    if control_net is None:
        logger.warning(
            "[SAX_Bridge] StructureControl: ControlNet '%s' loaded as None", controlnet_name
        )
        return None
    return control_net


def set_union_control_type(control_net: ControlNetLike, mode: str) -> ControlNetLike:
    """control_net.copy() に Union control type を設定して返す（元を変更しない）。

    mode が _VALID_LOCK_MODES 外、または type 番号が引けない場合は copy のみ返す。
    """
    cn = control_net.copy()
    type_number = _union_type_number(mode)
    if type_number >= 0:
        cn.set_extra_arg("control_type", [type_number])
    return cn


def build_structure_hint(images: torch.Tensor, mode: str) -> torch.Tensor | None:
    """(B, H, W, C) 0-1 の構造ヒントを生成する。

    tile     : 縮小→元サイズ復元→軽いぼかし（依存ゼロ）。
    depth    : controlnet_aux の MiDaS 深度推定。
    openpose : controlnet_aux の pose 検出（DWPose 優先）による骨格スティック図。
    lineart  : controlnet_aux の線画抽出（LineartAnime 優先）。

    controlnet_aux 未導入・detector 準備失敗・検出失敗時は None を返す
    （フォールバック連鎖は呼び出し側 _apply_standard_cn の責務）。列挙外 mode も None。
    """
    if mode == "tile":
        return _build_tile_hint(images)
    if mode not in _VALID_LOCK_MODES:
        return None
    if not _HAS_CONTROLNET_AUX:
        return None
    if mode == "depth":
        return _build_depth_hint(images)
    if mode == "openpose":
        return _build_openpose_hint(images)
    return _build_lineart_hint(images)


def _build_tile_hint(images: torch.Tensor) -> torch.Tensor:
    """tile 構造ヒント: 縮小→元サイズ復元→軽いガウシアンぼかし。"""
    b, h, w, c = images.shape
    rgb = images[:, :, :, :3].permute(0, 3, 1, 2)  # (B, 3, H, W)

    down_h = max(1, int(h * _TILE_DOWNSCALE_FACTOR))
    down_w = max(1, int(w * _TILE_DOWNSCALE_FACTOR))

    downscaled = torch.nn.functional.interpolate(
        rgb, size=(down_h, down_w), mode="area"
    )
    restored = torch.nn.functional.interpolate(
        downscaled, size=(h, w), mode="bilinear", align_corners=False
    )
    blurred = SAXNoiseEngine.gaussian_blur(restored, _TILE_BLUR_SIGMA)
    hint = blurred.permute(0, 2, 3, 1)  # (B, H, W, 3)
    return torch.clamp(hint, 0.0, 1.0)


def _run_detector_hint(
    images: torch.Tensor,
    detector: Callable[..., object],
    *,
    label: str,
    reject_empty: bool = False,
) -> torch.Tensor | None:
    """detector を各フレームへ適用して (B, H, W, 3) 0-1 のヒントを生成する。

    detector 出力の HxW が入力と異なる場合は入力サイズへリサイズして揃える。
    reject_empty=True の場合、全黒出力（キーポイント / 線の検出ゼロ）を
    検出失敗として None を返す。detector の実行時例外も None（フォールバック委譲）。
    """
    try:
        import numpy as np
    except ImportError:
        logger.warning(
            "[SAX_Bridge] StructureControl: numpy unavailable; skipping %s hint", label
        )
        return None

    _, h, w, _ = images.shape
    rgb = torch.clamp(images[:, :, :, :3], 0.0, 1.0)
    out_frames = []
    try:
        for frame in rgb:
            arr = (frame.cpu().numpy() * 255.0).astype(np.uint8)
            # detector は PIL.Image / ndarray を返す。grayscale(2D) は 3ch へ拡張、
            # 3D は先頭 3ch へ切り詰め、それ以外の ndim は対応不能として None を返す。
            out = detector(arr)
            out_arr = np.asarray(out).astype(np.float32) / 255.0
            if out_arr.ndim == 2:
                out_arr = np.stack([out_arr] * 3, axis=-1)
            elif out_arr.ndim == 3:
                out_arr = out_arr[:, :, :3]
            else:
                logger.warning(
                    "[SAX_Bridge] StructureControl: unexpected %s output ndim=%d; skipping",
                    label, out_arr.ndim,
                )
                return None
            if reject_empty and float(out_arr.max()) <= 0.0:
                logger.warning(
                    "[SAX_Bridge] StructureControl: %s detected nothing (blank output)",
                    label,
                )
                return None
            frame_hint = torch.from_numpy(out_arr).permute(2, 0, 1)  # (3, h', w')
            if frame_hint.shape[1] != h or frame_hint.shape[2] != w:
                frame_hint = torch.nn.functional.interpolate(
                    frame_hint.unsqueeze(0), size=(h, w),
                    mode="bilinear", align_corners=False,
                ).squeeze(0)
            out_frames.append(frame_hint.permute(1, 2, 0))  # (h, w, 3)
    except Exception as exc:  # noqa: BLE001 — 実行時失敗はフォールバック連鎖に委ねる
        logger.warning(
            "[SAX_Bridge] StructureControl: %s detector failed: %s", label, exc
        )
        return None

    hint = torch.stack(out_frames, dim=0).to(images.device)
    return torch.clamp(hint, 0.0, 1.0)


def _build_depth_hint(images: torch.Tensor) -> torch.Tensor | None:
    """depth 構造ヒント: MiDaS 深度推定で生成する。準備・実行失敗時は None。"""
    detector = _get_depth_detector()
    if detector is None:
        return None
    return _run_detector_hint(images, detector, label="depth")


def _build_openpose_hint(images: torch.Tensor) -> torch.Tensor | None:
    """openpose 構造ヒント: 骨格スティック図を生成する。検出ゼロ（全黒）は None。"""
    detector = _get_pose_detector()
    if detector is None:
        return None
    return _run_detector_hint(images, detector, label="openpose", reject_empty=True)


def _build_lineart_hint(images: torch.Tensor) -> torch.Tensor | None:
    """lineart 構造ヒント: 線画を生成する。検出ゼロ（全黒）は None。"""
    detector = _get_lineart_detector()
    if detector is None:
        return None
    return _run_detector_hint(images, detector, label="lineart", reject_empty=True)


def set_structure_control(pipe: dict, cfg: dict) -> dict:
    """pipe に structure_control 設定を載せた新しい dict を返す（イミュータブル更新）。

    既存キーがある場合は後勝ちで上書きし、logger.info で通知する（エラーにしない）。
    """
    existing = pipe.get(STRUCTURE_CONTROL_KEY)
    if existing is not None:
        logger.info(
            "[SAX_Bridge] StructureControl: overwriting existing settings "
            "(mode=%s -> %s, last one wins)",
            existing.get("mode"), cfg.get("mode"),
        )
    return {**pipe, STRUCTURE_CONTROL_KEY: cfg}


@dataclass(frozen=True)
class StructureApplyResult:
    """構造拘束の適用結果。

    standard_cn は conditioning のみパッチし model は素通しする。
    将来の lllite（モデルパッチ方式）が model を差し替えるための seam。
    """

    positive: object
    negative: object
    model: object


def apply_structure_control_cfg(
    cfg: dict | None,
    positive: object,
    negative: object,
    images: torch.Tensor,
    model: object,
) -> StructureApplyResult:
    """structure_control 設定 dict に基づき構造拘束を適用するディスパッチャ。

    cfg=None（Structure Lock 未配置）は素通し（無音・正常系）。
    cfg が存在する = 明示意図なので、適用不能は fail-fast（raise）。
    """
    if cfg is None:
        return StructureApplyResult(positive=positive, negative=negative, model=model)

    if not isinstance(cfg, dict):
        raise ValueError(
            f"[SAX_Bridge] StructureControl: settings must be a dict, "
            f"got {type(cfg).__name__}."
        )

    backend = cfg.get("backend")
    if backend == "standard_cn":
        patched_positive, patched_negative = _apply_standard_cn(
            positive, negative, images, cfg
        )
        return StructureApplyResult(
            positive=patched_positive, negative=patched_negative, model=model
        )
    if backend == "lllite":
        raise NotImplementedError(
            "[SAX_Bridge] StructureControl: backend 'lllite' is not implemented yet "
            "(planned for Phase 2)."
        )
    raise ValueError(
        f"[SAX_Bridge] StructureControl: unknown backend '{backend}'. "
        "Expected 'standard_cn' or 'lllite' (not yet implemented)."
    )


def _apply_standard_cn(
    positive: object,
    negative: object,
    images: torch.Tensor,
    cfg: dict,
) -> tuple[object, object]:
    """standard ControlNet 方式で構造ヒントを conditioning にパッチする。

    設定キーが存在する = 明示意図のため fail-fast（不正 mode・CN ロード失敗・
    ヒント生成の完全失敗は raise ValueError）。ヒント生成の mode 単位の失敗のみ
    「劣化して効く」を優先して _HINT_FALLBACK_CHAINS の順にフォールバックする。
    """
    mode = cfg.get("mode")
    if not isinstance(mode, str) or mode not in _VALID_LOCK_MODES:
        raise ValueError(
            f"[SAX_Bridge] StructureControl: unknown mode '{mode}'. "
            f"Expected one of {sorted(_VALID_LOCK_MODES)}."
        )

    if images is None or not isinstance(images, torch.Tensor) or images.ndim != 4:
        raise ValueError(
            "[SAX_Bridge] StructureControl: images must be a 4D tensor (B, H, W, C)."
        )

    controlnet_name = cfg.get("controlnet_name", "None")
    control_net = load_structure_controlnet(controlnet_name)
    if control_net is None:
        raise ValueError(
            f"[SAX_Bridge] StructureControl: failed to load ControlNet "
            f"'{controlnet_name}'. Check the Structure Lock node settings."
        )

    strength = max(0.0, min(float(cfg.get("strength", 0.6)), _MAX_STRUCTURE_STRENGTH))
    start_percent = float(cfg.get("start_percent", _START_PERCENT))
    end_percent = float(cfg.get("end_percent", _END_PERCENT))

    effective_mode: str | None = None
    hint: torch.Tensor | None = None
    for candidate in _HINT_FALLBACK_CHAINS[mode]:
        hint = build_structure_hint(images, candidate)
        if hint is not None:
            effective_mode = candidate
            break
        logger.warning(
            "[SAX_Bridge] StructureControl: %s hint unavailable", candidate
        )
    if hint is None or effective_mode is None:
        raise ValueError(
            f"[SAX_Bridge] StructureControl: failed to build any structure hint "
            f"(mode={mode})."
        )
    if effective_mode != mode:
        logger.warning(
            "[SAX_Bridge] StructureControl: mode '%s' fell back to '%s'",
            mode, effective_mode,
        )

    cn = set_union_control_type(control_net, effective_mode)

    logger.info(
        "[SAX_Bridge] StructureControl: mode=%s strength=%s range=%s-%s cn=%s",
        effective_mode, strength, start_percent, end_percent, controlnet_name,
    )
    # INTERNAL API: ComfyUI nodes.ControlNetApplyAdvanced.apply_controlnet
    # → (positive, negative) を返す。conditioning に control メタデータを付与するのみで
    #   VAE encode/decode は走らせない（構造ヒントは pixel 空間で渡す）。
    try:
        patched = nodes.ControlNetApplyAdvanced().apply_controlnet(
            positive, negative, cn, hint, strength,
            start_percent, end_percent, vae=None,
        )
    except Exception as exc:  # noqa: BLE001 — 原因を付与した ValueError へ変換して re-raise
        raise ValueError(
            f"[SAX_Bridge] StructureControl: apply_controlnet failed "
            f"(mode={effective_mode}, cn={controlnet_name}): {exc}. "
            "An SDXL ControlNet may have been applied to a non-SDXL model."
        ) from exc
    return patched[0], patched[1]
