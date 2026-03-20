import os
import torch
import folder_paths
import nodes
import comfy.model_management
import comfy.model_sampling
import comfy.sd
import comfy.utils
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

        # 既存のpipeを壊さないよう、シャローコピーを作成
        new_pipe = pipe.copy()

        # Input (上書き処理)
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

        # loader_settings を取得し、修正用にコピーを作成
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

        # 更新した loader_settings を再セット
        new_pipe["loader_settings"] = loader_settings

        # Output (展開処理)
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


class SAX_Bridge_Pipe_Loader(io.ComfyNode):
    @classmethod
    def define_schema(cls):
        return io.Schema(
            node_id="SAX_Bridge_Pipe_Loader",
            display_name="SAX Loader",
            category="SAX/Bridge/Pipe",
            description="CSB Loader (V3)",
            inputs=[
                io.Combo.Input("ckpt_name", options=folder_paths.get_filename_list("checkpoints")),
                io.Int.Input("clip_skip", default=-1, min=-24, max=-1, step=1),
                io.Combo.Input("vae_name", options=["baked_vae"] + folder_paths.get_filename_list("vae")),
                io.Combo.Input("lora_name", options=["None"] + folder_paths.get_filename_list("loras")),
                io.Float.Input("lora_model_strength", default=1.0, min=-10.0, max=10.0, step=0.01),
                io.Boolean.Input("v_pred", default=False),
                io.Int.Input("seed", default=0, min=0, max=0xffffffffffffffff),
                io.Int.Input("steps", default=20, min=1, max=10000),
                io.Float.Input("cfg", default=8.0, min=0.0, max=100.0, step=0.5),
                io.Combo.Input("sampler_name", options=comfy.samplers.KSampler.SAMPLERS),
                io.Combo.Input("scheduler_name", options=comfy.samplers.KSampler.SCHEDULERS),
                io.Float.Input("denoise", default=1.0, min=0.0, max=1.0, step=0.01),
                io.Int.Input("width", default=512, min=1, max=8192, step=8),
                io.Int.Input("height", default=512, min=1, max=8192, step=8),
                io.Int.Input("batch_size", default=1, min=1, max=4096),
            ],
            outputs=[
                PipeLine.Output("PIPE"),
                io.Int.Output("SEED"),
            ],
        )

    @classmethod
    def execute(cls, ckpt_name, clip_skip, vae_name, lora_name, lora_model_strength, v_pred, seed, steps, cfg, sampler_name, scheduler_name, denoise, width, height, batch_size) -> io.NodeOutput:
        # 1. Load Checkpoint
        ckpt_path = folder_paths.get_full_path("checkpoints", ckpt_name)
        out = comfy.sd.load_checkpoint_guess_config(ckpt_path, output_vae=True, output_clip=True, embedding_directory=folder_paths.get_folder_paths("embeddings"))
        model, clip, vae = out[0], out[1], out[2]

        # 2. CLIP Skip
        clip = clip.clone()
        clip.clip_layer(clip_skip)

        # 3. Load VAE if not baked
        if vae_name != "baked_vae":
            vae_path = folder_paths.get_full_path("vae", vae_name)
            vae = comfy.sd.VAE(sd=comfy.utils.load_torch_file(vae_path))

        # 4. Apply LoRA
        if lora_name != "None":
            lora_path = folder_paths.get_full_path("loras", lora_name)
            lora = comfy.utils.load_torch_file(lora_path)
            model, clip = comfy.sd.load_lora_for_models(model, clip, lora, lora_model_strength, lora_model_strength)

        # 5. V-Pred logic
        if v_pred:
            class ModelSamplingAdvanced(comfy.model_sampling.ModelSamplingDiscrete, comfy.model_sampling.V_PREDICTION):
                pass
            model = model.clone()
            model_sampling = ModelSamplingAdvanced(model.model.model_config, zsnr=True)
            model.add_object_patch("model_sampling", model_sampling)

        # 6. Empty Latent
        latent = torch.zeros([batch_size, 4, height // 8, width // 8])
        latent_out = {"samples": latent}

        # 7. Create Pipe
        pipe = {
            "model": model,
            "clip": clip,
            "vae": vae,
            "samples": latent_out,
            "images": None,
            "seed": seed,
            "loader_settings": {
                "steps": steps,
                "cfg": cfg,
                "sampler_name": sampler_name,
                "scheduler": scheduler_name,
                "denoise": denoise,
                "clip_width": width,
                "clip_height": height,
                "positive": "",
                "negative": "",
                "xyplot": None,
                "batch_size": batch_size,
            }
        }

        return io.NodeOutput(pipe, seed)
