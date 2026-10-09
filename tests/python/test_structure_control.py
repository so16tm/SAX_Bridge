"""structure_control（ControlNet 構造拘束）と Structure Lock ノードのテスト。

ComfyUI ランタイム非依存の純粋ロジックのみを検証する。
CN ロード・ksampler・detector 実体は対象外（mock / monkeypatch）。
"""

import sys
import types
from unittest.mock import MagicMock, patch

import pytest
import torch

import folder_paths

from nodes.structure_control import (
    STRUCTURE_CONTROL_KEY,
    StructureApplyResult,
    apply_structure_control_cfg,
    build_structure_hint,
    set_structure_control,
    set_union_control_type,
)
from nodes.structure_lock import SAX_Bridge_Structure_Lock

# ComfyUI 実体 (comfy/cldm/control_types.py) と同一内容
_REAL_UNION_TYPES = {
    "openpose": 0,
    "depth": 1,
    "hed/pidi/scribble/ted": 2,
    "canny/lineart/anime_lineart/mlsd": 3,
    "normal": 4,
    "segment": 5,
    "tile": 6,
    "repaint": 7,
}


def _make_images(b: int = 1, h: int = 16, w: int = 16, c: int = 3) -> torch.Tensor:
    """(B, H, W, C) 形式のランダム画像を生成する。"""
    return torch.rand(b, h, w, c)


def _make_cfg(**overrides) -> dict:
    """standard_cn の有効な structure_control 設定 dict を生成する。"""
    cfg = {
        "backend": "standard_cn",
        "mode": "tile",
        "strength": 0.6,
        "start_percent": 0.0,
        "end_percent": 1.0,
        "controlnet_name": "union_cn.safetensors",
    }
    cfg.update(overrides)
    return cfg


def _install_union_types(monkeypatch) -> None:
    """comfy.cldm.control_types を実体相当の dict を持つモジュールへ差し替える。"""
    control_types = types.ModuleType("comfy.cldm.control_types")
    control_types.UNION_CONTROLNET_TYPES = dict(_REAL_UNION_TYPES)
    monkeypatch.setitem(sys.modules, "comfy.cldm.control_types", control_types)


def _cn_mocks():
    """(control_net, loader, apply_node) の CN 適用系 mock 一式を生成する。"""
    control_net = MagicMock()
    control_net.copy.return_value = MagicMock()
    loader = MagicMock()
    loader.load_controlnet.return_value = (control_net,)
    apply_node = MagicMock()
    apply_node.apply_controlnet.return_value = ("patched_pos", "patched_neg")
    return control_net, loader, apply_node


@pytest.mark.parametrize("start,end", [(0.8, 0.2), (0.5, 0.5), (-0.1, 1.), (0., 1.1), (float("nan"), 1.)])
def test_structure_lock_rejects_empty_or_invalid_sampling_range(start, end):
    with pytest.raises(ValueError, match="start_percent < end_percent"):
        SAX_Bridge_Structure_Lock.execute({}, "union_cn.safetensors", "tile", 0.6, start, end)


def test_pipe_structure_settings_reject_reversed_range():
    _, loader, apply_node = _cn_mocks()
    with patch("nodes.structure_control.nodes.ControlNetLoader", return_value=loader, create=True), patch("nodes.structure_control.nodes.ControlNetApplyAdvanced", return_value=apply_node, create=True):
        with pytest.raises(ValueError, match="start_percent < end_percent"):
            apply_structure_control_cfg(_make_cfg(start_percent=0.8, end_percent=0.2), [], [], _make_images(), object())
    apply_node.apply_controlnet.assert_not_called()


