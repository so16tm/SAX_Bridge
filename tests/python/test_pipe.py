"""SAX_Bridge_Pipe / SAX_Bridge_Pipe_Switcher ノードのテスト。"""

import pytest
from unittest.mock import MagicMock
from nodes.pipe import SAX_Bridge_Pipe, SAX_Bridge_Pipe_Switcher, N_SWITCH_PIPES


class TestPipeExecuteNewPipe:
    """pipe=None の場合、個別入力から新しい dict が作られる。"""

    def test_all_none_creates_empty_pipe(self):
        result = SAX_Bridge_Pipe.execute(pipe=None)
        new_pipe = result.args[0]
        assert isinstance(new_pipe, dict)
        assert new_pipe["model"] is None
        assert new_pipe["positive"] is None
        assert new_pipe["negative"] is None
        assert new_pipe["samples"] is None
        assert new_pipe["vae"] is None
        assert new_pipe["clip"] is None
        assert new_pipe["images"] is None
        assert new_pipe["seed"] is None
        # loader_settings はデフォルト値を含む
        assert "loader_settings" in new_pipe

    def test_create_with_individual_inputs(self):
        model = MagicMock()
        pos = MagicMock()
        neg = MagicMock()
        vae = MagicMock()
        clip = MagicMock()
        result = SAX_Bridge_Pipe.execute(
            pipe=None, model=model, pos=pos, neg=neg, vae=vae, clip=clip, seed=42,
        )
        new_pipe = result.args[0]
        assert new_pipe["model"] is model
        assert new_pipe["positive"] is pos
        assert new_pipe["negative"] is neg
        assert new_pipe["vae"] is vae
        assert new_pipe["clip"] is clip
        assert new_pipe["seed"] == 42


class TestPipeExecuteOverwrite:
    """既存 pipe に対する上書き動作。"""

    def _make_pipe(self):
        return {
            "model": MagicMock(name="orig_model"),
            "positive": MagicMock(name="orig_pos"),
            "negative": MagicMock(name="orig_neg"),
            "samples": MagicMock(name="orig_latent"),
            "vae": MagicMock(name="orig_vae"),
            "clip": MagicMock(name="orig_clip"),
            "images": MagicMock(name="orig_image"),
            "seed": 100,
            "loader_settings": {
                "steps": 20,
                "cfg": 7.0,
                "sampler_name": "euler",
                "scheduler": "normal",
                "denoise": 1.0,
            },
        }

    def test_none_args_preserve_original(self):
        # None の引数は元の値を保持する
        pipe = self._make_pipe()
        result = SAX_Bridge_Pipe.execute(pipe=pipe)
        new_pipe = result.args[0]
        assert new_pipe["model"] is pipe["model"]
        assert new_pipe["positive"] is pipe["positive"]
        assert new_pipe["seed"] == 100

    def test_model_overwrite(self):
        pipe = self._make_pipe()
        new_model = MagicMock(name="new_model")
        result = SAX_Bridge_Pipe.execute(pipe=pipe, model=new_model)
        assert result.args[0]["model"] is new_model
        assert result.args[0]["model"] is not pipe["model"]

    def test_all_fields_overwrite(self):
        pipe = self._make_pipe()
        new_vals = {
            "model": MagicMock(),
            "pos": MagicMock(),
            "neg": MagicMock(),
            "latent": MagicMock(),
            "vae": MagicMock(),
            "clip": MagicMock(),
            "image": MagicMock(),
            "seed": 999,
        }
        result = SAX_Bridge_Pipe.execute(pipe=pipe, **new_vals)
        new_pipe = result.args[0]
        assert new_pipe["model"] is new_vals["model"]
        assert new_pipe["positive"] is new_vals["pos"]
        assert new_pipe["negative"] is new_vals["neg"]
        assert new_pipe["samples"] is new_vals["latent"]
        assert new_pipe["vae"] is new_vals["vae"]
        assert new_pipe["clip"] is new_vals["clip"]
        assert new_pipe["images"] is new_vals["image"]
        assert new_pipe["seed"] == 999

    def test_original_pipe_not_mutated(self):
        # 元の pipe dict 自体は変更されない
        pipe = self._make_pipe()
        orig_model = pipe["model"]
        new_model = MagicMock()
        SAX_Bridge_Pipe.execute(pipe=pipe, model=new_model)
        assert pipe["model"] is orig_model


