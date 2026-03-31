"""SAX_Bridge_Prompt ノードのテスト。"""

import pytest
from unittest.mock import MagicMock, patch
from nodes.prompt import SAX_Bridge_Prompt
from nodes.io_types import filter_new_loras, record_applied_loras


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
        pipe = {"_applied_loras": {"my_lora"}}
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