class TestSetUnionControlType:
    def _assert_mode_maps_to(self, monkeypatch, mode: str, expected: int) -> None:
        # Arrange
        _install_union_types(monkeypatch)
        control_net = MagicMock()
        copied = MagicMock()
        control_net.copy.return_value = copied

        # Act
        result = set_union_control_type(control_net, mode)

        # Assert
        copied.set_extra_arg.assert_called_once_with("control_type", [expected])
        assert result is copied

    def test_tile_maps_to_six(self, monkeypatch):
        self._assert_mode_maps_to(monkeypatch, "tile", 6)

    def test_depth_maps_to_one(self, monkeypatch):
        self._assert_mode_maps_to(monkeypatch, "depth", 1)

    def test_openpose_maps_to_zero(self, monkeypatch):
        self._assert_mode_maps_to(monkeypatch, "openpose", 0)

    def test_lineart_maps_to_composite_key_three(self, monkeypatch):
        # lineart は複合キー "canny/lineart/anime_lineart/mlsd" に属する
        self._assert_mode_maps_to(monkeypatch, "lineart", 3)

    def test_invalid_mode_only_copies(self, monkeypatch):
        # Arrange
        _install_union_types(monkeypatch)
        control_net = MagicMock()
        copied = MagicMock()
        control_net.copy.return_value = copied

        # Act
        result = set_union_control_type(control_net, "bogus")

        # Assert
        copied.set_extra_arg.assert_not_called()
        assert result is copied


class TestBuildStructureHint:
    def test_tile_hint_shape_matches_input(self):
        # Arrange
        images = _make_images(2, 16, 24, 3)

        # Act
        hint = build_structure_hint(images, "tile")

        # Assert
        assert hint is not None
        assert hint.shape == (2, 16, 24, 3)

    def test_tile_hint_value_range_normalized(self):
        # Arrange
        images = _make_images(1, 16, 16, 3) * 2.0 - 0.5  # -0.5〜1.5

        # Act
        hint = build_structure_hint(images, "tile")

        # Assert
        assert hint is not None
        assert hint.min() >= 0.0
        assert hint.max() <= 1.0

    def test_unknown_mode_returns_none(self):
        # Arrange
        images = _make_images(1, 16, 16, 3)

        # Act
        hint = build_structure_hint(images, "bogus")

        # Assert
        assert hint is None

    @pytest.mark.parametrize("mode", ["depth", "openpose", "lineart"])
    def test_detector_modes_return_none_when_aux_missing(self, monkeypatch, mode):
        # Arrange
        monkeypatch.setattr("nodes.structure_control._HAS_CONTROLNET_AUX", False)
        images = _make_images(1, 16, 16, 3)

        # Act
        hint = build_structure_hint(images, mode)

        # Assert — 未導入時は None（フォールバックは呼び出し側の責務）
        assert hint is None

    def test_depth_resizes_mismatched_detector_output(self, monkeypatch):
        # Arrange — detector が入力と異なる HxW の深度を返してもリサイズで揃える
        import numpy as np

        monkeypatch.setattr("nodes.structure_control._HAS_CONTROLNET_AUX", True)

        def fake_detector(arr):
            return np.zeros((8, 8), dtype=np.uint8)  # 入力 16x16 と不一致

        monkeypatch.setattr(
            "nodes.structure_control._get_depth_detector", lambda: fake_detector
        )
        images = _make_images(1, 16, 16, 3)

        # Act
        hint = build_structure_hint(images, "depth")

        # Assert
        assert hint is not None
        assert hint.shape == (1, 16, 16, 3)

    def test_openpose_blank_output_returns_none(self, monkeypatch):
        # Arrange — 全黒出力 = キーポイント検出ゼロは失敗として None
        import numpy as np

        monkeypatch.setattr("nodes.structure_control._HAS_CONTROLNET_AUX", True)

        def blank_detector(arr):
            return np.zeros((16, 16, 3), dtype=np.uint8)

        monkeypatch.setattr(
            "nodes.structure_control._get_pose_detector", lambda: blank_detector
        )
        images = _make_images(1, 16, 16, 3)

        # Act
        hint = build_structure_hint(images, "openpose")

        # Assert
        assert hint is None


