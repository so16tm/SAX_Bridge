"""SAX_Bridge_Prompt ノードのテスト。"""

import pytest
import torch
from unittest.mock import MagicMock, patch
from nodes.prompt import SAX_Bridge_Prompt, _encode_with_break
from nodes.io_types import filter_new_loras, record_applied_loras
from nodes.prompt import _resolve_lora_name, _apply_loras


def test_resolve_lora_prefers_exact_path_and_does_not_suffix_match(monkeypatch):
    monkeypatch.setattr("nodes.prompt.folder_paths.get_filename_list", lambda _: ["other/foo.safetensors", "style/wrongfoo.safetensors", "style/foo.safetensors"])
    assert _resolve_lora_name("style/foo.safetensors") == "style/foo.safetensors"
    assert _resolve_lora_name("foo.safetensors") == "other/foo.safetensors"
    monkeypatch.setattr("nodes.prompt.folder_paths.get_filename_list", lambda _: ["style/wrongfoo.safetensors"])
    assert _resolve_lora_name("foo.safetensors") is None


def test_lora_tracking_uses_resolved_path_and_deduplicates(monkeypatch):
    monkeypatch.setattr("nodes.prompt._resolve_lora_name", lambda _: "style/foo.safetensors")
    monkeypatch.setattr("nodes.prompt.folder_paths.get_full_path", lambda *a: "exists")
    lora = ("foo", 1., 1., None, None, None, "default")
    loader = MagicMock()
    loader.load_lora.return_value = ("model", "clip")
    monkeypatch.setattr("nodes.prompt.nodes.LoraLoader", lambda: loader)
    assert _apply_loras("model", "clip", [lora, lora])[2] == ["style/foo.safetensors"]
    loader.load_lora.assert_called_once()
    loader.reset_mock()
    assert _apply_loras("model", "clip", [lora], {"style/foo"})[2] == []
    loader.load_lora.assert_not_called()


def test_break_concatenates_extra_token_data(monkeypatch):
    clip = MagicMock()
    clip.layer_idx = None
    clip.cond_stage_model.named_modules.return_value = []
    clip.cond_stage_model.encode_token_weights.side_effect = [
        (torch.ones(1, 2, 4), None, {"attention_mask": torch.tensor([[1, 0]]), "t5xxl_ids": torch.tensor([2, 3]), "t5xxl_weights": torch.tensor([1., 0.5])}),
        (torch.ones(1, 3, 4), None, {"attention_mask": torch.tensor([[1, 1, 0]]), "t5xxl_ids": torch.tensor([4, 5, 6]), "t5xxl_weights": torch.tensor([1., 1., 1.])}),
    ]
    concat = MagicMock()
    concat.concat.side_effect = lambda old, new: ([[torch.cat((old[0][0], new[0][0]), dim=1), old[0][1].copy()]],)
    monkeypatch.setattr("nodes.prompt.ConditioningConcat", lambda: concat)
    result = _encode_with_break(clip, "first BREAK second")
    assert result[0][0].shape == (1, 5, 4)
    assert result[0][1]["attention_mask"].tolist() == [[1, 0, 1, 1, 0]]
    assert result[0][1]["t5xxl_ids"].tolist() == [2, 3, 4, 5, 6]
    assert result[0][1]["t5xxl_weights"].tolist() == [1., 0.5, 1., 1., 1.]


def test_vbar_attributes_restored_without_adding_missing_keys():
    clip = MagicMock()
    clip.layer_idx = None
    module = torch.nn.Linear(1, 1)
    module._v = object()
    original = module._v
    clip.cond_stage_model.named_modules.return_value = [("linear", module)]
    clip.cond_stage_model.encode_token_weights.side_effect = RuntimeError("encode failed")
    with pytest.raises(RuntimeError, match="encode failed"):
        _encode_with_break(clip, "hello")
    assert module._v is original
    assert "_v_signature" not in module.__dict__


class TestFilterNewLoras:
    def test_all_new(self):
        pipe = {}
        loras = [("my_lora.safetensors", 1.0, 1.0, None, None, None, "default")]
        assert filter_new_loras(pipe, loras) == loras

    def test_already_applied(self):
        pipe = {"_applied_loras": {"my_lora"}}
        loras = [("my_lora.safetensors", 1.0, 1.0, None, None, None, "default")]
        assert filter_new_loras(pipe, loras) == []

    def test_mixed(self):
        pipe = {"_applied_loras": {"applied"}}
        loras = [
            ("applied.safetensors", 1.0, 1.0, None, None, None, "default"),
            ("new_one.safetensors", 0.8, 0.8, None, None, None, "default"),
        ]
        result = filter_new_loras(pipe, loras)
        assert len(result) == 1
        assert result[0][0] == "new_one.safetensors"

    def test_path_normalization(self):
        pipe = {"_applied_loras": {"subdir/my_lora"}}
        loras = [("subdir/my_lora.safetensors", 1.0, 1.0, None, None, None, "default")]
        assert filter_new_loras(pipe, loras) == []


