<a id="top"></a>

# SAX_Bridge Node Reference

[← Back to README](../README.md)

> The node IDs, display names, categories and **Inputs** (widget) lists on this page are checked
> against each node's `define_schema()` in CI by `tests/python/test_docs_schema_sync.py`.
> When you change the implementation, update this page and `docs/nodes_ja.md` as well.

---

## Category List

| Category | Description | Nodes |
|---------|------|-------|
| [Loader](#loader) | Model and LoRA loading | [SAX Loader](#sax-loader) / [SAX Diffusion Loader](#sax-diffusion-loader) / [SAX MiniMax H3 Loader](#sax-minimax-h3-loader) / [SAX Lora Loader](#sax-lora-loader) |
| [Sampler](#sampler) | KSampler | [SAX KSampler](#sax-ksampler) / [SAX MiniMax H3 Sampler](#sax-minimax-h3-sampler) |
| [Pipe](#pipe) | Pipe construction and switching | [SAX Pipe](#sax-pipe) / [SAX Pipe Switcher](#sax-pipe-switcher) |
| [Prompt](#prompt) | Prompt encoding and concatenation | [SAX Prompt](#sax-prompt) / [SAX Prompt Concat](#sax-prompt-concat) / [SAX Qwen Image Prompt](#sax-qwen-image-prompt) |
| [Enhance](#enhance) | Guidance / Detailer / Upscaler / Finisher | [SAX Guidance](#sax-guidance) / [SAX Detailer](#sax-detailer) / [SAX Enhanced Detailer](#sax-enhanced-detailer) / [SAX Upscaler](#sax-upscaler) / [SAX Finisher](#sax-finisher) |
| [Control](#control) | ControlNet structure constraint | [SAX Structure Lock (SDXL)](#sax-structure-lock-sdxl) |
| [Option](#option) | Standalone utilities (noise injection etc.) | [SAX Image Noise](#sax-image-noise) / [SAX Latent Noise](#sax-latent-noise) |
| [Segment](#segment) | Segmentation via SAM3 | [SAX SAM3 Loader](#sax-sam3-loader) / [SAX SAM3 Multi Segmenter](#sax-sam3-multi-segmenter) |
| [Mask](#mask) | Mask post-processing | [SAX Mask Adjust](#sax-mask-adjust) |
| [Output](#output) | Output and preview | [SAX Output](#sax-output) / [SAX Image Preview](#sax-image-preview) |
| [Collect](#collect) | Node / image / pipe aggregation | [SAX Image Collector](#sax-image-collector) / [SAX Node Collector](#sax-node-collector) / [SAX Pipe Collector](#sax-pipe-collector) |
| [Debug](#debug) | Debugging & testing | [SAX Debug Controller](#sax-debug-controller) / [SAX Assert](#sax-assert) / [SAX Assert Pipe](#sax-assert-pipe) / [SAX Debug Inspector](#sax-debug-inspector) / [SAX Debug Text](#sax-debug-text) |
| [Utility](#utility) | Pipe-internal helpers | [SAX Primitive Store](#sax-primitive-store) / [SAX Text Catalog](#sax-text-catalog) / [SAX Text Catalog V2](#sax-text-catalog-v2) / [SAX Cache](#sax-cache) / [SAX Toggle Manager](#sax-toggle-manager) |

---

## Loader

### SAX Loader

`SAX_Bridge_Loader` — Loads a checkpoint, VAE, and LoRA in one node and initializes the `PIPE_LINE` context.

**Inputs**

| Parameter | Type | Description |
|-----------|-----|------|
| `ckpt_name` | Combo | Checkpoint file selection |
| `clip_skip` | Int (-24 to -1) | Number of CLIP layers to skip |
| `vae_name` | Combo | VAE selection (`baked_vae` uses the model's built-in VAE) |
| `lora_name` | Combo | LoRA selection (`None` to skip) |
| `lora_model_strength` | Float (-10.0 to 10.0) | LoRA model strength |
| `v_pred` | Boolean | V-Prediction mode (automatically applies V_PREDICTION + ZSNR) |
| `seed` | Int | Initial seed value |
| `steps` | Int | Sampling steps |
| `cfg` | Float | CFG scale |
| `sampler_name` | Combo | Sampler selection |
| `scheduler_name` | Combo | Scheduler selection |
| `denoise` | Float (0.0 to 1.0) | Denoise strength |
| `width` / `height` | Int | Generation resolution (multiples of 8) |
| `batch_size` | Int | Batch size |

**Outputs**: `PIPE`, `SEED`

**Behavior**:
- Initial fields of the constructed pipe dict:
  - `model`, `clip`, `vae`, `samples`, `seed` — generated values
  - `positive`: `None` (set by downstream Prompt nodes)
  - `negative`: `None` (set by downstream Prompt nodes; may also be auto-filled by KSampler)
  - `images`: `None` (set by downstream VAE Decode / Sampler)
  - `loader_settings`: dict holding `steps` / `cfg` / `sampler_name` / `scheduler` / `denoise`
- `clip_skip` sets the model's clip_skip
- `lora_model_strength` applies the same value to both the LoRA model strength and clip strength (single slider control)

[↑ Back to top](#top)

---

### SAX Diffusion Loader

`SAX_Bridge_Loader_Diffusion` — Loads a UNET (diffusion model), CLIP (text encoder), and VAE from separate folders and initializes the `PIPE_LINE` context. Intended for split-distribution models (such as Anima, Krea 2, and Qwen-Image 2.1) where model/clip/vae are not baked into a checkpoint. The output pipe shares the same structure as SAX Loader, so downstream nodes work unchanged.

**Inputs**

| Parameter | Type | Description |
|-----------|-----|------|
| `unet_name` | Combo | Diffusion model file selection (`diffusion_models` folder) |
| `weight_dtype` | Combo | UNET weight dtype (`default` / `fp8_e4m3fn` / `fp8_e4m3fn_fast` / `fp8_e5m2`) |
| `clip_name` | Combo | Text encoder file selection (`text_encoders` folder) |
| `vae_name` | Combo | VAE file selection (`vae` folder; always an external VAE) |
| `lora_name` | Combo | LoRA selection (`None` to skip) |
| `lora_model_strength` | Float (-10.0 to 10.0) | LoRA model strength |
| `seed` | Int | Initial seed value |
| `steps` | Int | Sampling steps |
| `cfg` | Float | CFG scale |
| `sampler_name` | Combo | Sampler selection |
| `scheduler_name` | Combo | Scheduler selection |
| `denoise` | Float (0.0 to 1.0) | Denoise strength |
| `width` / `height` | Int | Generation resolution (multiples of 8) |
| `batch_size` | Int | Batch size |

**Outputs**: `PIPE`, `SEED`

**Behavior**:
- `model` is loaded from `diffusion_models` via `load_diffusion_model`, `clip` from `text_encoders` via `load_clip`, and `vae` from the `vae` folder, each independently
- `clip_type` is auto-detected from the UNET model_config (Krea 2 → `KREA2`; Qwen-Image / Qwen-Image 2.1 → `QWEN_IMAGE`; unregistered models fall back to `STABLE_DIFFUSION`). Anima's Qwen3 0.6B is detected from the text encoder state_dict.
- The empty latent is created with 4 channels at 1/8 scale; KSampler's `fix_empty_latent_channels` adapts it to the model's latent_channels / latent_dimensions / downscale ratio automatically (16-channel / 3-dimensional models and the 64-channel, 1/16 Qwen-Image 2.1 need no extra setup)
- The `weight_dtype` fp8 options apply the same dtype mapping as ComfyUI's built-in UNETLoader
- `lora_model_strength` applies the same value to both the LoRA model strength and clip strength
- Unlike SAX Loader, it has no `clip_skip` / `v_pred` (not applicable to diffusion models' flow-based sampling and non-CLIP text encoders)

**Krea 2 support**:
- Required files: `diffusion_models/krea2_*.safetensors` + `text_encoders/qwen3vl_4b_*.safetensors` + `vae/qwen_image_vae.safetensors`
- The text encoder **must be Qwen3VL-4B** (anything else does not enter ComfyUI's KREA2-specific encoder branch and produces invalid conditioning)
- Unsupported features: `structure_control` (SDXL only) / `ays_sd1`, `ays_sdxl` schedulers (SD1/SDXL only) / SAX_Cache TGate and DeepCache (UNet-based, not applicable to DiT)

[↑ Back to top](#top)

---

### SAX MiniMax H3 Loader

`SAX_Bridge_Loader_MiniMax_H3` — Loads the diffusion model, text encoder, video VAE, and audio VAE of MiniMax H3 (a joint video + audio model) in one node. Outputs individual connections that go straight into [MiniMaxH3-Director](https://github.com/seesee75-commits/ComfyUI-MiniMaxH3-Director), plus a `PIPE_LINE` for SAX MiniMax H3 Sampler. Requires ComfyUI 0.30.0 or later.

**Inputs**

| Parameter | Type | Description |
|-----------|-----|------|
| `unet_name` | Combo | FL2VA checkpoint (text-to-video and first/last-frame image-to-video; Director with Refs OFF). `None` skips loading |
| `lora_name` | Combo | LoRA for the FL2VA model (e.g. the turbo 4-step / 8-step LoRA). `None` skips. Set `steps` to 4 / 8 to match |
| `ref_unet_name` | Combo | REF2VA checkpoint (reference images / videos / audio; Director with Refs ON). Defaults to `None`; selecting one loads a second ~20GB model |
| `ref_lora_name` | Combo | LoRA for the REF2VA model (e.g. the REF2V turbo 4-step LoRA). `None` skips |
| `lora_strength` | Float (-10.0 to 10.0) | LoRA strength (the same value for both) |
| `clip_name` | Combo | Text encoder (Qwen3-VL 32B) from the `text_encoders` folder |
| `vae_name` | Combo | Video VAE from the `vae` folder |
| `audio_vae_name` | Combo | Audio VAE from the `vae` folder (swapping it with the video VAE puts noise in the video) |
| `seed` | Int | Seed value |
| `steps` | Int | Sampling steps (default 20) |
| `sampler_name` | Combo | Sampler selection (default `res_multistep`) |
| `scheduler_name` | Combo | Scheduler selection (default `simple`) |

**Outputs**: `PIPE`, `MODEL`, `MODEL_REF2VA`, `CLIP`, `VAE`, `AUDIO_VAE`

**Behavior**:
- Each Combo's initial value is the first file whose name contains `fl2va` / `qwen3vl` + `minimax` / `video_vae` / `audio_vae`, so placing the files is enough
- The text encoder type (CLIPLoader `type=minimax`) is set automatically
- Either `unet_name` or `ref_unet_name` alone is fine; both `None` is an error
- Connect `MODEL` / `MODEL_REF2VA` / `CLIP` / `VAE` / `AUDIO_VAE` to the same-named Director inputs. An unselected model outputs `None`
- The `PIPE` carries `MODEL` (or `MODEL_REF2VA` when that is the only one) as `model` and the audio VAE as `audio_vae`; sampling settings go to `loader_settings` (`cfg` is fixed at 1.0 and `denoise` at 1.0, the official H3 setup)
- Resolution, length, latent, and conditioning are decided by the Director, so this loader has no `width` / `height` / `batch_size`
- LoRAs are applied to the model only. `lora_name` goes to the FL2VA model and `ref_lora_name` to the REF2VA model (a mismatched LoRA has no effect). It is an error if the matching model is `None`
- With a turbo LoRA, set `steps` to match (4 / 8) and adjust the Director's `shift_video` if needed

[↑ Back to top](#top)

---

### SAX Lora Loader

`SAX_Bridge_Loader_Lora` — Applies multiple LoRAs to the model/clip in the Pipe. Each LoRA can be individually toggled, strength-adjusted, and reordered.

**Inputs**

| Parameter | Type | Description |
|-----------|-----|------|
| `pipe` | PIPE_LINE | Input pipe |
| `enabled` | Boolean | When `False`, returns the pipe unchanged without applying LoRAs |
| `loras_json` | String (hidden) | JSON array of LoRA entries, managed automatically by the node UI |

**Outputs**: `PIPE` (model / clip overwritten)

#### UI Operations

| Operation | Behavior |
|------|------|
| Click LoRA name area | Opens the LoRA selection picker |
| Drag strength box (up/down) | Continuously adjust strength (1px = 0.01) |
| Click strength box | Opens numeric input popup |
| Click pill | Toggle LoRA ON/OFF |
| Click ▲ / ▼ | Reorder LoRAs |
| Click ✕ | Remove LoRA |
| Click `+ Add Item` | Add a LoRA entry (up to 10) |

> **Clip strength**: Always linked to model strength (single slider control).

**Behavior**:
- If LoRA loading fails, a warning is logged and the entry is skipped, while remaining LoRAs continue to be applied
- Entries with `strength=0.0` are skipped
- Entries missing the `on` key are treated as `True` (enabled)

[↑ Back to top](#top)

---

## Sampler

### SAX KSampler

`SAX_Bridge_KSampler` — Receives a Pipe, runs KSampler, and returns an updated Pipe. Sampling parameters are automatically read from `loader_settings` in the Pipe.

**Inputs**

| Parameter | Type | Description |
|-----------|-----|------|
| `pipe` | PIPE_LINE | Input pipe (uses model, positive, latent, seed) |
| `decode_vae` | Boolean | `decode` (True) runs VAE Decode and outputs IMAGE. `latent only` (False) updates Latent only |

**Outputs**: `PIPE`, `IMAGE`

**Behavior**:
- Reads `model`, `positive`, `latent`, `vae`, `seed` from the Pipe
- If `negative` is absent from the Pipe, auto-generates empty conditioning by encoding an empty string with CLIP
- Sampling settings (`steps`, `cfg`, `sampler_name`, `scheduler`, `denoise`) are inherited from `loader_settings`
- When `decode_vae=False`, the `IMAGE` output is `None`

**loader_settings fallback behavior**:

In the normal flow (Loader → Pipe → KSampler), `loader_settings` is always populated. If a custom path leaves `loader_settings` missing or partially absent from the pipe, the following default values are used.

| Key | Default |
|-----|---------|
| `steps` | `20` |
| `cfg` | `8.0` |
| `sampler_name` | `"euler"` |
| `scheduler` | `"normal"` |
| `denoise` | `1.0` |
| `seed` (`pipe.seed`) | `0` |

[↑ Back to top](#top)

---

### SAX MiniMax H3 Sampler

`SAX_Bridge_Sampler_MiniMax_H3` — Samples the MiniMaxH3-Director output (`model` / `positive` / `latent`), decodes video and audio, and produces a `VIDEO`. It folds the standard RandomNoise → KSamplerSelect → BasicScheduler → BasicGuider → SamplerCustomAdvanced → VAEDecode / VAEDecodeAudio → CreateVideo chain into one node.

**Inputs**

| Parameter | Type | Description |
|-----------|-----|------|
| `pipe` | PIPE_LINE | PIPE from SAX MiniMax H3 Loader (uses the VAE, audio VAE, seed, and sampling settings) |
| `model` | MODEL | The Director's `model` output (sigma shift applied) |
| `positive` | CONDITIONING | The Director's `positive` output |
| `latent` | LATENT | The Director's `latent` output |
| `fps` | Float (1 to 240, optional) | Output frame rate. Defaults to 24 (H3 is fixed at 24fps and the Director's `fps` is always 24) |

**Outputs**: `PIPE`, `VIDEO`, `IMAGE`, `AUDIO`

**Behavior**:
- Sampling and video creation are delegated to ComfyUI core nodes (`comfy_extras.nodes_custom_sampler` / `nodes_audio` / `nodes_video`)
- `seed` / `steps` / `sampler_name` / `scheduler` come from the pipe; guidance is BasicGuider (no CFG) and denoise is fixed at 1.0
- Video and audio are decoded from the same joint latent, with the video VAE and the audio VAE respectively
- The output `PIPE` has `samples` / `images` updated, and `loader_settings` `clip_width` / `clip_height` set to the actual frame size

```
SAX MiniMax H3 Loader → MiniMax H3 Director → SAX MiniMax H3 Sampler → Save Video
```

Connect the Loader's `MODEL` / `MODEL_REF2VA` / `CLIP` / `VAE` / `AUDIO_VAE` to the Director, and the Loader's `PIPE` plus the Director's `model` / `positive` / `latent` to the Sampler.

[↑ Back to top](#top)

---

## Pipe

### SAX Pipe

`SAX_Bridge_Pipe` — Extracts, overrides, and reconstructs arbitrary elements from a `PIPE_LINE`. When an input is `None`, the value in the Pipe is preserved, allowing partial overrides.

**Inputs**: `pipe` (optional) + `model`, `pos`, `neg`, `latent`, `vae`, `clip`, `image`, `seed`, `steps`, `cfg`, `sampler`, `scheduler`, `denoise`, `optional_sampler`, `optional_sigmas` (all optional)

**Outputs**: `PIPE`, `MODEL`, `POS`, `NEG`, `LATENT`, `VAE`, `CLIP`, `IMAGE`, `SEED`, `STEPS`, `CFG`, `SAMPLER`, `SCHEDULER`, `DENOISE`, `OPTIONAL_SAMPLER`, `OPTIONAL_SIGMAS`

[↑ Back to top](#top)

---

### SAX Pipe Switcher

`SAX_Bridge_Pipe_Switcher` — Selects a valid Pipe from multiple Pipe inputs and expands it. Functions as a switch for conditionally routing Pipes through wiring alone.

**Inputs**

| Parameter | Type | Description |
|-----------|-----|------|
| `slot` | Int (0 to 5) | Preferred slot number (1-indexed). `0` auto-scans in slot order |
| `pipe1` to `pipe5` | PIPE_LINE (optional) | Input pipes |

**Outputs**: Same as SAX Pipe (`PIPE`, `MODEL`, `POS`, `NEG`, `LATENT`, `VAE`, `CLIP`, `IMAGE`, `SEED`, `STEPS`, `CFG`, `SAMPLER`, `SCHEDULER`, `DENOISE`, `OPTIONAL_SAMPLER`, `OPTIONAL_SIGMAS`)

**Selection Logic**:
1. When `slot` is 1–5, the specified slot's Pipe takes highest priority
2. If the specified slot is None, or `slot` is outside the 1–5 range (including `0` and values greater than 5), scans `pipe1` → `pipe5` in order and uses the first non-None (`slot=0` is treated as auto-scan mode)
3. If all slots are None, expands safely as an empty Pipe

[↑ Back to top](#top)

---

## Prompt

### SAX Prompt

`SAX_Bridge_Prompt` — Handles wildcard expansion, LoRA tag extraction, and `BREAK`-syntax split encoding in one node.

**Inputs**

| Parameter | Type | Description |
|-----------|-----|------|
| `pipe` | PIPE_LINE | Input pipe |
| `wildcard_text` | String (multiline) | Prompt text. Supports wildcards (`__tag__`), LoRA tags (`<lora:name:weight>`), and `BREAK` syntax |
| `select_to_add_lora` | Combo | LoRA picker. Selecting an entry appends `<lora:name>` to `wildcard_text` (the value itself is unused at execution) |
| `select_to_add_wildcard` | Combo | Wildcard picker. Selecting an entry appends `__tag__` to `wildcard_text` (the value itself is unused at execution) |

**Outputs**: `PIPE`, `POPULATED_TEXT` (expanded text)

**Behavior**:
1. Randomly expands wildcard tokens based on the seed inherited from the Pipe
2. Extracts LoRA tags and applies them to Model and CLIP
3. Splits text into chunks at `BREAK`, encodes each chunk with CLIP, and concatenates with `ConditioningConcat`

> Wildcard functionality is only available when `comfyui-impact-pack` is installed.

[↑ Back to top](#top)

---

### SAX Prompt Concat

`SAX_Bridge_Prompt_Concat` — Concatenates multiple text inputs (up to 32 ports) and processes them together.

**Inputs**: `pipe`, `target_positive` (Boolean), `texts` (Autogrow; grows from `text1` up to 32 ports)

**Outputs**: `PIPE`, `CONDITIONING`, `POPULATED_TEXT`

Use `target_positive` to choose whether the result is stored in Positive or Negative.

[↑ Back to top](#top)

---

### SAX Qwen Image Prompt

`SAX_Bridge_Prompt_Qwen_Image` — Prompt node dedicated to Qwen-Image 2.1. With no reference images it works as text-to-image; with images connected it works as image-to-image (multi-image editing with up to 10 images). Positive and negative are encoded together and stored in the Pipe.

**Inputs**

| Parameter | Type | Description |
|-----------|------|-------------|
| `pipe` | PIPE_LINE | Pipe from SAX Diffusion Loader with Qwen-Image 2.1 loaded |
| `wildcard_text` | String | Prompt / edit instruction. Refer to reference images as `<image1>`, `<image2>`, ... Wildcard and LoRA syntax supported |
| `negative_text` | String | Negative prompt (no effect with the official cfg=1 setting) |
| `resolution` | Int (0–4096, step 32) | Reference images are resized to about resolution × resolution pixels (aspect ratio kept, multiples of 32). 0 keeps the original size |
| `images` | Autogrow | Reference images (grows from `image_1` up to 10 ports). `image_1` is the edit target |

**Outputs**: `PIPE`, `POPULATED_TEXT`

**Behavior**:
- Encoding is delegated to ComfyUI's built-in `TextEncodeQwenImage21` (requires a ComfyUI version with Qwen-Image 2.1 support)
- Without reference images: the latent keeps the Loader's `width` / `height` (text-to-image)
- With reference images: the latent is replaced with the resized size of `image_1`, with the Loader's `batch_size` (a different size shifts the edit)
- LoRA syntax is applied from `wildcard_text` only (LoRA tags in `negative_text` are just removed)

**Recommended settings** (following the official workflow): on SAX Diffusion Loader set `cfg=1`, `sampler_name=euler`, `scheduler_name=simple`, `steps=25`–`50`.

```
t2i: SAX Diffusion Loader → SAX Qwen Image Prompt → SAX KSampler → SAX Output
i2i: same; just connect images to image_1, image_2, ... of SAX Qwen Image Prompt
```

[↑ Back to top](#top)

---

## Enhance

### SAX Guidance

`SAX_Bridge_Guidance` — Applies AGC / FDG / PAG guidance enhancement to the model in the Pipe. Insert it before KSampler, Detailer, or Upscaler.

**Inputs**

| Parameter | Type | Description |
|-----------|-----|------|
| `pipe` | PIPE_LINE | Input pipe |
| `mode` | Combo | `off` / `agc` / `fdg` / `agc+fdg` (default) / `post_fdg` |
| `strength` | Float (0.0 to 1.0) | AGC / FDG intensity. `0.0` = disabled, `0.5` = moderate, `1.0` = maximum |
| `pag_strength` | Float (0.0 to 1.0) | PAG (Perturbed Attention Guidance) intensity. `0.0` = disabled. Can be combined with any `mode` |

**Outputs**: `PIPE` (with the model replaced)

**Modes**

| mode | Hook | Purpose |
|------|------|---------|
| `off` | — | Guidance disabled (`pag_strength` can still apply) |
| `agc` | `sampler_cfg_function` | Soft-clips high-CFG spikes with tanh to avoid blowouts |
| `fdg` | `sampler_cfg_function` | Splits frequency bands and boosts the high band for detail (for high CFG) |
| `agc+fdg` | `sampler_cfg_function` | Both of the above |
| `post_fdg` | `sampler_post_cfg_function` | Band splitting that also works at low CFG / low-step LoRA |

**Behavior**:
- Returns the Pipe unchanged when `mode` is `off` or `strength` is `0.0`, and `pag_strength` is also `0.0`
- Returns the Pipe unchanged (no error) when the Pipe has no `model`
- PAG is added as a post_cfg_function, so it composes with the `mode` guidance
- When PAG is active, one extra forward pass per step is performed

[↑ Back to top](#top)

---

### SAX Detailer

`SAX_Bridge_Detailer` — Crops a mask region, runs i2i redraw, and blends the result back into the original image. Built-in Differential Diffusion ensures natural boundary blending. Across multiple cycles, VAE encode/decode is performed only once each, and the latent is preserved between cycles.

**Inputs**

| Parameter | Type | Default | Description |
|-----------|-----|---------|-------------|
| `pipe` | PIPE_LINE | — | Input pipe (uses Model, VAE, Conditioning) |
| `denoise` | Float (0.0 to 1.0) | 0.45 | i2i denoise strength |
| `cycle` | Int (1 to 10) | 1 | Number of cycles |
| `crop_factor` | Float (1.0 to 10.0) | 3.0 | Bounding box expansion multiplier |
| `noise_mask_feather` | Int (0 to 100) | 5 | Mask boundary blur in latent space (Differential Diffusion) |
| `blend_feather` | Int (0 to 100) | 5 | Blend boundary blur in image space |
| `mask` | MASK (optional) | — | Target mask for detailing (whole image if omitted) |
| `steps_override` | Int (0 to 200, optional) | 0 | i2i steps override (0 = inherit from Loader) |
| `cfg_override` | Float (0.0 to 100.0, optional) | 0.0 | i2i CFG override (0.0 = inherit from Loader) |
| `guidance_mode` | Combo (optional) | `off` | CFG guidance enhancement (`agc` / `fdg` / `agc+fdg` / `post_fdg`) |
| `guidance_strength` | Float (0.0 to 1.0, optional) | 0.5 | Guidance effect intensity |
| `pag_strength` | Float (0.0 to 1.0, optional) | 0.0 | Perturbed Attention Guidance strength (works at any CFG. Adds one extra forward pass per step) |
| `positive_prompt` | String (optional) | — | Override for positive prompt |

**Outputs**: `PIPE`, `IMAGE`

> If `negative` is absent from the Pipe, empty conditioning is auto-generated by encoding an empty string with CLIP.

> **Structure constraint**: if the pipe carries settings from an upstream [SAX Structure Lock (SDXL)](#sax-structure-lock-sdxl) node, they are consumed transparently.

[↑ Back to top](#top)

---

### SAX Enhanced Detailer

`SAX_Bridge_Detailer_Enhanced` — An enhanced version of SAX Detailer with `denoise_decay`, Shadow Enhancement, Edge Enhancement, Latent Noise injection, and Context Blur.

Image-domain preprocessing (`shadow_enhance` / `edge_weight` / `context_blur_sigma`) is applied only once before VAE encode. `latent_noise_intensity` is added independently each cycle and decays in sync with `denoise_decay`.

**Inputs**

| Parameter | Type | Default | Description |
|-----------|-----|---------|-------------|
| `pipe` | PIPE_LINE | — | Input pipe |
| `denoise` | Float (0.0 to 1.0) | 0.45 | i2i denoise strength |
| `denoise_decay` | Float (0.0 to 1.0) | 0.0 | Denoise decay rate per cycle (also decays `latent_noise_intensity`) |
| `cycle` | Int (1 to 10) | 1 | Number of cycles |
| `crop_factor` | Float (1.0 to 10.0) | 3.0 | Bounding box expansion multiplier |
| `noise_mask_feather` | Int (0 to 100) | 5 | Mask boundary blur in latent space |
| `blend_feather` | Int (0 to 100) | 5 | Blend boundary blur in image space |
| `shadow_enhance` | Float (0.0 to 1.0) | 0.0 | Shadow shading intensity applied to dark areas (applied once before encode) |
| `edge_weight` | Float (0.0 to 1.0) | 0.0 | Edge sharpening strength (Unsharp Mask, applied once before encode) |
| `edge_blur_sigma` | Float (0.1 to 10.0) | 1.0 | Gaussian kernel width for Unsharp Mask |
| `latent_noise_intensity` | Float (0.0 to 2.0) | 0.1 | Latent noise injection strength (added independently per cycle, decays with `denoise_decay`) |
| `noise_type` | Combo | `gaussian` | `gaussian` / `uniform` |
| `context_blur_sigma` | Float (0.0 to 64.0) | 0.0 | Context area blur strength near mask boundary (0 = disabled. Applied once before encode) |
| `context_blur_radius` | Int (0 to 256) | 48 | Ring width in px for context blur target (0 = full context) |
| `mask` | MASK (optional) | — | Target mask for detailing |
| `steps_override` | Int (0 to 200, optional) | 0 | i2i steps override |
| `cfg_override` | Float (0.0 to 100.0, optional) | 0.0 | i2i CFG override |
| `guidance_mode` | Combo (optional) | `off` | CFG guidance enhancement |
| `guidance_strength` | Float (0.0 to 1.0, optional) | 0.5 | Guidance effect intensity |
| `pag_strength` | Float (0.0 to 1.0, optional) | 0.0 | Perturbed Attention Guidance strength |
| `positive_prompt` | String (optional) | — | Override for positive prompt |

**Outputs**: `PIPE`, `IMAGE`

> **Structure constraint**: if the pipe carries settings from an upstream [SAX Structure Lock (SDXL)](#sax-structure-lock-sdxl) node, they are consumed transparently.

**denoise_decay formula**:

The effective denoise and latent noise intensity at cycle `i` (0-indexed) are computed as:

```
decay_factor(i) = max(0.0, 1.0 - i * denoise_decay / cycle)
effective_denoise(i) = denoise * decay_factor(i)
effective_noise_intensity(i) = latent_noise_intensity * decay_factor(i)
```

Example: with `cycle=3`, `denoise=1.0`, `denoise_decay=0.9` → `[1.0, 0.7, 0.4]`

[↑ Back to top](#top)

---

### SAX Upscaler

`SAX_Bridge_Upscaler` — Upscales the image in the Pipe with an optional lightweight i2i pass.

**Inputs**

| Parameter | Type | Description |
|-----------|-----|------|
| `pipe` | PIPE_LINE | Input pipe |
| `upscale_model_name` | Combo | Upscale model selection (`None` = pixel interpolation only) |
| `method` | Combo | Pixel interpolation method (`lanczos` / `bilinear` / `bicubic` / `nearest-exact`) |
| `scale_by` | Float (0.25 to 8.0) | Scale multiplier relative to the original resolution |
| `denoise` | Float (0.0 to 1.0) | 0 = upscale only. Values greater than 0 run a lightweight i2i pass after upscaling |
| `steps_override` | Int (0 to 200) | i2i steps (0 = inherit from Loader) |
| `cfg_override` | Float (0.0 to 100.0) | i2i CFG (0.0 = inherit from Loader) |
| `guidance_mode` | Combo (optional) | CFG guidance enhancement for i2i pass (`off` / `agc` / `fdg` / `agc+fdg` / `post_fdg`) |
| `guidance_strength` | Float (0.0 to 1.0) | Guidance effect intensity |
| `pag_strength` | Float (0.0 to 1.0) | Perturbed Attention Guidance strength (works at any CFG. Adds one extra forward pass per step) |
| `positive_prompt` | String (optional) | Override for positive prompt in i2i pass (effective only when `denoise > 0`) |

**Outputs**: `PIPE`, `IMAGE`

**Behavior**:
- If `upscale_model_name` is not `None`, upscales with an ESRGAN-based model then resizes to the `scale_by` target size
- If `denoise > 0`, runs KSampler (i2i) after upscaling to restore texture
- If `negative` is absent from the Pipe, empty conditioning is auto-generated by encoding an empty string with CLIP

> ESRGAN models work well for restoring real-world and compressed images. For AI-generated anime-style images, dedicated anime models such as `4x-AnimeSharp` are recommended.

> **Structure constraint**: if the pipe carries settings from an upstream [SAX Structure Lock (SDXL)](#sax-structure-lock-sdxl) node, they are consumed transparently in the i2i pass.

[↑ Back to top](#top)

---

### SAX Finisher

`SAX_Bridge_Finisher` — Finishing node that applies post-processing effects and image quality adjustments. Place between Detailer / Upscaler and Output.

**Inputs**

| Parameter | Type | Description |
|-----------|------|-------------|
| `pipe` | PIPE_LINE | Input pipe |
| `reference_image` | IMAGE (optional) | Reference image for `color_correction`. Color correction is skipped when not connected |
| `color_correction` | Float (0.0 to 1.0) | Matches color distribution to reference via mean/std (0 = off) |
| `smooth` | Float (0.0 to 1.0) | High-frequency suppression (reduces jaggies and harsh edges). 0 = off |
| `sharpen_strength` | Float (0.0 to 2.0) | Unsharp Mask sharpening strength. 0 = off |
| `sharpen_sigma` | Float (0.1 to 5.0) | Sharpening kernel width |
| `bloom` | Float (0.0 to 1.0) | Soft glow from bright areas. 0 = off |
| `bloom_threshold` | Float (0.0 to 1.0) | Brightness threshold for bloom extraction (lower = more glow) |
| `bloom_radius` | Float (1.0 to 32.0) | Bloom spread radius (gaussian sigma) |
| `vignette` | Float (0.0 to 1.0) | Edge darkening to focus the center. 0 = off |
| `color_temp` | Float (-1.0 to +1.0) | Color temperature shift. Positive = warm / negative = cool |
| `grayscale` | Boolean | ITU-R BT.709 grayscale conversion (applied last) |

**Outputs**: `PIPE`, `IMAGE`

**Order of application**:

```
color_correction → smooth → sharpen → bloom → vignette → color_temp → grayscale
```

If all effects are disabled (0 / False) and `reference_image` is not connected, the input pipe is passed through unchanged. The Finisher's output is also written back to `pipe.images`, so downstream nodes receive the adjusted image.

[↑ Back to top](#top)

---

## Control

### SAX Structure Lock (SDXL)

`SAX_Bridge_Structure_Lock` — Adds a ControlNet structure constraint setting to the pipe. Downstream Detailer / Upscaler nodes generate a structure hint internally from the image they process (Detailer: the cropped region, Upscaler: the upscaled full image) and apply the ControlNet, preventing wide-area anatomy breakdown (torso, limbs, composition) in i2i.

**Inputs**

| Parameter | Type | Default | Description |
|-----------|-----|---------|-------------|
| `pipe` | PIPE_LINE | — | Input pipe |
| `controlnet_name` | Combo | `None` | ControlNet model for the structure constraint. Union ControlNet (SDXL) recommended (e.g. xinsir Union ProMax). Running with `None` raises an error |
| `mode` | Combo | `tile` | Structure hint type. `tile` = blurred-structure lock (no extra dependencies) / `depth` = depth lock / `openpose` = pose skeleton lock / `lineart` = line art lock |
| `strength` | Float (0.0 to 1.5) | 0.6 | Structure constraint strength |
| `start_percent` | Float (0.0 to 1.0, optional) | 0.0 | Sampling step ratio where ControlNet application starts |
| `end_percent` | Float (0.0 to 1.0, optional) | 1.0 | Sampling step ratio where ControlNet application ends |

**Outputs**: `PIPE`

**Behavior**:
- Placing the node enables the constraint; without it, nothing happens (no `off` option)
- Fail-fast: `controlnet_name=None`, ControlNet load failure, an invalid `mode`, or failure to build any structure hint stops with an error instead of silently skipping
- `depth` / `openpose` / `lineart` require `controlnet_aux`; if unavailable or detection fails, the mode degrades along the fallback chain with a warning log (`openpose` → `depth` → `tile`, `depth` → `tile`, `lineart` → `tile`)
- The ControlNet is applied locally inside each consuming node and is not written back to the pipe's `positive` (no double application downstream)

> Place a Union ControlNet model (e.g. xinsir Union ProMax) in `ComfyUI/models/controlnet/` beforehand.

> **Upscaler limit**: full-image i2i + structure constraint prevents wide-area breakdown. For extreme scale factors, combine with SAX Detailer.

[↑ Back to top](#top)

---

## Option

### SAX Image Noise

`SAX_Bridge_Noise_Image` — Injects noise into an image (or masked region).

> **Scope**: Standalone utility for composing with a plain KSampler or other custom nodes. For noise injection within SAX Detailer, use `SAX Enhanced Detailer`'s `latent_noise_intensity` instead.

**Inputs**

| Parameter | Type | Description |
|-----------|-----|------|
| `image` | IMAGE | Input image |
| `intensity` | Float | Noise intensity |
| `noise_type` | Combo | `gaussian` / `grain` / `uniform` |
| `color_mode` | Combo | `rgb` (color noise) / `grayscale` (luminance noise) |
| `seed` | Int | Noise generation seed |
| `mask` | MASK (optional) | Target mask for injection |
| `mask_shrink` | Int | Mask shrink amount (px) |
| `mask_blur` | Int | Mask boundary blur amount (px) |

**Outputs**: `IMAGE`

> `grain` mode is luminance-sensitive (applies stronger noise to dark areas).

[↑ Back to top](#top)

---

### SAX Latent Noise

`SAX_Bridge_Noise_Latent` — Injects noise into the latent space. Used for texture restoration and detail reinforcement in i2i.

> **Scope**: Standalone utility for composing with a plain KSampler or other custom nodes. For noise injection within SAX Detailer, use `SAX Enhanced Detailer`'s `latent_noise_intensity` instead.

**Inputs**: `samples` (LATENT), `intensity`, `noise_type` (`gaussian` / `uniform`), `seed`, `mask` (optional), `mask_shrink`, `mask_blur`

**Outputs**: `SAMPLES` (LATENT)

> **No value clamping**: Latent-space noise injection does not clamp values (the image-space `SAX Image Noise` clamps to `[0, 1]`). At high `intensity`, latent values may exceed ±1.0 — this is intentional by design.

[↑ Back to top](#top)

---

## Segment

### SAX SAM3 Loader

`SAX_Bridge_Loader_SAM3` — Loads a SAM3 model and places it under ComfyUI's VRAM management. Shares VRAM with other models and is automatically offloaded to CPU when needed.

**Inputs**

| Parameter | Type | Description |
|-----------|-----|------|
| `model_name` | Combo | Checkpoint file in the `models/sam3/` directory |
| `precision` | Combo | `fp32` (best quality, recommended) / `bf16` (lower VRAM, Ampere+) / `fp16` (lower VRAM, Volta+) / `auto` (automatically selected based on GPU) |

**Outputs**: `SAM3_MODEL` (type: `CSAM3_MODEL`)

> **Model placement**: Place `.pt` / `.pth` files in `ComfyUI/models/sam3/`.

[↑ Back to top](#top)

---

### SAX SAM3 Multi Segmenter

`SAX_Bridge_Segmenter_Multi` — Specifies targets using multiple text prompt entries with positive/negative modes, combines SAM3 segmentation results, and outputs a mask.

**Inputs**

| Parameter | Type | Description |
|-----------|-----|------|
| `sam3_model` | CSAM3_MODEL | Connected from SAX SAM3 Loader |
| `image` | IMAGE | Target image for processing |
| `mask` | MASK (optional) | ROI mask. Restricts the final mask to the specified region |
| `segments_json` | String (hidden) | Segment entry data (JSON). Managed by the UI — no direct editing needed |

**Outputs**: `MASK`, `PREVIEW_IMAGE`

**Mask Composition Logic**:
1. Runs SAM3 segmentation for each active (`on=true`) entry
2. OR-combines positive entry results → positive mask
3. OR-combines negative entry results → negative mask
4. Final mask = `clamp(positive − negative, 0, 1)`
5. If a `mask` input is provided, ANDs it with the final mask (ROI restriction)

#### UI Operations

Each entry row consists of the following elements:

| Element | Operation | Behavior |
|------|------|------|
| Toggle pill | Click | Toggle entry enabled / disabled |
| Mode badge (＋/－) | Click | Switch between `positive` / `negative` |
| Prompt text | Click | Opens prompt edit dialog |
| `thr` box | Drag up/down | Continuously adjust threshold (click for popup) |
| `p.w.` box | Drag up/down | Continuously adjust presence weight (click for popup) |
| `grow` box | Drag up/down | Continuously adjust mask grow (click for popup) |
| ▲ / ▼ | Click | Reorder entries |
| ✕ | Click | Delete entry |
| `+ Add Item` | Click | Add entry (up to 20) |

#### Entry Parameters

| Parameter | Default | Description |
|-----------|-----------|------|
| `prompt` | `"person"` | Text prompt specifying the detection target |
| `threshold` | `0.2` | Detection confidence threshold (lower = broader detection) |
| `presence_weight` | `0.5` | Influence of presence_score. `0.0` = range-priority / `1.0` = precision-priority |
| `mask_grow` | `0` | Mask expansion (positive) or shrink (negative) in pixels |

[↑ Back to top](#top)

---

## Mask

### SAX Mask Adjust

`SAX_Bridge_Mask_Adjust` — Single-purpose node that applies **grow/shrink → blur → threshold** to an input MASK. Useful for re-adapting SAM3 outputs or hand-painted masks to multiple downstream nodes.

**Inputs**

| Parameter | Type | Default | Range | Description |
|-----------|-----|------|------|------|
| `mask` | MASK | - | - | Mask to process |
| `invert` | Boolean | `False` | - | When True, invert the mask (`1 - mask`) before subsequent operations |
| `grow` | Int | `0` | `-256`〜`256` | Positive: dilate. Negative: erode. Unit: px |
| `blur` | Float | `0.0` | `0.0`〜`64.0` | Gaussian blur sigma (px). `0` disables |
| `threshold` | Float | `0.0` | `0.0`〜`1.0` | Binarize after blur. `0` keeps soft mask |

**Outputs**: `MASK`

**Application order**: `invert → grow → blur → threshold`

#### When to use invert

Switches the semantics from "white = target area" to "white = **protected area**". Useful for scenarios like "detect face with SAM3, then send everything-but-face to Detailer".

| Scenario | Settings |
|---|---|
| Protect face, refine background | SAM3(face) → MaskAdjust(invert=on) → Detailer |
| SAM3 returned background instead of subject | MaskAdjust(invert=on) for instant flip |
| Protect area, expand slightly outward | MaskAdjust(invert=on, grow=+8) |

`invert` is applied **first** in the pipeline, so subsequent grow/blur/threshold operate on the inverted mask as the "target region".

#### Usage tips

| Settings | Effect |
|---|---|
| `grow=+8` | Hard-edged dilation (fastest) |
| `grow=0, blur=3.0, threshold=0.1` | Smoothly dilated binary mask (no jaggies) |
| `grow=0, blur=3.0, threshold=0.9` | Smoothly eroded binary mask |
| `grow=0, blur=3.0, threshold=0.0` | Soft mask (edge feathering only) |

#### Relationship to `SAX SAM3 Multi Segmenter`'s `mask_grow`

The two are **additive**. When fanning out to multiple downstream nodes, set the SAM3 `mask_grow=0` and tune per-branch with this node:

```
SAM3(mask_grow=0) ──┬─→ MaskAdjust(grow=+8) → Detailer (larger)
                    └─→ MaskAdjust(grow=-2) → NoiseInjector (smaller)
```

[↑ Back to top](#top)

---

## Output

### SAX Output

`SAX_Bridge_Output` — Final output node focused on file saving and metadata embedding. Sharpening, grayscale, and other image adjustments are handled by [SAX Finisher](#sax-finisher).

**Inputs**

| Parameter | Type | Description |
|-----------|-----|------|
| `pipe` | PIPE_LINE (optional) | Image source (when `image` is not connected) and metadata provider |
| `image` | IMAGE (optional) | Image to save. Uses `pipe.images` if not connected |
| `save` | Boolean | `True` saves the file. `False` shows preview only |
| `output_dir` | String | Save directory. Supports template variables. Empty = `ComfyUI/output/` |
| `filename_template` | String | Filename template. Supports template variables |
| `filename_index` | Int (0 to 999999) | Starting index for filenames. Auto-increments per execution |
| `index_digits` | Int (1 to 6) | Zero-padding digits for index (e.g. 3 → `001`) |
| `index_position` | Combo | `prefix` (prepend to filename) / `suffix` (append to filename) |
| `format` | Combo | `webp` / `png` |
| `webp_quality` | Int (1 to 100) | WebP quality (ignored when `lossless=True`) |
| `webp_lossless` | Boolean | WebP lossless save |
| `prompt_text` | String (optional) | Prompt text to embed in metadata |

**Outputs**: `IMAGE`

#### Template Variables

| Variable | Default Output | Format Example | Output Example |
|------|--------------|-----------------|--------|
| `{date}` | `20260320` | `{date:%Y-%m-%d}` | `2026-03-20` |
| `{time}` | `153045` | `{time:%H-%M-%S}` | `15-30-45` |
| `{datetime}` | `20260320_153045` | `{datetime:%Y%m%d_%H%M%S}` | `20260320_153045` |
| `{seed}` | `12345` | `{seed:08d}` | `00012345` |
| `{model}` | Checkpoint name (without extension) | — | — |
| `{steps}` | Step count | — | — |
| `{cfg}` | CFG value | — | — |

**Output Example (batch=1, default settings):**
```
output/2026-03-20/001_20260320_153045.webp
```

[↑ Back to top](#top)

---

### SAX Image Preview

`SAX_Bridge_Image_Preview` — A terminal node that displays an IMAGE batch as a comparison preview.

**Inputs**

| Parameter | Type | Description |
|-----------|-----|------|
| `cell_w` | Int (64 to 512) | Width of each cell in the main view (px) |
| `max_cols` | Int (1 to 8) | Number of columns shown simultaneously |
| `preview_quality` | Combo | `low`=512px / `medium`=1024px / `high`=full size |
| `images` | IMAGE (optional) | IMAGE batch to display |

**Outputs**: None (terminal node)

#### UI Operations

| Operation | Behavior |
|------|------|
| **▼ Grid toggle** | Show/hide the thumbnail grid |
| **Click thumbnail** | Toggle image selection (only selected images shown in main view) |
| **Main seek bar** | Slide to switch pages when selected images exceed `max_cols` |
| **◀ / ▶ buttons** | Switch grid pages (fixed 3 rows per page) |

| Quality | Max long side | Estimate for 40 images at 2048px |
|---------|---------|----------------------|
| `low` | 512px | ≈ 2 sec |
| `medium` | 1024px | ≈ 9 sec |
| `high` | Full size | ≈ 35 sec (for quality inspection) |

[↑ Back to top](#top)

---

## Collect

### SAX Image Collector

`SAX_Bridge_Image_Collector` — Collects IMAGE outputs from multiple source nodes and batch-combines them. Combine with SAX Image Preview to build comparison preview workflows.

**Inputs**: `slot_0` to `slot_63` (ANY, optional) — Connect IMAGE outputs to collect

**Outputs**: `images` (IMAGE) — IMAGE tensor with all slot images batch-combined

**Behavior**:
- Uses the first connected IMAGE's size (H × W) as the reference and resizes others to match
- Automatically converts grayscale (1ch) and RGBA (4ch) → RGB (3ch)
- If more than 100 images are collected, only the first 100 are used

[↑ Back to top](#top)

---

### SAX Node Collector

`SAX_Bridge_Node_Collector` — Registers multiple nodes as "sources" and aggregates all their outputs for forwarding to downstream nodes.

> Unlike Set/Get nodes, this uses actual wiring connections and runs on ComfyUI's normal execution graph.

**Inputs**: `slot_0` to `slot_31` (ANY, optional) — Registered source outputs are wired here in order (slots are managed by the UI)

**Outputs**: `out_0` to `out_31` (ANY) — Forwards the value of the input slot with the same index downstream

#### Key Features

- Open picker with `+ Add Source` button to select and add multiple nodes (up to 32 slots)
- Automatically detects slot additions, removals, and renames on sources and re-syncs input/output slots (preserving downstream connections)
- Keeps connections on the same logical slot even when upstream output slots are renamed or reordered
- Cleans up a source entry only when the upstream node is actually deleted. Transient unavailability (paste / undo / subgraph collapse) does not remove entries
- Changing a source's slot selection, reordering sources, or adding/removing sources preserves connections to downstream nodes (including dynamic-input nodes such as `SAX Prompt Concat`). Only the deselected slots and removed sources lose their links
- Show links pill toggle to show/hide connection wires to sources
- Automatically restores source connections after copy & paste

#### Operations

| Operation | Behavior |
|------|------|
| Click `+ Add Source` | Opens source selection picker |
| Click [✕] on source row | Remove that source |
| Click ▲ / ▼ on source row | Reorder sources |
| Click source name label | Pan canvas to source node |
| Click Show links pill | Toggle connection wire visibility |

[↑ Back to top](#top)

---

### SAX Pipe Collector

`SAX_Bridge_Pipe_Collector` — Registers nodes with multiple `PIPE_LINE` outputs as sources, scans from the top, and returns the first non-None PIPE found.

**Inputs**: `slot_0` to `slot_15` (ANY, optional)

**Outputs**: `pipe` (PIPE_LINE) — First non-None PIPE found

- The order of the source list determines priority (up to 16 sources)
- If all slots are None, downstream will error (intentional by design)

[↑ Back to top](#top)

---

## Debug

### SAX Debug Controller

`SAX_Bridge_Debug_Controller` — A debug switch that emits an execution report for every SAX node in the workflow. Drop one anywhere in the graph and turn it ON.

**Inputs**

| Parameter | Type | Description |
|-----------|-----|------|
| `enabled` | Boolean (ON / OFF) | `ON` requests report output for this workflow run |

**Outputs**: None (`Debug logging: ON` / `OFF` shown in the node UI)

**Behavior**:
- Every SAX node's execute is always wrapped and keeps recording, so this node only toggles whether those records are reported. The Controller's position in the execution order therefore does not matter
- On workflow completion, a flow report is logged and a JSONL file is written to `sax_debug/sax_debug_<UTC timestamp>.jsonl` (under the non-HTTP-exposed system user directory; up to 20 files are kept)
- `OFF` both withdraws the report and stops record accumulation entirely
- Caching is always bypassed so the node executes every run, guaranteeing the toggle takes effect

[↑ Back to top](#top)

### SAX Debug Inspector

`SAX_Bridge_Debug_Inspector` — Inspects a `PIPE_LINE` and displays its internal fields (model/clip/vae existence, seed, loader_settings values, images/samples shape, applied_loras, etc.) in the node UI.

**Inputs**: `pipe` (PIPE_LINE)

**Outputs**: None (text displayed in node UI)

**Example output**:
```
model: present
clip: present
vae: present
seed: 42
loader_settings.steps: 20
loader_settings.cfg: 8.0
loader_settings.sampler_name: euler
images: shape=(1, 512, 512, 3)
samples.samples: shape=(1, 4, 64, 64)
applied_loras: {'lora_a'} (1 entries)
```

[↑ Back to top](#top)

### SAX Debug Text

`SAX_Bridge_Debug_Text` — Displays an arbitrary string value in the node UI. Useful for checking `POPULATED_TEXT`, intermediate prompts, metadata, or any other string value.

**Inputs**: `value` (ANY)

**Outputs**: None (text displayed in node UI)

[↑ Back to top](#top)

### SAX Assert

`SAX_Bridge_Assert` — Asserts that a value meets the expected condition. Results are displayed in the node UI and logs. Failures and evaluation errors do not halt the workflow.

**Inputs**

| Parameter | Type | Description |
|-----------|------|-------------|
| `value` | ANY | Value to check |
| `mode` | Combo | Assertion mode (see table below) |
| `expected` | String | Expected value (auto-parsed based on mode) |
| `label` | String | UI label |

**Outputs**: None (PASS/FAIL shown in node UI with color-coded border: PASS=green / FAIL=red / ERROR=orange)

**Assertion modes**

| mode | Expected format | Behavior |
|------|-----------------|----------|
| `not_none` | — | `value is not None` |
| `is_none` | — | `value is None` |
| `equals` | any (auto-parsed) | `value == expected` |
| `not_equals` | any | `value != expected` |
| `contains` | string | `str(expected) in str(value)` |
| `not_contains` | string | `str(expected) not in str(value)` |
| `matches` | regex | `re.search(expected, str(value))` |
| `startswith` / `endswith` | string | Prefix/suffix match |
| `greater_than` / `less_than` | number | Numeric comparison |
| `in_range` | `"min,max"` | `min <= value <= max` |
| `shape_equals` | `"B,C,H,W"` | Tensor shape match |
| `length_equals` | int | `len(value) == N` |
| `has_key` | string | `key in value` (dict) |
| `has_item` | any | `item in value` (list/set) |

**Auto-parse order for expected**: int → float → bool (`true`/`false`) → None (`null`/`none`) → list/tuple (comma-separated) → str fallback

[↑ Back to top](#top)

### SAX Assert Pipe

`SAX_Bridge_Assert_Pipe` — Extracts a field from a `PIPE_LINE` (or arbitrary dict/object) using a dot-separated path, then validates it with the same assertion modes as SAX Assert.

**Inputs**

| Parameter | Type | Description |
|-----------|------|-------------|
| `value` | ANY | Target (typically PIPE_LINE) |
| `path` | String | Dot-separated path (e.g. `loader_settings.steps`) |
| `mode` / `expected` / `label` | — | Same as SAX Assert |

**Path resolution**: Each segment is tried in order as `dict[key]` → `getattr` → integer index. On failure, an ERROR listing the available keys/attrs is displayed in the UI and logs.

**Outputs**: None (PASS/FAIL shown in node UI)

[↑ Back to top](#top)

---

## Utility

### SAX Primitive Store

`SAX_Bridge_Primitive_Store` — Defines and manages shared primitive variables used throughout the workflow in one place. Adding items dynamically creates output slots that distribute values to downstream nodes.

**Inputs**: `items_json` (String, hidden) — JSON array of item definitions, managed automatically by the node UI

**Outputs**: Dynamically generated per item (INT / FLOAT / STRING / BOOLEAN)

#### Supported Types

| Badge | Type | Value Operations |
|-------|----|---------|
| `INT` | Integer | Drag to increase/decrease / Click to edit Value, Min, Max, Step |
| `FLT` | Float | Drag to increase/decrease / Click to edit Value, Min, Max, Step |
| `STR` | String | Click to open text input dialog |
| `BOL` | Boolean | Click to toggle instantly (ON / OFF) |

`SEED` in `random` mode draws a value from `0` to `Max` on each queued execution, including jobs submitted together. To reproduce a result, use `fixed` mode with the seed used for that result.

> Renaming is not supported. To rename, delete and re-add the item.

[↑ Back to top](#top)

---

### SAX Text Catalog

`SAX_Bridge_Text_Catalog` — Manages named texts (prompts, etc.) as an in-node catalog and assigns them to output slots via Relations. Lets you maintain multiple prompts as a binder and switch between them without rewiring the workflow.

**Inputs**

| Parameter | Type | Description |
|-----------|-----|------|
| `items_json` | String (hidden) | JSON of the Catalog and its Relations, managed automatically by the Manager Dialog and node UI |
| `select_to_add_lora` | Combo (hidden) | Option source for the Manager Editor's LoRA picker. Unused at execution |
| `select_to_add_wildcard` | Combo (hidden) | Option source for the Manager Editor's Wildcard picker. Unused at execution |
| `merge_outputs` | Boolean | `individual`: one output per Relation / `merged`: newline-join enabled Relation texts into one output |

**Outputs**: per-Relation STRING outputs in `individual` mode; one `merged` STRING output in `merged` mode

#### Four-Element Model

| Element | Role | Edit Location |
|---------|------|---------------|
| **Catalog** | Container for Items | Manager Dialog |
| **Item** | A named text entry (`id` / `name` / `text` / `tags`) | Manager Dialog |
| **Relation** | Mapping between Catalog.Item and Slot | Node body widget |
| **Slot** | ComfyUI output pin (auto-generated from Relations) | (not directly editable) |

#### Main Features

**Node Body Widget**
- `📖 Manage Texts...` button / right-click menu opens the Manager Dialog
- `[+ Add Relation]` adds a Relation and a corresponding output Slot
- Setting `merge_outputs` to `merged` strips enabled Relation texts, skips empty strings, newline-joins the rest, and exposes one `merged` output
- Adding, removing, or reordering Relations preserves connections to downstream nodes (including dynamic-input nodes such as `SAX Prompt Concat`)
- Each Relation row has a leading toggle (pill) / `[✎]` (item picker) / `[↑↓]` (reorder) / `[×]` (delete)
- Clicking a Relation row's label opens the Manager with that item selected for editing (`(unset)` / `<orphan>` rows open the item picker instead)
- Toggling OFF keeps the Item assignment but emits `""` from the Slot (use to silence outputs temporarily)
- OFF rows render their text with reduced opacity
- Unset Relations show `(unset)` in gray (the slot remains and any connection to it is preserved)
- Relations referencing deleted Items show `<orphan>` with warning color (the slot remains and any connection to it is preserved)
- The `merge_outputs` toggle (`individual` / `merged`) switches the output form. In `merged` mode only a single `merged` pin is emitted, joining all active Relations' texts with newlines (use this to work around the ComfyUI frontend input-slot ordering glitch that appears once `SAX Prompt Concat`'s dynamic inputs grow past 11, by collapsing to a single input). Toggling changes the output form, so downstream connections are disconnected on switch

**Manager Dialog (Text Management)**
- Left pane: Item list (search, tag filter, `×N` reference count badge)
- Right pane: edit Name / Tags / Text of the selected Item (text editor area is enlarged)
- `[+ New]` to add, `[Duplicate]` / `[Delete]` to copy / remove
- Confirmation dialog when deleting a referenced Item. `[Save]` after deletion preserves downstream connections (the slot remains as `(unset)`)
- `[Manage Tags]` opens a sub-dialog for favorite tag management
- Footer: `[Close]` (asks before discarding unsaved changes) / `[Save]` (commits, dialog stays open)

**Item Picker (Relation Editing)**
- Same search + tag filter UI as the Manager
- "(unset)" pinned at the top (to revert to unassigned)
- AND filtering (search query + all selected tags must match)
- Changing the Item via the picker preserves downstream connections for that Relation

**Tag Features**
- Hybrid input: pick from existing candidates or type freely (auto-added to `tag_definitions`)
- Auto-normalization: `trim()` + lowercase (`"Positive  "` → `"positive"`)
- Favorite tags: `[★/☆]` toggle, `[↑↓]` reorder inside Manage Tags
- Tag filter is fixed to a single line; if it overflows, a `[Show all]` button opens a separate dialog

**Text Editor Autocomplete (Optional)**
- If [pythongosssss/ComfyUI-Custom-Scripts](https://github.com/pythongosssss/ComfyUI-Custom-Scripts) is installed, the Item Text editor textarea gets danbooru tag autocomplete
- Inherits pyssss defaults: category color coding, alias support, ↑↓ Enter/Tab confirmation
- Auto-appends comma separator (`globalSeparator = ", "`)
- Falls back silently to manual input if pyssss is not installed

**LoRA / Wildcard Pickers**
- Below the Item Text editor area, `[+ LoRA]` and `[+ Wildcard]` buttons are placed
- `[+ LoRA]`: opens a picker modal listing ComfyUI's LoRA inventory; inserts `<lora:NAME>` at the cursor position (extension stripped, subdirectory kept to avoid same-name collisions, e.g. `<lora:style/foo>`)
- `[+ Wildcard]`: opens a picker modal listing Impact-Pack wildcards; inserts the wildcard name at the cursor position (auto-prepends `, ` when the preceding text doesn't end with one)
- Buttons are disabled when no LoRA is found / Impact-Pack is not installed (tooltip explains the reason)

**Sort Order**
- Tags: favorites (context-aware) → item count desc → alphabetical
- Items: tuple-lexicographic order based on tag positions (untagged items go last)
- Per-item tag display: matches the tag toggle order

#### Limits

| Item | Value |
|------|-------|
| Max Items | 256 |
| Max Relations | 32 |
| Tags per Item | 8 |
| Max Item id length | 128 chars (DoS protection) |

#### Output Contract

| Case | Output |
|------|--------|
| Relation is ON and correctly references an Item | `Item.text` |
| Relation is OFF (leading toggle off) | `""` |
| Relation is unset (`item_id: null`) | `""` |
| Relation references a deleted Item | `""` |

This aligns with the empty-string skip behavior of downstream nodes such as `SAX Prompt Concat`.

With `merge_outputs` ON (`merged`), surviving texts are stripped, empty strings are dropped, and the remainder is joined with newlines. The backend returns the result in `out_0` and empty strings in `out_1..31`; the frontend exposes a single `merged` pin. This matches the normalization of `SAX Prompt Concat`, including independent BREAK processing.

> **Compatibility**: Older workflows whose `items_json` lacks the `on` field are loaded as ON (backward compatible).

> **Data Scope**: Per-node (saved in `items_json`, included in the workflow). No global sharing.
> **Sharing one Item across multiple Relations**: A single Item can be referenced by multiple Relations to fan out the same text.

[↑ Back to top](#top)

---

### SAX Text Catalog V2

`SAX_Bridge_Text_Catalog_V2` — An independent node that combines explicitly selected text candidates through recipes, including fixed text and reproducible random selection. It can run alongside `SAX_Bridge_Text_Catalog` (V1); it does not replace or automatically migrate V1 data.

**Inputs**

| Parameter | Type | Description |
|-----------|------|-------------|
| `config_json` | String (hidden, optional) | Version 2 JSON for the catalog, recipes, and groups. Omitting the input uses an empty model; the node UI manages it automatically. Empty strings and invalid JSON are errors |
| `seed` | Int (0 to 9007199254740991) | Random selection seed. ComfyUI's control after generate can update it for each run |

**Outputs**: `text` STRING (trimmed non-empty texts joined by newlines) / `selection_json` STRING (record of the selections made for this run)

#### JSON Contract

```json
{
  "version": 2,
  "catalog": { "items": [{ "id": "item-1", "name": "quality", "text": "high quality", "tags": ["quality"] }] },
  "recipes": [{ "id": "default", "name": "Default", "groups": [{ "id": "fixed", "name": "Fixed", "mode": "all", "item_ids": ["item-1"], "count": 1, "on": true }] }],
  "active_recipe_id": "default"
}
```

- `all` selects every candidate in array order. `random` selects `count` distinct candidates and emits them in candidate array order. `count: 0` is valid; too few candidates cause an execution error.
- Each group's draw is independently determined by `seed`, recipe ID, and group ID. Changing another group's enabled state or order does not change the draw. The same item may be selected by multiple groups.
- The same seed and configuration reproduce the same selections. Set ComfyUI's control after generate to `randomize` or `increment` to vary selections between runs.
- Candidates are selected explicitly. Multiple candidates can be added from tag-filtered materials.
- Invalid JSON, unknown schema versions, orphan references, and values over the limits are errors. Limits: 10,000 items, 32 recipes, 32 groups per recipe, 10,000 candidates per group, `count` from 0 to 10,000, 8 tags per item, 128-character IDs, 256-character names, 65,536-character text, 32 MiB `config_json`, and 32 MiB combined output.

#### UI and Editing

- Switch saved recipes, toggle individual groups, and change random selection counts directly on the node. Groups are displayed eight at a time. Seed and post-run seed behavior are also controlled on the node.
- Open the management/editor window for bulk item operations, text editing, and recipe construction. Routine recipe switching and group toggling do not require opening this window.
- Separate views handle the library, item editing, and combinations.
- The library uses the full window for names, tags, text excerpts, and usage counts. Search names/text/tags, sort, select ranges with Shift, select all search results, and apply bulk tag changes or deletion.
- The list is virtualized: only visible rows are rendered even with 10,000 materials. Each activity uses the available space instead of squeezing a text editor below the list.
- The item editor provides dedicated name, tag, and large text fields. Hide the navigation list to focus on the text.
- The combinations view manages item references: switch or duplicate recipes, configure fixed or random groups, choose candidates and counts, toggle groups, and reorder them. Item text editing fields are absent from this view.
- Combinations reference original items by ID, so item edits affect every use. To use independent text, duplicate an item in the item editor, then choose that copy as a candidate in the combinations view.
- Edits apply to the node automatically, with Undo / Redo and post-run result display.

> **Data scope**: Per node (`config_json` is saved in and travels with the workflow). V2 data is independent from V1 data.

[↑ Back to top](#top)

---

### SAX Cache

`SAX_Bridge_Cache` — Applies DeepCache to the model in the Pipe with one touch, accelerating all downstream KSampler and Detailer processing.

**Inputs**

| Parameter | Type | Description |
|-----------|-----|------|
| `pipe` | PIPE_LINE | Input pipe |
| `enabled` | Boolean | When `False`, returns the pipe unchanged without applying cache |
| `deepcache_interval` | Int (1 to 10) | Performs full computation only once every N steps and uses cached values for the rest (1 = DeepCache disabled) |
| `deepcache_start_percent` | Float (0.0 to 1.0) | Denoising progress percentage at which DeepCache begins |

**Outputs**: `PIPE`

> **Placement**: Insert immediately after SAX Loader (before KSampler and Detailer) to apply to all processing in one step.
> **Supported models**: DeepCache is for UNet models only (SD1.5 / SDXL / Illustrious / Pony). With DiT models such as FLUX, SD3.5, Qwen-Image, Chroma or Wan, no cache is applied: a warning is logged and the pipe passes through unchanged.
> **Note**: May cause noticeable quality degradation when combined with distilled models (DMD2, etc.).

[↑ Back to top](#top)

---

### SAX Toggle Manager

`SAX_Bridge_Toggle_Manager` — A control node that batch-manages the bypass state and widget values of groups, subgraphs, nodes, and Boolean widgets on a per-scene basis.

> **No execution required**: Scene switching and toggle operations take effect immediately on the frontend. No queue addition needed.

**Inputs**: `config_json` (String, hidden) — Scene configuration JSON, managed by the frontend; no direct editing needed

**Outputs**: None (frontend-only control node)

#### Key Features

**Scene Management**
- Define multiple scenes and switch instantly with ◀▶ buttons or keyboard
- Each scene independently stores the ON/OFF state of each item
- Add, delete, rename, and reorder scenes from the ⚙ menu

**Item Types**

| Type | Icon | Behavior |
|------|---------|------|
| Group | `▦` | Bypass all nodes in the group at once |
| Subgraph | `▣` | Bypass the subgraph node |
| Node | `◈` | Bypass individual node |
| Boolean widget | `⊞` | Toggle boolean value on a node |

**Navigation**
- Click the label area of a toggle row to pan the canvas to that item
- **↩ Back button** — Instantly jumps back to the Manager node (display position selectable from 6 options)
- **Back key** — Keyboard shortcut (default: `M`, configurable in ⚙ Settings)
- When inside a subgraph, Back automatically exits to the root graph before navigating

#### Operations

| Operation | Behavior |
|------|------|
| Click `+ Node` | Opens item selection picker |
| ⟳ Rescan | Removes items that no longer exist (confirmation dialog shown) |
| ◀ / ▶ buttons | Switch scenes |
| Item row toggle | Immediately toggle ON/OFF for the current scene |
| Click item name | Pan canvas to target item |

[↑ Back to top](#top)
