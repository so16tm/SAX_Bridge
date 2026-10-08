"""MiniMax H3（動画 + 音声の同時生成モデル）を MiniMaxH3-Director 前提で簡単に使うためのノード。

MiniMaxH3-Director (https://github.com/seesee75-commits/ComfyUI-MiniMaxH3-Director) は
プロンプト・latent・conditioning・モデルの sigma shift を組み立てる。ここから先の
「ローダー 5 つ → サンプラー一式 → 映像/音声デコード → 動画化」の配線を、
Loader と Sampler の 2 ノードに畳み込む。

    SAX MiniMax H3 Loader → MiniMax H3 Director → SAX MiniMax H3 Sampler → SaveVideo

サンプリング・音声デコード・動画化は ComfyUI 本体のノードに委ねる。
H3 固有の細部（latent の nested 構造、音声の sample rate 等）を自前で複製せず、
本体の修正に追従できるようにするため。
"""

from typing import Any

import comfy.samplers
import comfy.sd
import folder_paths
from comfy_api.latest import io

from .io_types import PipeLine, require_pipe
from .loader_common import build_pipe, load_vae_file, pick_default, resolve_path
from .vae_utils import decode_image

# Loader が「未選択」を表す値。fl2va / ref2va はどちらか一方だけでも使える。
NONE_OPTION = "None"

# Comfy-Org/MiniMax-H3 の公式設定（sampler / scheduler / steps）
DEFAULT_SAMPLER = "res_multistep"
DEFAULT_SCHEDULER = "simple"
DEFAULT_STEPS = 20
# H3 は 24fps 固定（Director の fps 出力も常に 24.0）
DEFAULT_FPS = 24.0


def _clip_type_minimax():
    """H3 テキストエンコーダ用の CLIPType を返す（未対応の ComfyUI では原因の分かるエラー）。"""
    clip_type = getattr(comfy.sd.CLIPType, "MINIMAX", None)
    if clip_type is None:
        raise ValueError(
            "[SAX_Bridge] MiniMax H3 Loader requires a ComfyUI version with MiniMax H3 support "
            "(CLIPType.MINIMAX). Please update ComfyUI (0.30.0 or later)."
        )
    return clip_type


def _combo_default(options: list[str], preferred: str) -> str | None:
    """preferred が options にあればそれを、なければ None（フロントの既定＝先頭）を返す。"""
    return preferred if preferred in options else None


