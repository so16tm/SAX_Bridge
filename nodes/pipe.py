from comfy_api.latest import io

from .io_types import PipeLine


@io.comfytype(io_type="*")
class AnyType(io.ComfyTypeIO):
    Type = object


@io.comfytype(io_type="SAMPLER")
class SamplerType(io.ComfyTypeIO):
    Type = object


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
            outputs=[
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

        out_model = new_pipe.get("model")
        out_pos = new_pipe.get("positive")
        out_neg = new_pipe.get("negative")
        out_latent = new_pipe.get("samples")
        out_vae = new_pipe.get("vae")
        out_clip = new_pipe.get("clip")
        out_image = new_pipe.get("images")
        out_seed = new_pipe.get("seed")

        out_steps = loader_settings.get("steps")
        out_cfg = loader_settings.get("cfg")
        out_sampler = loader_settings.get("sampler_name")
        out_scheduler = loader_settings.get("scheduler")
        out_denoise = loader_settings.get("denoise")
        out_optional_sampler = loader_settings.get("optional_sampler")
        out_optional_sigmas = loader_settings.get("optional_sigmas")

        return io.NodeOutput(new_pipe, out_model, out_pos, out_neg, out_latent, out_vae, out_clip, out_image, out_seed, out_steps, out_cfg, out_sampler, out_scheduler, out_denoise, out_optional_sampler, out_optional_sigmas)


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
            outputs=[
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
            ],
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
        loader_settings: dict = pipe.get("loader_settings", {})

        return io.NodeOutput(
            pipe,
            pipe.get("model"),
            pipe.get("positive"),
            pipe.get("negative"),
            pipe.get("samples"),
            pipe.get("vae"),
            pipe.get("clip"),
            pipe.get("images"),
            pipe.get("seed"),
            loader_settings.get("steps"),
            loader_settings.get("cfg"),
            loader_settings.get("sampler_name"),
            loader_settings.get("scheduler"),
            loader_settings.get("denoise"),
            loader_settings.get("optional_sampler"),
            loader_settings.get("optional_sigmas"),
        )