class TestSetStructureControl:
    def test_returns_new_dict_and_keeps_original_untouched(self):
        # Arrange
        pipe = {"model": "m", "seed": 1}
        cfg = _make_cfg()

        # Act
        new_pipe = set_structure_control(pipe, cfg)

        # Assert — イミュータブル更新
        assert new_pipe is not pipe
        assert new_pipe[STRUCTURE_CONTROL_KEY] == cfg
        assert new_pipe["model"] == "m"
        assert STRUCTURE_CONTROL_KEY not in pipe

    def test_overwrite_last_one_wins(self):
        # Arrange
        first = _make_cfg(mode="tile")
        second = _make_cfg(mode="depth")
        pipe = set_structure_control({}, first)

        # Act — 上書きはエラーにせず後勝ち
        new_pipe = set_structure_control(pipe, second)

        # Assert
        assert new_pipe[STRUCTURE_CONTROL_KEY] == second
        assert pipe[STRUCTURE_CONTROL_KEY] == first


class TestApplyStructureControlDispatch:
    def test_none_cfg_passes_everything_through(self):
        # Arrange
        positive, negative, model = MagicMock(), MagicMock(), MagicMock()
        images = _make_images()

        # Act — キー無し（Structure Lock 未配置）は無音の正常系
        result = apply_structure_control_cfg(None, positive, negative, images, model)

        # Assert
        assert isinstance(result, StructureApplyResult)
        assert result.positive is positive
        assert result.negative is negative
        assert result.model is model

    def test_standard_cn_patches_conditioning_and_passes_model_through(self, monkeypatch):
        # Arrange
        _install_union_types(monkeypatch)
        positive, negative, model = MagicMock(), MagicMock(), MagicMock()
        images = _make_images(1, 16, 16, 3)
        _, loader, apply_node = _cn_mocks()

        with patch("nodes.ControlNetLoader", return_value=loader, create=True), \
             patch("nodes.ControlNetApplyAdvanced", return_value=apply_node, create=True):
            # Act
            result = apply_structure_control_cfg(
                _make_cfg(strength=0.8), positive, negative, images, model
            )

        # Assert — conditioning はパッチ、model は素通し（lllite 用 seam）
        assert result.positive == "patched_pos"
        assert result.negative == "patched_neg"
        assert result.model is model
        call = apply_node.apply_controlnet.call_args
        assert call.args[4] == 0.8  # strength（位置引数 5 番目）
        assert call.kwargs.get("vae") is None

    def test_start_end_percent_passed_to_apply(self, monkeypatch):
        # Arrange
        _install_union_types(monkeypatch)
        images = _make_images(1, 16, 16, 3)
        _, loader, apply_node = _cn_mocks()

        with patch("nodes.ControlNetLoader", return_value=loader, create=True), \
             patch("nodes.ControlNetApplyAdvanced", return_value=apply_node, create=True):
            # Act
            apply_structure_control_cfg(
                _make_cfg(start_percent=0.2, end_percent=0.8),
                MagicMock(), MagicMock(), images, MagicMock(),
            )

        # Assert
        call = apply_node.apply_controlnet.call_args
        assert call.args[5] == 0.2
        assert call.args[6] == 0.8

    def test_lllite_raises_not_implemented(self):
        # Act & Assert — Phase 2 予定の backend は明示エラー
        with pytest.raises(NotImplementedError):
            apply_structure_control_cfg(
                _make_cfg(backend="lllite"),
                MagicMock(), MagicMock(), _make_images(), MagicMock(),
            )

    def test_unknown_backend_raises_value_error(self):
        # Act & Assert
        with pytest.raises(ValueError):
            apply_structure_control_cfg(
                _make_cfg(backend="bogus"),
                MagicMock(), MagicMock(), _make_images(), MagicMock(),
            )

    def test_non_dict_cfg_raises_value_error(self):
        # Act & Assert — 他ノードが不正型を注入しても統一メッセージで fail-fast
        with pytest.raises(ValueError):
            apply_structure_control_cfg(
                ["not", "a", "dict"],
                MagicMock(), MagicMock(), _make_images(), MagicMock(),
            )