class SAX_Bridge_Loader_MiniMax_H3(io.ComfyNode):
    """MiniMax H3 の model / text encoder / 映像 VAE / 音声 VAE を 1 ノードで読み込む。

    MiniMaxH3-Director の `model` / `model_ref2va` / `clip` / `vae` / `audio_vae` 入力へ
    そのまま繋げる出力を持ち、サンプリング設定は PIPE に載せて SAX MiniMax H3 Sampler へ渡す。

    - `unet_name`（FL2VA）: t2v と先頭／末尾フレーム指定（i2v）。Director の Refs OFF で使う
    - `ref_unet_name`（REF2VA）: 参照画像・参照動画・参照音声。Director の Refs ON で使う
    - ファイル名に `fl2va` / `ref2va` / `qwen3vl` / `video_vae` / `audio_vae` を含む候補が、
      それぞれの初期値として自動選択される
    - テキストエンコーダの種別（CLIPLoader の type=minimax）は自動で設定する
    """

    @classmethod
    def define_schema(cls):
        unets = folder_paths.get_filename_list("diffusion_models")
        clips = folder_paths.get_filename_list("text_encoders")
        vaes = folder_paths.get_filename_list("vae")
        samplers = comfy.samplers.KSampler.SAMPLERS
        schedulers = comfy.samplers.KSampler.SCHEDULERS
        return io.Schema(
            node_id="SAX_Bridge_Loader_MiniMax_H3",
            display_name="SAX MiniMax H3 Loader",
            category="SAX/Bridge/Loader",
            description=(
                "Loads MiniMax H3 (diffusion model + text encoder + video VAE + audio VAE) for "
                "MiniMaxH3-Director. Connect MODEL / MODEL_REF2VA / CLIP / VAE / AUDIO_VAE to the Director "
                "and PIPE to SAX MiniMax H3 Sampler."
            ),
            inputs=[
                io.Combo.Input(
                    "unet_name",
                    options=[NONE_OPTION] + unets,
                    default=pick_default(unets, "fl2va", fallback=NONE_OPTION),
                    tooltip="FL2VA checkpoint: text-to-video and first/last-frame image-to-video "
                            "(Director with Refs OFF).",
                ),
                io.Combo.Input(
                    "ref_unet_name",
                    options=[NONE_OPTION] + unets,
                    default=NONE_OPTION,
                    tooltip="REF2VA checkpoint: reference images / videos / audio "
                            "(Director with Refs ON). Leave None unless you use references; "
                            "selecting it loads a second ~20GB model.",
                ),
                io.Combo.Input(
                    "clip_name",
                    options=clips,
                    default=pick_default(clips, "qwen3vl", "minimax"),
                    tooltip="Qwen3-VL 32B text encoder for MiniMax H3.",
                ),
                io.Combo.Input(
                    "vae_name",
                    options=vaes,
                    default=pick_default(vaes, "video_vae"),
                    tooltip="MiniMax H3 video VAE.",
                ),
                io.Combo.Input(
                    "audio_vae_name",
                    options=vaes,
                    default=pick_default(vaes, "audio_vae"),
                    tooltip="MiniMax H3 audio VAE. Swapping it with the video VAE gives noisy video.",
                ),
                io.Int.Input("seed", default=0, min=0, max=0xffffffffffffffff, control_after_generate=True),
                io.Int.Input("steps", default=DEFAULT_STEPS, min=1, max=10000,
                             tooltip="20 is the reference value. Quality drops noticeably below ~15."),
                io.Combo.Input("sampler_name", options=samplers,
                               default=_combo_default(samplers, DEFAULT_SAMPLER)),
                io.Combo.Input("scheduler_name", options=schedulers,
                               default=_combo_default(schedulers, DEFAULT_SCHEDULER),
                               tooltip="simple is the reference. beta / normal can suit reference-heavy prompts."),
            ],
            outputs=[
                PipeLine.Output("PIPE"),
                io.Model.Output("MODEL"),
                io.Model.Output("MODEL_REF2VA"),
                io.Clip.Output("CLIP"),
                io.Vae.Output("VAE"),
                io.Vae.Output("AUDIO_VAE"),
            ],
        )

    @classmethod
    def execute(
        cls,
        unet_name: str,
        ref_unet_name: str,
        clip_name: str,
        vae_name: str,
        audio_vae_name: str,
        seed: int,
        steps: int,
        sampler_name: str,
        scheduler_name: str,
    ) -> io.NodeOutput:
        if unet_name == NONE_OPTION and ref_unet_name == NONE_OPTION:
            raise ValueError(
                "[SAX_Bridge] MiniMax H3 Loader: select unet_name (FL2VA) and/or ref_unet_name (REF2VA)."
            )

        def load_unet(name: str, label: str):
            if name == NONE_OPTION:
                return None
            path = resolve_path("diffusion_models", name, f"MiniMax H3 Loader: {label} model")
            return comfy.sd.load_diffusion_model(path)

        model = load_unet(unet_name, "FL2VA")
        model_ref2va = load_unet(ref_unet_name, "REF2VA")

        clip_path = resolve_path("text_encoders", clip_name, "MiniMax H3 Loader: text encoder")
        clip = comfy.sd.load_clip(
            ckpt_paths=[clip_path],
            embedding_directory=folder_paths.get_folder_paths("embeddings"),
            clip_type=_clip_type_minimax(),
        )

        vae = load_vae_file(resolve_path("vae", vae_name, "MiniMax H3 Loader: video VAE"))
        audio_vae = load_vae_file(resolve_path("vae", audio_vae_name, "MiniMax H3 Loader: audio VAE"))

        # latent / conditioning は Director が作る。cfg は H3 の公式設定（BasicGuider = cfg 1 相当）
        pipe = build_pipe(
            model=model if model is not None else model_ref2va,
            clip=clip,
            vae=vae,
            latent=None,
            seed=seed,
            steps=steps,
            cfg=1.0,
            sampler_name=sampler_name,
            scheduler_name=scheduler_name,
            denoise=1.0,
            width=0,
            height=0,
            batch_size=1,
        )
        pipe["audio_vae"] = audio_vae

        return io.NodeOutput(pipe, model, model_ref2va, clip, vae, audio_vae)


def _upstream(module: str, *names: str) -> tuple:
    """ComfyUI 本体のノードクラスを遅延取得する（原因の分かるエラー付き）。"""
    import importlib

    try:
        mod = importlib.import_module(module)
        return tuple(getattr(mod, n) for n in names)
    except (ImportError, AttributeError) as exc:
        raise ValueError(
            f"[SAX_Bridge] MiniMax H3 Sampler requires a ComfyUI version providing {module} "
            f"({', '.join(names)}). Please update ComfyUI (0.30.0 or later)."
        ) from exc


def _first(out: Any) -> Any:
    """V3 ノードの execute 結果から先頭の出力を取り出す。"""
    return out.args[0]