class TestPipeExecuteLoaderSettings:
    """loader_settings の組み立て。"""

    def test_loader_settings_assembly(self):
        result = SAX_Bridge_Pipe.execute(
            pipe=None, steps=30, cfg=8.0, sampler="dpmpp_2m",
            scheduler="karras", denoise=0.7,
        )
        ls = result.args[0]["loader_settings"]
        assert ls["steps"] == 30
        assert ls["cfg"] == 8.0
        assert ls["sampler_name"] == "dpmpp_2m"
        assert ls["scheduler"] == "karras"
        assert ls["denoise"] == 0.7

    def test_optional_sampler_sigmas(self):
        sampler_obj = MagicMock()
        sigmas_obj = MagicMock()
        result = SAX_Bridge_Pipe.execute(
            pipe=None, optional_sampler=sampler_obj, optional_sigmas=sigmas_obj,
        )
        ls = result.args[0]["loader_settings"]
        assert ls["optional_sampler"] is sampler_obj
        assert ls["optional_sigmas"] is sigmas_obj

    def test_loader_settings_preserve_existing(self):
        # 既存の loader_settings は None 引数では上書きされない
        pipe = {
            "loader_settings": {"steps": 50, "cfg": 5.0},
        }
        result = SAX_Bridge_Pipe.execute(pipe=pipe)
        ls = result.args[0]["loader_settings"]
        assert ls["steps"] == 50
        assert ls["cfg"] == 5.0

    def test_original_loader_settings_not_mutated(self):
        pipe = {
            "loader_settings": {"steps": 50, "cfg": 5.0},
        }
        orig_ls = pipe["loader_settings"]
        SAX_Bridge_Pipe.execute(pipe=pipe, steps=100)
        assert orig_ls["steps"] == 50  # 元は不変


class TestPipeOutputOrder:
    """出力タプルの順序（16 outputs）。"""

    def test_output_count(self):
        result = SAX_Bridge_Pipe.execute(pipe=None)
        assert len(result.args) == 16

    def test_output_order(self):
        # pipe, model, pos, neg, latent, vae, clip, image, seed,
        # steps, cfg, sampler, scheduler, denoise, optional_sampler, optional_sigmas
        model = MagicMock()
        pos = MagicMock()
        neg = MagicMock()
        latent = MagicMock()
        vae = MagicMock()
        clip = MagicMock()
        image = MagicMock()
        sampler_obj = MagicMock()
        sigmas_obj = MagicMock()
        result = SAX_Bridge_Pipe.execute(
            pipe=None, model=model, pos=pos, neg=neg, latent=latent,
            vae=vae, clip=clip, image=image, seed=7, steps=20, cfg=6.0,
            sampler="euler", scheduler="normal", denoise=0.8,
            optional_sampler=sampler_obj, optional_sigmas=sigmas_obj,
        )
        args = result.args
        assert args[1] is model
        assert args[2] is pos
        assert args[3] is neg
        assert args[4] is latent
        assert args[5] is vae
        assert args[6] is clip
        assert args[7] is image
        assert args[8] == 7
        assert args[9] == 20
        assert args[10] == 6.0
        assert args[11] == "euler"
        assert args[12] == "normal"
        assert args[13] == 0.8
        assert args[14] is sampler_obj
        assert args[15] is sigmas_obj


