from comfy_api.latest import io

from .io_types import AnyType, PipeLine


@io.comfytype(io_type="SAMPLER")
class SamplerType(io.ComfyTypeIO):
    Type = object


# PIPE を展開する出力の並び。2 ノード (SAX Pipe / SAX Pipe Switcher) で共有する。
# 並び順は io.NodeOutput の位置引数に直結するため、pipe_outputs と explode_pipe は
# 必ず揃えて変更すること。
_PIPE_FIELDS = ("model", "positive", "negative", "samples", "vae", "clip", "images", "seed")
_SETTINGS_FIELDS = ("steps", "cfg", "sampler_name", "scheduler", "denoise",
                    "optional_sampler", "optional_sigmas")


def pipe_outputs() -> list:
    """PIPE 本体 + 展開 15 出力のスキーマ定義を返す。"""
    return [
        PipeLine.Output("PIPE"),
        io.Model.Output("MODEL"),
        io.Conditioning.Output("POS"),
        io.Conditioning.Output("NEG"),
        io.Latent.Output("LATENT"),
        io.Vae.Output("VAE"),
        io.Clip.Output("CLIP"),
        io.Image.Output("IMAGE"),
        io.Int.Output("SEED"),
        io.Int.Output("STEPS"),
        io.Float.Output("CFG"),
        AnyType.Output("SAMPLER"),
        AnyType.Output("SCHEDULER"),
        io.Float.Output("DENOISE"),
        SamplerType.Output("OPTIONAL_SAMPLER"),
        io.Sigmas.Output("OPTIONAL_SIGMAS"),
    ]


def explode_pipe(pipe: dict, loader_settings: dict | None = None) -> tuple:
    """pipe を pipe_outputs() の 2 番目以降と同じ並びの 15 要素へ分解する。

    loader_settings を渡さない場合は pipe から読む。dict でない (None 等) 場合は
    空扱いにして、欠けた pipe でも AttributeError にしない。
    """
    settings = loader_settings if loader_settings is not None else pipe.get("loader_settings")
    if not isinstance(settings, dict):
        settings = {}
    return (
        *(pipe.get(k) for k in _PIPE_FIELDS),
        *(settings.get(k) for k in _SETTINGS_FIELDS),
    )


class SAX_Bridge_Pipe(io.ComfyNode):
    @classmethod
    def define_schema(cls):
        return io.Schema(
            node_id="SAX_Bridge_Pipe",
            display_name="SAX Pipe",
            category="SAX/Bridge/Pipe",
            description="CSB Pipe In/Out (V3)",
            inputs=[
                PipeLine.Input("pipe", optional=True),
                io.Model.Input("model", optional=True),
                io.Conditioning.Input("pos", optional=True),
                io.Conditioning.Input("neg", optional=True),
                io.Latent.Input("latent", optional=True),
                io.Vae.Input("vae", optional=True),
                io.Clip.Input("clip", optional=True),
                io.Image.Input("image", optional=True),
                io.Int.Input("steps", optional=True, force_input=True),
                io.Float.Input("cfg", optional=True, force_input=True),
                AnyType.Input("sampler", optional=True),
                AnyType.Input("scheduler", optional=True),
                io.Float.Input("denoise", optional=True, force_input=True),
                io.Int.Input("seed", optional=True, force_input=True),
                SamplerType.Input("optional_sampler", optional=True),
                io.Sigmas.Input("optional_sigmas", optional=True),
            ],
            outputs=pipe_outputs()
        )

    @classmethod
    def execute(cls, pipe=None, model=None, pos=None, neg=None, latent=None, vae=None, clip=None, image=None, steps=None, cfg=None, sampler=None, scheduler=None, denoise=None, seed=None, optional_sampler=None, optional_sigmas=None) -> io.NodeOutput:
        if pipe is None:
            pipe = {
                "model": model,
                "positive": pos,
                "negative": neg,
                "vae": vae,
                "clip": clip,
                "samples": latent,
                "images": image,
                "seed": seed,
                "loader_settings": {
                    "positive": "",
                    "negative": "",
                    "xyplot": None,
                    "batch_size": 1,
                }
            }

        new_pipe = pipe.copy()

        if model is not None:
            new_pipe["model"] = model
        if pos is not None:
            new_pipe["positive"] = pos
        if neg is not None:
            new_pipe["negative"] = neg
        if latent is not None:
            new_pipe["samples"] = latent
        if vae is not None:
            new_pipe["vae"] = vae
        if clip is not None:
            new_pipe["clip"] = clip
        if image is not None:
            new_pipe["images"] = image
        if seed is not None:
            new_pipe["seed"] = seed

        loader_settings = new_pipe.get("loader_settings", {}).copy()

        if steps is not None:
            loader_settings["steps"] = steps
        if cfg is not None:
            loader_settings["cfg"] = cfg
        if sampler is not None:
            loader_settings["sampler_name"] = sampler
        if scheduler is not None:
            loader_settings["scheduler"] = scheduler
        if denoise is not None:
            loader_settings["denoise"] = denoise
        if optional_sampler is not None:
            loader_settings["optional_sampler"] = optional_sampler
        if optional_sigmas is not None:
            loader_settings["optional_sigmas"] = optional_sigmas

        new_pipe["loader_settings"] = loader_settings

        return io.NodeOutput(new_pipe, *explode_pipe(new_pipe, loader_settings))


N_SWITCH_PIPES = 5


class SAX_Bridge_Pipe_Switcher(io.ComfyNode):
    @classmethod
    def define_schema(cls):
        return io.Schema(
            node_id="SAX_Bridge_Pipe_Switcher",
            display_name="SAX Pipe Switcher",
            category="SAX/Bridge/Pipe",
            description="CSB Switch Pipe — 複数の Pipe 入力から有効な Pipe を選択して展開する",
            inputs=[
                io.Int.Input("slot", default=0, min=0, max=N_SWITCH_PIPES, step=1,
                             tooltip="優先するスロット番号（1 始まり）。0 の場合はスロット順にスキャン"),
                *[PipeLine.Input(f"pipe{i}", optional=True) for i in range(1, N_SWITCH_PIPES + 1)],
            ],
            outputs=pipe_outputs(),
        )

    @classmethod
    def execute(cls, slot=None, **kwargs) -> io.NodeOutput:
        pipes = [kwargs.get(f"pipe{i}") for i in range(1, N_SWITCH_PIPES + 1)]

        selected = None
        if slot is not None and 1 <= slot <= N_SWITCH_PIPES:
            selected = pipes[slot - 1]

        # 指定スロットが空ならスロット順に最初の非 None を採用
        if selected is None:
            for p in pipes:
                if p is not None:
                    selected = p
                    break

        if selected is None:
            selected = {}

        pipe: dict = selected

        return io.NodeOutput(pipe, *explode_pipe(pipe))
