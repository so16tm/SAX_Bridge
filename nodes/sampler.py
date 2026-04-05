import nodes
from comfy_api.latest import io
from .io_types import PipeLine


def _empty_conditioning(clip):
    """空文字列を CLIP エンコードして空の conditioning を生成する。"""
    return nodes.CLIPTextEncode().encode(clip, "")[0]


class SAX_Bridge_KSampler(io.ComfyNode):
    """
    Pipe を受け取り、KSampler を実行して Pipe を返すノード。
    サンプリングパラメータは Pipe 内の loader_settings から自動取得する。
    negative conditioning が Pipe にない場合は空文字列から自動生成する。
    decode_vae=True の場合、VAE Decode まで行い IMAGE も出力する。
    """

    @classmethod
    def define_schema(cls) -> io.Schema:
        return io.Schema(
            node_id="SAX_Bridge_KSampler",
            display_name="SAX KSampler",
            category="SAX/Bridge/Sampler",
            inputs=[
                PipeLine.Input("pipe"),
                io.Boolean.Input(
                    "decode_vae",
                    default=True,
                    label_on="decode",
                    label_off="latent only",
                ),
            ],
            outputs=[
                PipeLine.Output(),
                io.Image.Output(),
            ],
        )

    @classmethod
    def execute(cls, pipe, decode_vae) -> io.NodeOutput:
        model = pipe.get("model")
        positive = pipe.get("positive")
        negative = pipe.get("negative")
        latent = pipe.get("samples")
        vae = pipe.get("vae")
        seed = pipe.get("seed", 0)

        if model is None:
            raise ValueError("[SAX_Bridge] Pipe does not contain a model.")
        if positive is None:
            raise ValueError("[SAX_Bridge] Pipe does not contain positive conditioning.")
        if latent is None:
            raise ValueError("[SAX_Bridge] Pipe does not contain a latent.")

        if negative is None:
            clip = pipe.get("clip")
            if clip is None:
                raise ValueError(
                    "[SAX_Bridge] Pipe does not contain negative conditioning or CLIP model."
                )
            negative = _empty_conditioning(clip)

        settings = pipe.get("loader_settings", {})
        steps = settings.get("steps", 20)
        cfg = settings.get("cfg", 8.0)
        sampler_name = settings.get("sampler_name", "euler")
        scheduler = settings.get("scheduler", "normal")
        denoise = settings.get("denoise", 1.0)

        sampled = nodes.common_ksampler(
            model, seed, steps, cfg, sampler_name, scheduler,
            positive, negative, latent, denoise=denoise,
        )
        new_latent = sampled[0]

        if decode_vae:
            if vae is None:
                raise ValueError("[SAX_Bridge] Pipe does not contain a VAE.")
            images = vae.decode(new_latent["samples"])
        else:
            images = None

        new_pipe = {
            **pipe,
            "samples": new_latent,
            "images": images,
        }

        return io.NodeOutput(new_pipe, images)
