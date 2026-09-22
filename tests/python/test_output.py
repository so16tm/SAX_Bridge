"""SAX_Bridge_Output / SAX_Bridge_Image_Preview ノードのテスト。"""

import datetime
import os

import pytest
import torch
from unittest.mock import MagicMock, patch
from nodes.output import (
    SAX_Bridge_Output,
    SAX_Bridge_Image_Preview,
    _build_indexed_name,
    _build_metadata_str,
    _expand_filename,
    _expand_template,
    _resolve_dir,
)


class TestExpandTemplate:
    def test_seed_substitution(self):
        result = _expand_template("{seed}", {"seed": 12345}, datetime.datetime(2026, 1, 1))
        assert result == "12345"

    def test_seed_with_format(self):
        result = _expand_template("{seed:08d}", {"seed": 42}, datetime.datetime(2026, 1, 1))
        assert result == "00000042"

    def test_date_default_format(self):
        result = _expand_template("{date}", {}, datetime.datetime(2026, 3, 15))
        assert result == "20260315"

    def test_date_custom_format(self):
        result = _expand_template("{date:%Y-%m-%d}", {}, datetime.datetime(2026, 3, 15))
        assert result == "2026-03-15"

    def test_model_substitution(self):
        result = _expand_template("{model}", {"ckpt_name": "my_model.safetensors"}, datetime.datetime(2026, 1, 1))
        assert result == "my_model"

    def test_unknown_var_preserved(self):
        result = _expand_template("{unknown}", {}, datetime.datetime(2026, 1, 1))
        assert result == "{unknown}"

    def test_multiple_vars(self):
        result = _expand_template("{seed}_{steps}", {"seed": 1, "steps": 20}, datetime.datetime(2026, 1, 1))
        assert result == "1_20"


class TestBuildIndexedName:
    def test_prefix(self):
        assert _build_indexed_name("test", 1, 3, "prefix") == "001_test"

    def test_suffix(self):
        assert _build_indexed_name("test", 42, 4, "suffix") == "test_0042"


class TestBuildMetadataStr:
    def test_with_prompt_and_params(self):
        p = {"seed": 42, "steps": 20, "cfg": 7.0, "sampler_name": "euler", "scheduler": "normal"}
        result = _build_metadata_str(p, "my prompt")
        assert "my prompt" in result
        assert "Seed: 42" in result
        assert "Steps: 20" in result

    def test_empty(self):
        result = _build_metadata_str({}, "")
        assert result == ""


class TestOutputExecute:
    def _make_pipe(self):
        import torch
        return {
            "model": MagicMock(),
            "images": torch.rand(1, 64, 64, 3),
            "seed": 42,
            "loader_settings": {"steps": 20, "cfg": 7.0, "sampler_name": "euler", "scheduler": "normal"},
        }

    def test_image_priority_over_pipe(self):
        import torch
        pipe = self._make_pipe()
        direct_image = torch.rand(1, 32, 32, 3)
        SAX_Bridge_Output.hidden = MagicMock()
        SAX_Bridge_Output.hidden.prompt = None
        SAX_Bridge_Output.hidden.extra_pnginfo = None
        result = SAX_Bridge_Output.execute(
            save=False, output_dir="", filename_template="test",
            filename_index=1, index_digits=3, index_position="suffix",
            format="png", webp_quality=90, webp_lossless=False,
            pipe=pipe, image=direct_image,
        )
        assert result[0].shape == direct_image.shape

    def test_pipe_fallback_when_no_image(self):
        pipe = self._make_pipe()
        SAX_Bridge_Output.hidden = MagicMock()
        SAX_Bridge_Output.hidden.prompt = None
        SAX_Bridge_Output.hidden.extra_pnginfo = None
        result = SAX_Bridge_Output.execute(
            save=False, output_dir="", filename_template="test",
            filename_index=1, index_digits=3, index_position="suffix",
            format="png", webp_quality=90, webp_lossless=False,
            pipe=pipe, image=None,
        )
        assert result[0].shape == pipe["images"].shape

    def test_no_image_no_pipe_raises(self):
        SAX_Bridge_Output.hidden = MagicMock()
        with pytest.raises(ValueError, match="no image"):
            SAX_Bridge_Output.execute(
                save=False, output_dir="", filename_template="test",
                filename_index=1, index_digits=3, index_position="suffix",
                format="png", webp_quality=90, webp_lossless=False,
                pipe=None, image=None,
            )

    def test_index_increments_on_save(self):
        pipe = self._make_pipe()
        SAX_Bridge_Output.hidden = MagicMock()
        SAX_Bridge_Output.hidden.prompt = None
        SAX_Bridge_Output.hidden.extra_pnginfo = None
        with patch("nodes.output._resolve_dir", return_value="/tmp"), \
             patch("nodes.output._save_image"), \
             patch("os.path.exists", return_value=False):
            result = SAX_Bridge_Output.execute(
                save=True, output_dir="", filename_template="test",
                filename_index=5, index_digits=3, index_position="suffix",
                format="png", webp_quality=90, webp_lossless=False,
                pipe=pipe, image=None,
            )
        assert result.ui["filename_index"] == [6]

    def test_index_unchanged_when_no_save(self):
        pipe = self._make_pipe()
        SAX_Bridge_Output.hidden = MagicMock()
        SAX_Bridge_Output.hidden.prompt = None
        SAX_Bridge_Output.hidden.extra_pnginfo = None
        result = SAX_Bridge_Output.execute(
            save=False, output_dir="", filename_template="test",
            filename_index=5, index_digits=3, index_position="suffix",
            format="png", webp_quality=90, webp_lossless=False,
            pipe=pipe, image=None,
        )
        assert result.ui["filename_index"] == [5]


