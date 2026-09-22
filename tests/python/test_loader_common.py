"""nodes/loader_common.py の共通定義と、2 つの Loader が食い違わないことの検証。

SAX Loader と SAX Diffusion Loader は読み込み手段だけが異なり、サンプリング設定
ウィジェットと出力 pipe の構造は同一でなければならない。片方だけ直したときに
ここで落ちるようにしておく。
"""

from unittest.mock import MagicMock, patch

import pytest
import torch

from nodes import loader_common
from nodes.loader import SAX_Bridge_Loader
from nodes.loader_diffusion import SAX_Bridge_Loader_Diffusion

# 両 Loader が共通で持つサンプリング設定ウィジェット（並び順込み）
_SAMPLING_WIDGETS = [
    "seed", "steps", "cfg", "sampler_name", "scheduler_name",
    "denoise", "width", "height", "batch_size",
]


def _input_ids(node_cls):
    return [getattr(i, "id", None) for i in node_cls.define_schema().inputs]


class TestSamplingInputs:
    def test_names_and_order(self):
        assert [i.id for i in loader_common.sampling_inputs()] == _SAMPLING_WIDGETS

    def test_returns_fresh_instances(self):
        """スキーマ間で Input インスタンスを共有しない（片方の変更が他方に漏れない）。"""
        a, b = loader_common.sampling_inputs(), loader_common.sampling_inputs()
        assert all(x is not y for x, y in zip(a, b))

    @pytest.mark.parametrize("node_cls", [SAX_Bridge_Loader, SAX_Bridge_Loader_Diffusion])
    def test_both_loaders_end_with_sampling_widgets(self, node_cls):
        assert _input_ids(node_cls)[-len(_SAMPLING_WIDGETS):] == _SAMPLING_WIDGETS


class TestResolvePath:
    def test_returns_path(self):
        with patch("nodes.loader_common.folder_paths.get_full_path", return_value="/m/a.safetensors"):
            assert loader_common.resolve_path("loras", "a.safetensors", "X") == "/m/a.safetensors"

    def test_missing_raises_with_name(self):
        with patch("nodes.loader_common.folder_paths.get_full_path", return_value=None):
            with pytest.raises(ValueError, match="X not found: a.safetensors"):
                loader_common.resolve_path("loras", "a.safetensors", "X")


class TestApplySingleLora:
    def test_none_is_noop(self):
        model, clip = MagicMock(), MagicMock()
        out_model, out_clip, names = loader_common.apply_single_lora(model, clip, "None", 1.0, "L")
        assert (out_model, out_clip, names) == (model, clip, [])

    def test_applied_and_recorded(self):
        model, clip = MagicMock(), MagicMock()
        patched = (MagicMock(), MagicMock())
        with patch("nodes.loader_common.folder_paths.get_full_path", return_value="/m/l.safetensors"), \
             patch("nodes.loader_common.comfy.utils.load_torch_file", return_value={}), \
             patch("nodes.loader_common.comfy.sd.load_lora_for_models", return_value=patched):
            out_model, out_clip, names = loader_common.apply_single_lora(model, clip, "l.safetensors", 0.8, "L")
        assert (out_model, out_clip) == patched
        assert names == ["l.safetensors"]


class TestEmptyLatent:
    @pytest.mark.parametrize("w,h,b", [(512, 512, 1), (768, 512, 2), (1024, 1024, 4)])
    def test_shape_and_device(self, w, h, b):
        latent = loader_common.empty_latent(w, h, b)
        assert latent["samples"].shape == (b, 4, h // 8, w // 8)
        assert latent["samples"].device.type == "cpu"
        assert torch.count_nonzero(latent["samples"]) == 0


class TestBuildPipe:
    def _pipe(self, **overrides):
        kwargs = dict(
            model="M", clip="C", vae="V", latent={"samples": None}, seed=7,
            steps=20, cfg=8.0, sampler_name="euler", scheduler_name="normal",
            denoise=1.0, width=512, height=768, batch_size=2,
        )
        kwargs.update(overrides)
        return loader_common.build_pipe(**kwargs)

    def test_top_level_keys(self):
        assert set(self._pipe()) == {
            "model", "clip", "vae", "positive", "negative",
            "samples", "images", "seed", "loader_settings",
        }

    def test_scheduler_name_is_stored_as_scheduler(self):
        """pipe 側のキーは "scheduler"。KSampler がこの名前で読む。"""
        settings = self._pipe()["loader_settings"]
        assert settings["scheduler"] == "normal"
        assert "scheduler_name" not in settings

    def test_size_stored_as_clip_width_height(self):
        settings = self._pipe()["loader_settings"]
        assert (settings["clip_width"], settings["clip_height"]) == (512, 768)

    def test_independent_instances(self):
        """呼び出しごとに別 dict（loader_settings も共有しない）。"""
        a, b = self._pipe(), self._pipe()
        assert a is not b
        assert a["loader_settings"] is not b["loader_settings"]
