"""io_types.py の LoRA 管理ヘルパーのテスト。"""

import pytest
from nodes.io_types import (
    _normalize_lora_name,
    filter_new_loras,
    record_applied_loras,
    _APPLIED_LORAS_KEY,
)


class TestNormalizeLoraName:
    @pytest.mark.parametrize("raw,expected", [
        ("my_lora.safetensors", "my_lora"),
        ("subdir/my_lora.safetensors", "my_lora"),
        ("subdir\\nested\\my_lora.ckpt", "my_lora"),
        ("no_ext", "no_ext"),
        ("multi.dot.name.safetensors", "multi.dot.name"),
        ("", ""),
    ])
    def test_normalize_variants(self, raw, expected):
        assert _normalize_lora_name(raw) == expected


class TestFilterNewLoras:
    def test_empty_loras_returns_empty(self):
        pipe = {}
        assert filter_new_loras(pipe, []) == []

    def test_no_applied_returns_all(self):
        pipe = {}
        loras = [("a.safetensors", 1.0), ("b.safetensors", 0.5)]
        assert filter_new_loras(pipe, loras) == loras

    def test_filters_already_applied(self):
        # 正規化後の名前ベースでフィルタされることを確認
        pipe = {_APPLIED_LORAS_KEY: {"a"}}
        loras = [("a.safetensors", 1.0), ("b.safetensors", 0.5)]
        result = filter_new_loras(pipe, loras)
        assert len(result) == 1
        assert result[0][0] == "b.safetensors"

    def test_normalized_match_ignores_path_and_ext(self):
        # パス・拡張子の違いを無視して重複判定される
        pipe = {_APPLIED_LORAS_KEY: {"lora1"}}
        loras = [("subdir/lora1.ckpt", 1.0), ("lora2.safetensors", 0.5)]
        result = filter_new_loras(pipe, loras)
        assert len(result) == 1
        assert result[0][0] == "lora2.safetensors"

    def test_all_applied_returns_empty(self):
        pipe = {_APPLIED_LORAS_KEY: {"a", "b"}}
        loras = [("a.safetensors", 1.0), ("b.safetensors", 0.5)]
        assert filter_new_loras(pipe, loras) == []


class TestRecordAppliedLoras:
    def test_adds_to_empty_pipe(self):
        pipe = {}
        record_applied_loras(pipe, ["a.safetensors", "b.safetensors"])
        assert pipe[_APPLIED_LORAS_KEY] == {"a", "b"}

    def test_appends_to_existing(self):
        pipe = {_APPLIED_LORAS_KEY: {"a"}}
        record_applied_loras(pipe, ["b.safetensors"])
        assert pipe[_APPLIED_LORAS_KEY] == {"a", "b"}

    def test_creates_new_set_not_mutating_existing(self):
        # shallow copy 経由でのキャッシュ汚染を防ぐため、毎回新しい set を生成する
        original = {"a"}
        pipe = {_APPLIED_LORAS_KEY: original}
        record_applied_loras(pipe, ["b.safetensors"])
        assert original == {"a"}  # 元の set は不変
        assert pipe[_APPLIED_LORAS_KEY] is not original

    def test_duplicate_normalized_names_merged(self):
        pipe = {}
        record_applied_loras(pipe, ["sub/x.safetensors", "x.ckpt"])
        assert pipe[_APPLIED_LORAS_KEY] == {"x"}

    def test_empty_list_creates_empty_set(self):
        pipe = {}
        record_applied_loras(pipe, [])
        assert pipe[_APPLIED_LORAS_KEY] == set()