class TestImagePreviewExecute:
    def test_none_images_returns_empty(self):
        result = SAX_Bridge_Image_Preview.execute(cell_w=200, max_cols=1, images=None)
        assert result.ui["images"] == []


class TestPathSafety:
    """保存先・ファイル名のサニタイズ。

    output_dir の相対指定は output/ 起点（ツールチップ記載）であり、
    filename_template はファイル名でありディレクトリ指定ではない。
    """

    def test_filename_drops_path_separators(self):
        """`/` `\\` を残すと存在しないディレクトリへ書きに行き FileNotFoundError になる。"""
        now = datetime.datetime(2026, 1, 1)
        assert "/" not in _expand_filename("sub/dir/name", {}, now)
        assert "\\" not in _expand_filename("sub\\dir\\name", {}, now)

    def test_filename_keeps_normal_characters(self):
        now = datetime.datetime(2026, 1, 1)
        assert _expand_filename("shot-01_final", {}, now) == "shot-01_final"

    def test_relative_dir_stays_under_output(self, tmp_path):
        now = datetime.datetime(2026, 1, 1)
        with patch("nodes.output.folder_paths.get_output_directory", return_value=str(tmp_path)):
            resolved = _resolve_dir("../../escape/here", {}, now)
        assert os.path.commonpath([str(tmp_path), resolved]) == str(tmp_path)
        assert resolved == str(tmp_path / "escape" / "here")

    def test_relative_dir_normal_case(self, tmp_path):
        now = datetime.datetime(2026, 3, 15)
        with patch("nodes.output.folder_paths.get_output_directory", return_value=str(tmp_path)):
            resolved = _resolve_dir("{date:%Y-%m-%d}/batch", {}, now)
        assert resolved == str(tmp_path / "2026-03-15" / "batch")

    def test_absolute_dir_is_respected(self, tmp_path):
        """絶対パス指定は output/ 外でもそのまま使う（ツールチップ記載の仕様）。"""
        target = tmp_path / "elsewhere"
        now = datetime.datetime(2026, 1, 1)
        assert _resolve_dir(str(target), {}, now) == str(target)


class TestWindowsCheckpointName:
    """Windows で保存されたワークフローの `\\` 区切り ckpt_name を落とす。"""

    def test_model_template_strips_backslash_path(self):
        result = _expand_template(
            "{model}", {"ckpt_name": "SDXL\\illustrious.safetensors"}, datetime.datetime(2026, 1, 1)
        )
        assert result == "illustrious"

    def test_metadata_model_strips_backslash_path(self):
        result = _build_metadata_str({"ckpt_name": "SDXL\\illustrious.safetensors"}, "")
        assert "Model: illustrious" in result
        assert "\\" not in result


class TestPreviewTempCleanup:
    """プレビュー temp ファイルの掃除は自分の分だけに限定する。

    unique_id が取れないと prefix が "sax_preview_" になり、他ノードの
    "sax_preview_<id>_*.webp" にも前方一致して消してしまう（フロントが 404 になる）。
    """

    def _run(self, node_id, tmp_path):
        hidden = MagicMock()
        hidden.unique_id = node_id
        images = torch.zeros(1, 8, 8, 3)
        with patch.object(SAX_Bridge_Image_Preview, "hidden", hidden, create=True), \
             patch("nodes.output.folder_paths.get_temp_directory", return_value=str(tmp_path)), \
             patch("nodes.output.glob.glob", return_value=[str(tmp_path / "sax_preview_9_00.webp")]), \
             patch("nodes.output.os.remove") as rm:
            SAX_Bridge_Image_Preview.execute(cell_w=200, max_cols=1, images=images)
        return rm

    def test_no_cleanup_without_node_id(self, tmp_path):
        assert self._run(None, tmp_path).call_count == 0

    def test_cleanup_runs_with_node_id(self, tmp_path):
        assert self._run("7", tmp_path).call_count == 1