class TestRecordAppliedLoras:
    def test_records_names(self):
        pipe = {}
        record_applied_loras(pipe, ["lora_a.safetensors", "lora_b.safetensors"])
        assert pipe["_applied_loras"] == {"lora_a", "lora_b"}

    def test_appends_to_existing(self):
        pipe = {"_applied_loras": {"existing"}}
        record_applied_loras(pipe, ["new.safetensors"])
        assert "existing" in pipe["_applied_loras"]
        assert "new" in pipe["_applied_loras"]

    def test_no_mutation_of_original_set(self):
        original = {"a"}
        pipe = {"_applied_loras": original}
        record_applied_loras(pipe, ["b.safetensors"])
        assert "b" not in original


class TestPromptExecute:
    def _make_pipe(self):
        return {
            "model": MagicMock(),
            "clip": MagicMock(),
            "vae": MagicMock(),
            "positive": MagicMock(),
            "negative": MagicMock(),
            "seed": 42,
            "loader_settings": {"positive": ""},
        }

    @patch("nodes.prompt._get_impact_wildcards", return_value=None)
    @patch("nodes.prompt._encode_with_break")
    def test_no_wildcards_passthrough(self, mock_encode, mock_wc):
        mock_encode.return_value = MagicMock()
        pipe = self._make_pipe()
        result = SAX_Bridge_Prompt.execute(pipe, "hello world")
        assert result[1] == "hello world"

    @patch("nodes.prompt._get_impact_wildcards", return_value=None)
    @patch("nodes.prompt._encode_with_break")
    def test_updates_positive_conditioning(self, mock_encode, mock_wc):
        conditioning = MagicMock()
        mock_encode.return_value = conditioning
        pipe = self._make_pipe()
        result = SAX_Bridge_Prompt.execute(pipe, "test prompt")
        new_pipe = result[0]
        assert new_pipe["positive"] is conditioning

    @patch("nodes.prompt._get_impact_wildcards", return_value=None)
    @patch("nodes.prompt._encode_with_break")
    def test_updates_loader_settings(self, mock_encode, mock_wc):
        mock_encode.return_value = MagicMock()
        pipe = self._make_pipe()
        result = SAX_Bridge_Prompt.execute(pipe, "my prompt")
        assert result[0]["loader_settings"]["positive"] == "my prompt"

    def test_no_model_raises(self):
        pipe = self._make_pipe()
        pipe["model"] = None
        with pytest.raises(ValueError, match="model"):
            SAX_Bridge_Prompt.execute(pipe, "test")

    def test_no_clip_raises(self):
        pipe = self._make_pipe()
        pipe["clip"] = None
        with pytest.raises(ValueError, match="CLIP"):
            SAX_Bridge_Prompt.execute(pipe, "test")


class TestEncodeWithBreak:
    """_encode_with_break の conditioning 構築を検証する。"""

    def _make_clip(self, encode_return):
        clip = MagicMock()
        clip.layer_idx = None
        cond_model = MagicMock()
        # named_modules を空にして vbar 回避ループをスキップ
        cond_model.named_modules.return_value = []
        cond_model.encode_token_weights.return_value = encode_return
        clip.cond_stage_model = cond_model
        return clip

    def test_two_tuple_only_pooled(self):
        """CLIP (SD1.5/SDXL) の 2-tuple では pooled_output のみ。"""
        cond, pooled = MagicMock(), MagicMock()
        clip = self._make_clip((cond, pooled))

        result = _encode_with_break(clip, "hello")

        assert result[0][0] is cond
        assert result[0][1] == {"pooled_output": pooled}

    def test_three_tuple_merges_extra_keys(self):
        """マルチエンコーダ (Anima 等) の第3要素キーを欠落なくマージする。"""
        cond, pooled = MagicMock(), MagicMock()
        extra = {
            "attention_mask": MagicMock(),
            "t5xxl_ids": MagicMock(),
            "t5xxl_weights": MagicMock(),
        }
        clip = self._make_clip((cond, pooled, extra))

        result = _encode_with_break(clip, "hello")

        cond_dict = result[0][1]
        assert cond_dict["pooled_output"] is pooled
        assert cond_dict["attention_mask"] is extra["attention_mask"]
        assert cond_dict["t5xxl_ids"] is extra["t5xxl_ids"]
        assert cond_dict["t5xxl_weights"] is extra["t5xxl_weights"]