class SAX_Bridge_Sampler_MiniMax_H3(io.ComfyNode):
    """MiniMaxH3-Director の出力をサンプリングし、映像 + 音声の動画まで仕上げる。

    本体の RandomNoise / KSamplerSelect / BasicScheduler / BasicGuider /
    SamplerCustomAdvanced / VAEDecode / VAEDecodeAudio / CreateVideo を 1 ノードにまとめたもの。
    サンプラー・スケジューラー・steps・seed は SAX MiniMax H3 Loader の設定（PIPE）を使う。
    """

    @classmethod
    def define_schema(cls) -> io.Schema:
        return io.Schema(
            node_id="SAX_Bridge_Sampler_MiniMax_H3",
            display_name="SAX MiniMax H3 Sampler",
            category="SAX/Bridge/Sampler",
            description=(
                "Samples the MiniMaxH3-Director output (model / positive / latent) and decodes "
                "video + audio into a VIDEO. Sampling settings come from SAX MiniMax H3 Loader."
            ),
            inputs=[
                PipeLine.Input("pipe", tooltip="PIPE from SAX MiniMax H3 Loader."),
                io.Model.Input("model", tooltip="The patched MODEL output of MiniMaxH3-Director."),
                io.Conditioning.Input("positive", tooltip="The positive output of MiniMaxH3-Director."),
                io.Latent.Input("latent", tooltip="The latent output of MiniMaxH3-Director."),
                io.Float.Input(
                    "fps",
                    default=DEFAULT_FPS,
                    min=1.0,
                    max=240.0,
                    step=1.0,
                    optional=True,
                    tooltip="Frame rate of the output video. H3 is 24 fps; Director's fps output is always 24.",
                ),
            ],
            outputs=[
                PipeLine.Output(display_name="PIPE"),
                io.Video.Output(display_name="VIDEO"),
                io.Image.Output(display_name="IMAGE"),
                io.Audio.Output(display_name="AUDIO"),
            ],
        )

    @classmethod
    def execute(cls, pipe, model, positive, latent, fps: float = DEFAULT_FPS) -> io.NodeOutput:
        require_pipe(pipe, "SAX MiniMax H3 Sampler")
        vae = pipe.get("vae")
        audio_vae = pipe.get("audio_vae")
        if vae is None:
            raise ValueError("[SAX_Bridge] Pipe does not contain a VAE.")
        if audio_vae is None:
            raise ValueError(
                "[SAX_Bridge] Pipe does not contain an audio VAE. "
                "Use the PIPE of SAX MiniMax H3 Loader."
            )

        settings = pipe.get("loader_settings") or {}
        seed = pipe.get("seed", 0)
        steps = settings.get("steps", DEFAULT_STEPS)
        sampler_name = settings.get("sampler_name", DEFAULT_SAMPLER)
        scheduler = settings.get("scheduler", DEFAULT_SCHEDULER)

        (random_noise, sampler_select, basic_scheduler, basic_guider, sampler_advanced) = _upstream(
            "comfy_extras.nodes_custom_sampler",
            "RandomNoise", "KSamplerSelect", "BasicScheduler", "BasicGuider", "SamplerCustomAdvanced",
        )
        # 本体の V3 ノードは execute の引数順が入力の宣言順と一致するとは限らないため、必ずキーワードで渡す
        noise = _first(random_noise.execute(noise_seed=seed))
        sampler = _first(sampler_select.execute(sampler_name=sampler_name))
        sigmas = _first(basic_scheduler.execute(model=model, scheduler=scheduler, steps=steps, denoise=1.0))
        guider = _first(basic_guider.execute(model=model, conditioning=positive))
        sampled = _first(sampler_advanced.execute(
            noise=noise, guider=guider, sampler=sampler, sigmas=sigmas, latent_image=latent
        ))

        # 映像と音声は同じ joint latent から別々の VAE で復号する（本体の標準ワークフローと同じ）
        images = decode_image(vae, sampled["samples"])
        (vae_decode_audio,) = _upstream("comfy_extras.nodes_audio", "VAEDecodeAudio")
        audio = _first(vae_decode_audio.execute(samples=sampled, vae=audio_vae))
        (create_video,) = _upstream("comfy_extras.nodes_video", "CreateVideo")
        video = _first(create_video.execute(images=images, fps=fps, audio=audio))

        new_pipe = {**pipe, "samples": sampled, "images": images}
        new_settings = dict(settings)
        # 実際に生成されたフレームサイズを記録する（Loader の時点では Director 任せで未確定）
        new_settings["clip_width"] = int(images.shape[-2])
        new_settings["clip_height"] = int(images.shape[-3])
        new_pipe["loader_settings"] = new_settings

        return io.NodeOutput(new_pipe, video, images, audio)
