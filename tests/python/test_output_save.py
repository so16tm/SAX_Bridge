"""output.py の _save_image 関数のテスト — 実ファイル書き出しで検証する。"""

import json
import os
import numpy as np
from PIL import Image

from nodes.output import _save_image


def _make_img_np(h=16, w=16):
    """テスト用の RGB uint8 numpy 画像を生成。"""
    return (np.random.rand(h, w, 3) * 255).astype(np.uint8)


class TestSaveImagePng:
    def test_basic_png_save(self, tmp_path):
        img = _make_img_np()
        path = str(tmp_path / "test.png")
        _save_image(img, path, "png", 90, False, "")
        assert os.path.exists(path)
        with Image.open(path) as reloaded:
            assert reloaded.format == "PNG"
            assert reloaded.size == (16, 16)

    def test_png_embeds_parameters(self, tmp_path):
        img = _make_img_np()
        path = str(tmp_path / "test.png")
        _save_image(img, path, "png", 90, False, "Seed: 42, Steps: 20")
        with Image.open(path) as reloaded:
            assert reloaded.text.get("parameters") == "Seed: 42, Steps: 20"

    def test_png_embeds_prompt_json(self, tmp_path):
        img = _make_img_np()
        path = str(tmp_path / "test.png")
        prompt = {"1": {"class_type": "Node", "inputs": {"x": 1}}}
        _save_image(img, path, "png", 90, False, "", prompt=prompt)
        with Image.open(path) as reloaded:
            assert json.loads(reloaded.text["prompt"]) == prompt

    def test_png_embeds_extra_pnginfo(self, tmp_path):
        img = _make_img_np()
        path = str(tmp_path / "test.png")
        extra = {"workflow": {"nodes": []}, "other": {"a": 1}}
        _save_image(img, path, "png", 90, False, "", extra_pnginfo=extra)
        with Image.open(path) as reloaded:
            assert json.loads(reloaded.text["workflow"]) == extra["workflow"]
            assert json.loads(reloaded.text["other"]) == extra["other"]

    def test_png_empty_metadata_no_parameters_key(self, tmp_path):
        img = _make_img_np()
        path = str(tmp_path / "test.png")
        _save_image(img, path, "png", 90, False, "")
        with Image.open(path) as reloaded:
            assert "parameters" not in reloaded.text


class TestSaveImageWebp:
    def test_basic_webp_save(self, tmp_path):
        img = _make_img_np()
        path = str(tmp_path / "test.webp")
        _save_image(img, path, "webp", 90, False, "")
        assert os.path.exists(path)
        with Image.open(path) as reloaded:
            assert reloaded.format == "WEBP"
            assert reloaded.size == (16, 16)

    def test_webp_lossless(self, tmp_path):
        img = _make_img_np()
        path = str(tmp_path / "test_lossless.webp")
        _save_image(img, path, "webp", 90, True, "")
        assert os.path.exists(path)
        # lossless モードでも正常に読み込めること
        with Image.open(path) as reloaded:
            assert reloaded.format == "WEBP"

    def test_webp_embeds_parameters_in_exif(self, tmp_path):
        img = _make_img_np()
        path = str(tmp_path / "test.webp")
        _save_image(img, path, "webp", 90, False, "Seed: 42")
        with Image.open(path) as reloaded:
            exif = reloaded.getexif()
            # EXIF 0x010E (ImageDescription) に metadata_str が入る
            assert exif.get(0x010E) == "Seed: 42"

    def test_webp_embeds_prompt_in_exif(self, tmp_path):
        img = _make_img_np()
        path = str(tmp_path / "test.webp")
        prompt = {"1": {"class_type": "Test"}}
        _save_image(img, path, "webp", 90, False, "", prompt=prompt)
        with Image.open(path) as reloaded:
            exif = reloaded.getexif()
            # EXIF 0x0110 (Model) に "prompt:<json>" で埋め込まれる
            val = exif.get(0x0110)
            assert val is not None
            assert val.startswith("prompt:")
            assert json.loads(val[len("prompt:"):]) == prompt

    def test_webp_quality_parameter_accepted(self, tmp_path):
        # 異なる quality 値で保存できることの基本確認
        img = _make_img_np()
        for q in [1, 50, 100]:
            path = str(tmp_path / f"q_{q}.webp")
            _save_image(img, path, "webp", q, False, "")
            assert os.path.exists(path)


class TestSaveImageColor:
    def test_color_png_is_rgb(self, tmp_path):
        # grayscale 機能は SAX Finisher へ移動したため、Output は常に RGB 保存となる
        img = _make_img_np()
        path = str(tmp_path / "color.png")
        _save_image(img, path, "png", 90, False, "")
        with Image.open(path) as reloaded:
            assert reloaded.mode == "RGB"
