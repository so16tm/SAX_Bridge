"""SAX_Bridge_Output / SAX_Bridge_Image_Preview ノードのテスト。"""

import pytest
import datetime
from unittest.mock import MagicMock, patch
from nodes.output import (
    SAX_Bridge_Output,
    SAX_Bridge_Image_Preview,
    _expand_template,
    _build_indexed_name,
    _build_metadata_str,
    _expand_filename,
    _write_preview_images,
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
    @pytest.fixture(autouse=True)
    def mock_preview(self, monkeypatch):
        monkeypatch.setattr("nodes.output._write_preview_images", MagicMock(return_value=[]))

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


class TestOutputRegression:
    def test_filename_cannot_escape_output_directory(self):
        filename = _expand_filename("../../outside\\image\x00", {}, datetime.datetime(2026, 1, 1))
        assert "/" not in filename and "\\" not in filename and "\x00" not in filename

    def test_no_save_still_generates_preview(self, tmp_path, monkeypatch):
        import torch
        from PIL import Image
        monkeypatch.setattr("nodes.output.folder_paths.get_temp_directory", lambda: str(tmp_path))
        monkeypatch.setattr(SAX_Bridge_Output, "hidden", MagicMock(prompt=None, extra_pnginfo=None, unique_id="42"))
        image = torch.rand(1, 16, 16, 3)
        with patch("nodes.output._save_image") as save_image:
            result = SAX_Bridge_Output.execute(
                False, "", "test", 7, 3, "suffix", "png", 90, False, image=image,
            )
        save_image.assert_not_called()
        assert result[0] is image
        assert result.ui["filename_index"] == [7]
        assert result.ui["images"][0]["type"] == "temp"
        with Image.open(tmp_path / result.ui["images"][0]["filename"]) as preview:
            assert preview.size == (16, 16)

    def test_output_requests_metadata_hidden_fields(self):
        from comfy_api.latest import io
        assert io.Hidden.prompt in SAX_Bridge_Output.define_schema().hidden
        assert io.Hidden.extra_pnginfo in SAX_Bridge_Output.define_schema().hidden