class TestApplyStandardCnFailFast:
    """設定キーが存在する = 明示意図なので、適用不能は素通しせず raise する。"""

    def test_controlnet_name_none_raises(self):
        # Act & Assert
        with pytest.raises(ValueError):
            apply_structure_control_cfg(
                _make_cfg(controlnet_name="None"),
                MagicMock(), MagicMock(), _make_images(), MagicMock(),
            )

    def test_cn_load_failure_raises(self, monkeypatch):
        # Arrange
        _install_union_types(monkeypatch)
        loader = MagicMock()
        loader.load_controlnet.side_effect = RuntimeError("broken checkpoint")

        # Act & Assert
        with patch("nodes.ControlNetLoader", return_value=loader, create=True):
            with pytest.raises(ValueError):
                apply_structure_control_cfg(
                    _make_cfg(), MagicMock(), MagicMock(), _make_images(), MagicMock()
                )

    def test_non_4d_images_raises(self):
        # Arrange
        images = torch.rand(4, 4, 4, 4, 4)  # 5D

        # Act & Assert
        with pytest.raises(ValueError):
            apply_structure_control_cfg(
                _make_cfg(), MagicMock(), MagicMock(), images, MagicMock()
            )

    def test_unknown_mode_raises(self):
        # Act & Assert
        with pytest.raises(ValueError):
            apply_structure_control_cfg(
                _make_cfg(mode="bogus"),
                MagicMock(), MagicMock(), _make_images(), MagicMock(),
            )

    def test_all_hint_builders_failing_raises(self, monkeypatch):
        # Arrange — 連鎖全滅（tile まで失敗）は fail-fast
        _install_union_types(monkeypatch)
        monkeypatch.setattr(
            "nodes.structure_control.build_structure_hint", lambda images, mode: None
        )
        _, loader, apply_node = _cn_mocks()

        # Act & Assert
        with patch("nodes.ControlNetLoader", return_value=loader, create=True), \
             patch("nodes.ControlNetApplyAdvanced", return_value=apply_node, create=True):
            with pytest.raises(ValueError):
                apply_structure_control_cfg(
                    _make_cfg(), MagicMock(), MagicMock(), _make_images(), MagicMock()
                )