class TestPipeSwitcherSlotSelection:
    """slot 指定による選択。"""

    def _make_pipe(self, name):
        return {
            "model": MagicMock(name=f"{name}_model"),
            "positive": MagicMock(),
            "negative": MagicMock(),
            "samples": None,
            "vae": None,
            "clip": None,
            "images": None,
            "seed": 0,
            "loader_settings": {"steps": 10, "cfg": 7.0},
        }

    @pytest.mark.parametrize("slot,expected_key", [
        (1, "pipe1"),
        (2, "pipe2"),
        (3, "pipe3"),
        (4, "pipe4"),
        (5, "pipe5"),
    ])
    def test_slot_selection(self, slot, expected_key):
        pipes = {f"pipe{i}": self._make_pipe(f"p{i}") for i in range(1, N_SWITCH_PIPES + 1)}
        result = SAX_Bridge_Pipe_Switcher.execute(slot=slot, **pipes)
        assert result.args[0] is pipes[expected_key]

    def test_slot_zero_scans_first_non_none(self):
        # slot=0 の場合はスロット順にスキャン
        p3 = self._make_pipe("p3")
        result = SAX_Bridge_Pipe_Switcher.execute(
            slot=0, pipe1=None, pipe2=None, pipe3=p3, pipe4=None, pipe5=None,
        )
        assert result.args[0] is p3

    def test_slot_zero_selects_first_when_multiple(self):
        p2 = self._make_pipe("p2")
        p4 = self._make_pipe("p4")
        result = SAX_Bridge_Pipe_Switcher.execute(
            slot=0, pipe1=None, pipe2=p2, pipe3=None, pipe4=p4, pipe5=None,
        )
        assert result.args[0] is p2

    def test_slot_out_of_range_scans(self):
        # slot が範囲外（0 未満、5 超）でもスキャン動作
        p1 = self._make_pipe("p1")
        result = SAX_Bridge_Pipe_Switcher.execute(
            slot=10, pipe1=p1, pipe2=None, pipe3=None, pipe4=None, pipe5=None,
        )
        assert result.args[0] is p1

    def test_specified_slot_none_scans_others(self):
        # 指定 slot が None の場合、後続スロットをスキャン
        p3 = self._make_pipe("p3")
        result = SAX_Bridge_Pipe_Switcher.execute(
            slot=1, pipe1=None, pipe2=None, pipe3=p3, pipe4=None, pipe5=None,
        )
        assert result.args[0] is p3

    def test_all_none_returns_empty_dict(self):
        result = SAX_Bridge_Pipe_Switcher.execute(
            slot=0, pipe1=None, pipe2=None, pipe3=None, pipe4=None, pipe5=None,
        )
        assert result.args[0] == {}
        # 他の出力もすべて None（空 dict から取得）
        for i in range(1, 16):
            assert result.args[i] is None


class TestPipeSwitcherLoaderSettingsExpansion:
    """選択された pipe の loader_settings を展開する。"""

    def test_loader_settings_expansion(self):
        sampler_obj = MagicMock()
        sigmas_obj = MagicMock()
        p1 = {
            "model": MagicMock(),
            "positive": MagicMock(),
            "negative": MagicMock(),
            "samples": MagicMock(),
            "vae": MagicMock(),
            "clip": MagicMock(),
            "images": MagicMock(),
            "seed": 7,
            "loader_settings": {
                "steps": 25,
                "cfg": 6.5,
                "sampler_name": "dpmpp_2m",
                "scheduler": "karras",
                "denoise": 0.9,
                "optional_sampler": sampler_obj,
                "optional_sigmas": sigmas_obj,
            },
        }
        result = SAX_Bridge_Pipe_Switcher.execute(
            slot=1, pipe1=p1, pipe2=None, pipe3=None, pipe4=None, pipe5=None,
        )
        args = result.args
        assert args[0] is p1
        assert args[1] is p1["model"]
        assert args[8] == 7       # seed
        assert args[9] == 25      # steps
        assert args[10] == 6.5    # cfg
        assert args[11] == "dpmpp_2m"
        assert args[12] == "karras"
        assert args[13] == 0.9
        assert args[14] is sampler_obj
        assert args[15] is sigmas_obj

    def test_output_count(self):
        result = SAX_Bridge_Pipe_Switcher.execute(
            slot=0, pipe1=None, pipe2=None, pipe3=None, pipe4=None, pipe5=None,
        )
        assert len(result.args) == 16