class TestHintFallbackChains:
    """検出系ヒントの失敗は「劣化して効く」を優先してフォールバックする。"""

    def _apply_with_mode(self, monkeypatch, mode: str):
        """mode 指定で standard_cn を適用し、CN copy mock を返す。"""
        _install_union_types(monkeypatch)
        control_net, loader, apply_node = _cn_mocks()
        images = _make_images(1, 16, 16, 3)

        with patch("nodes.ControlNetLoader", return_value=loader, create=True), \
             patch("nodes.ControlNetApplyAdvanced", return_value=apply_node, create=True):
            result = apply_structure_control_cfg(
                _make_cfg(mode=mode), MagicMock(), MagicMock(), images, MagicMock()
            )
        return result, control_net.copy.return_value, apply_node

    def test_openpose_falls_back_to_tile_when_aux_missing(self, monkeypatch):
        # Arrange
        monkeypatch.setattr("nodes.structure_control._HAS_CONTROLNET_AUX", False)

        # Act — openpose → depth → tile の連鎖で tile に到達
        result, copied_cn, apply_node = self._apply_with_mode(monkeypatch, "openpose")

        # Assert
        assert result.positive == "patched_pos"
        apply_node.apply_controlnet.assert_called_once()
        copied_cn.set_extra_arg.assert_called_once_with("control_type", [6])

    def test_lineart_falls_back_to_tile_when_aux_missing(self, monkeypatch):
        # Arrange
        monkeypatch.setattr("nodes.structure_control._HAS_CONTROLNET_AUX", False)

        # Act
        result, copied_cn, apply_node = self._apply_with_mode(monkeypatch, "lineart")

        # Assert
        assert result.positive == "patched_pos"
        copied_cn.set_extra_arg.assert_called_once_with("control_type", [6])

    def test_openpose_detection_failure_falls_back_through_chain(self, monkeypatch):
        # Arrange — detector 準備失敗（None）は depth → tile と連鎖する
        monkeypatch.setattr("nodes.structure_control._HAS_CONTROLNET_AUX", True)
        monkeypatch.setattr("nodes.structure_control._get_pose_detector", lambda: None)
        monkeypatch.setattr("nodes.structure_control._get_depth_detector", lambda: None)

        # Act
        result, copied_cn, apply_node = self._apply_with_mode(monkeypatch, "openpose")

        # Assert — tile まで劣化して適用される
        assert result.positive == "patched_pos"
        copied_cn.set_extra_arg.assert_called_once_with("control_type", [6])

    def test_openpose_falls_back_to_depth_when_pose_fails(self, monkeypatch):
        # Arrange — pose のみ失敗、depth は成功 → depth type で適用
        import numpy as np

        monkeypatch.setattr("nodes.structure_control._HAS_CONTROLNET_AUX", True)
        monkeypatch.setattr("nodes.structure_control._get_pose_detector", lambda: None)

        def fake_depth_detector(arr):
            return np.full((16, 16), 128, dtype=np.uint8)

        monkeypatch.setattr(
            "nodes.structure_control._get_depth_detector", lambda: fake_depth_detector
        )

        # Act
        result, copied_cn, apply_node = self._apply_with_mode(monkeypatch, "openpose")

        # Assert
        assert result.positive == "patched_pos"
        copied_cn.set_extra_arg.assert_called_once_with("control_type", [1])


class TestStructureLockNode:
    def test_none_controlnet_raises(self):
        # Act & Assert — 配置したのに CN 未指定は設定ミスとして fail-fast
        with pytest.raises(ValueError):
            SAX_Bridge_Structure_Lock.execute(
                {}, controlnet_name="None", mode="tile", strength=0.6
            )

    def test_unknown_mode_raises_at_placement(self, monkeypatch):
        # Arrange
        monkeypatch.setattr(
            folder_paths, "get_filename_list", lambda kind: ["union_cn.safetensors"]
        )

        # Act & Assert — 不正 mode は消費点まで遅延させず配置時点で fail-fast
        with pytest.raises(ValueError):
            SAX_Bridge_Structure_Lock.execute(
                {}, controlnet_name="union_cn.safetensors", mode="bogus", strength=0.6
            )

    def test_unlisted_controlnet_raises(self, monkeypatch):
        # Arrange
        monkeypatch.setattr(
            folder_paths, "get_filename_list", lambda kind: ["union_cn.safetensors"]
        )

        # Act & Assert
        with pytest.raises(ValueError):
            SAX_Bridge_Structure_Lock.execute(
                {}, controlnet_name="missing.safetensors", mode="tile", strength=0.6
            )

    def test_execute_sets_cfg_on_new_pipe(self, monkeypatch):
        # Arrange
        monkeypatch.setattr(
            folder_paths, "get_filename_list", lambda kind: ["union_cn.safetensors"]
        )
        pipe = {"model": "m"}

        # Act
        output = SAX_Bridge_Structure_Lock.execute(
            pipe, controlnet_name="union_cn.safetensors", mode="openpose",
            strength=0.7, start_percent=0.1, end_percent=0.9,
        )

        # Assert — 元 pipe は不変、新 pipe に設定 dict のみ載る
        new_pipe = output[0]
        assert STRUCTURE_CONTROL_KEY not in pipe
        assert new_pipe[STRUCTURE_CONTROL_KEY] == {
            "backend": "standard_cn",
            "mode": "openpose",
            "strength": 0.7,
            "start_percent": 0.1,
            "end_percent": 0.9,
            "controlnet_name": "union_cn.safetensors",
        }
        assert new_pipe["model"] == "m"
