<a id="top"></a>

# SAX_Bridge Node Reference

[← Back to README](../README.md)

---

## Category List

| Category | Description | Nodes |
|---------|------|-------|
| [Loader](#loader) | Model and LoRA loading | [SAX Loader](#sax-loader) / [SAX Lora Loader](#sax-lora-loader) |
| [Sampler](#sampler) | KSampler | [SAX KSampler](#sax-ksampler) |
| [Pipe](#pipe) | Pipe construction and switching | [SAX Pipe](#sax-pipe) / [SAX Pipe Switcher](#sax-pipe-switcher) |
| [Prompt](#prompt) | Prompt encoding and concatenation | [SAX Prompt](#sax-prompt) / [SAX Prompt Concat](#sax-prompt-concat) |
| [Enhance](#enhance) | Detailer / Upscaler / Finisher | [SAX Detailer](#sax-detailer) / [SAX Enhanced Detailer](#sax-enhanced-detailer) / [SAX Upscaler](#sax-upscaler) / [SAX Finisher](#sax-finisher) |
| [Option](#option) | Standalone utilities (noise injection etc.) | [SAX Image Noise](#sax-image-noise) / [SAX Latent Noise](#sax-latent-noise) |
| [Segment](#segment) | Segmentation via SAM3 | [SAX SAM3 Loader](#sax-sam3-loader) / [SAX SAM3 Multi Segmenter](#sax-sam3-multi-segmenter) |
| [Mask](#mask) | Mask post-processing | [SAX Mask Adjust](#sax-mask-adjust) |
| [Output](#output) | Output and preview | [SAX Output](#sax-output) / [SAX Image Preview](#sax-image-preview) |
| [Collect](#collect) | Node / image / pipe aggregation | [SAX Image Collector](#sax-image-collector) / [SAX Node Collector](#sax-node-collector) / [SAX Pipe Collector](#sax-pipe-collector) |
| [Debug](#debug) | Debugging & testing | [SAX Assert](#sax-assert) / [SAX Assert Pipe](#sax-assert-pipe) / [SAX Debug Inspector](#sax-debug-inspector) / [SAX Debug Text](#sax-debug-text) |
| [Utility](#utility) | Pipe-internal helpers | [SAX Primitive Store](#sax-primitive-store) / [SAX Text Catalog](#sax-text-catalog) / [SAX Cache](#sax-cache) / [SAX Toggle Manager](#sax-toggle-manager) |

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

**Outputs**: `PIPE`, `POPULATED_TEXT` (expanded text)

**Behavior**:
1. Randomly expands wildcard tokens based on the seed inherited from the Pipe
2. Extracts LoRA tags and applies them to Model and CLIP
3. Splits text into chunks at `BREAK`, encodes each chunk with CLIP, and concatenates with `ConditioningConcat`

> Wildcard functionality is only available when `comfyui-impact-pack` is installed.

[↑ Back to top](#top)

---

### SAX Prompt Concat

`SAX_Bridge_Prompt_Concat` — Concatenates multiple text inputs (up to 10 ports) and processes them together.

**Inputs**: `pipe`, `target_positive` (Boolean), `text_1` to `text_N` (variable, up to 10)

**Outputs**: `PIPE`, `CONDITIONING`, `POPULATED_TEXT`

Use `target_positive` to choose whether the result is stored in Positive or Negative.

[↑ Back to top](#top)

---

## Enhance

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

**Outputs**: `PIPE`, `IMAGE`

**Behavior**:
- If `upscale_model_name` is not `None`, upscales with an ESRGAN-based model then resizes to the `scale_by` target size
- If `denoise > 0`, runs KSampler (i2i) after upscaling to restore texture
- If `negative` is absent from the Pipe, empty conditioning is auto-generated by encoding an empty string with CLIP

> ESRGAN models work well for restoring real-world and compressed images. For AI-generated anime-style images, dedicated anime models such as `4x-AnimeSharp` are recommended.

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

**Outputs**: `LATENT`

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

**Outputs**: `CSAM3_MODEL`

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

#### Key Features

- Open picker with `+ Add Source` button to select and add multiple nodes (up to 32 slots)
- Automatically detects slot additions, removals, and renames on sources and re-syncs input/output slots (preserving downstream connections)
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

**Inputs**: `text` (STRING, multiline)

**Outputs**: None (text displayed in node UI)

[↑ Back to top](#top)

### SAX Assert

`SAX_Bridge_Assert` — Asserts that a value meets the expected condition. Use `stop_on_fail` to choose between halting the workflow on mismatch or just emitting a warning log.

**Inputs**

| Parameter | Type | Description |
|-----------|------|-------------|
| `value` | ANY | Value to check |
| `mode` | Combo | Assertion mode (see table below) |
| `expected` | String | Expected value (auto-parsed based on mode) |
| `label` | String | UI label |
| `stop_on_fail` | Boolean | True: raise RuntimeError on fail / False: warn only |

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
| `mode` / `expected` / `label` / `stop_on_fail` | — | Same as SAX Assert |

**Path resolution**: Each segment is tried in order as `dict[key]` → `getattr` → integer index. On failure, a `RuntimeError` is raised listing the available keys/attrs.

**Outputs**: None (PASS/FAIL shown in node UI)

[↑ Back to top](#top)

---

## Utility

### SAX Primitive Store

`SAX_Bridge_Primitive_Store` — Defines and manages shared primitive variables used throughout the workflow in one place. Adding items dynamically creates output slots that distribute values to downstream nodes.

**Outputs**: Dynamically generated per item (INT / FLOAT / STRING / BOOLEAN)

#### Supported Types

| Badge | Type | Value Operations |
|-------|----|---------|
| `INT` | Integer | Drag to increase/decrease / Click to edit Value, Min, Max, Step |
| `FLT` | Float | Drag to increase/decrease / Click to edit Value, Min, Max, Step |
| `STR` | String | Click to open text input dialog |
| `BOL` | Boolean | Click to toggle instantly (ON / OFF) |

> Renaming is not supported. To rename, delete and re-add the item.

[↑ Back to top](#top)

---

### SAX Text Catalog

`SAX_Bridge_Text_Catalog` — Manages named texts (prompts, etc.) as an in-node catalog and assigns them to output slots via Relations. Lets you maintain multiple prompts as a binder and switch between them without rewiring the workflow.

**Outputs**: STRING outputs dynamically generated per Relation

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
- Each Relation row has a leading toggle (pill) / `[✎]` (item picker) / `[↑↓]` (reorder) / `[×]` (delete)
- Toggling OFF keeps the Item assignment but emits `""` from the Slot (use to silence outputs temporarily)
- OFF rows render their text with reduced opacity
- Unset Relations show `(unset)` in gray
- Relations referencing deleted Items show `<orphan>` with warning color

**Manager Dialog (Text Management)**
- Left pane: Item list (search, tag filter, `×N` reference count badge)
- Right pane: edit Name / Tags / Text of the selected Item (text editor area is enlarged)
- `[+ New]` to add, `[Duplicate]` / `[Delete]` to copy / remove
- Confirmation dialog when deleting an Item that is currently referenced
- `[Manage Tags]` opens a sub-dialog for favorite tag management
- Footer: `[Close]` (asks before discarding unsaved changes) / `[Save]` (commits, dialog stays open)

**Item Picker (Relation Editing)**
- Same search + tag filter UI as the Manager
- "(unset)" pinned at the top (to revert to unassigned)
- AND filtering (search query + all selected tags must match)

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
| Max Items | 32 |
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

> **Compatibility**: Older workflows whose `items_json` lacks the `on` field are loaded as ON (backward compatible).

> **Data Scope**: Per-node (saved in `items_json`, included in the workflow). No global sharing.
> **Sharing one Item across multiple Relations**: A single Item can be referenced by multiple Relations to fan out the same text.

[↑ Back to top](#top)

---

### SAX Cache

`SAX_Bridge_Cache` — Applies DeepCache / TGate to the model in the Pipe with one touch, accelerating all downstream KSampler and Detailer processing.

**Inputs**

| Parameter | Type | Description |
|-----------|-----|------|
| `pipe` | PIPE_LINE | Input pipe |
| `enabled` | Boolean | When `False`, returns the pipe unchanged without applying cache |
| `deepcache_interval` | Int (1 to 10) | Performs full computation only once every N steps and uses cached values for the rest (1 = DeepCache disabled) |
| `deepcache_start_percent` | Float (0.0 to 1.0) | Denoising progress percentage at which DeepCache begins |
| `tgate_enabled` | Boolean (optional) | When `True`, also applies TGate (cross-attention caching) |
| `tgate_gate_step` | Float (0.0 to 1.0, optional) | Boundary percentage at which TGate caching begins |

**Outputs**: `PIPE`

> **Placement**: Insert immediately after SAX Loader (before KSampler and Detailer) to apply to all processing in one step.
> **Note**: May cause noticeable quality degradation when combined with distilled models (DMD2, etc.).

[↑ Back to top](#top)

---

### SAX Toggle Manager

`SAX_Bridge_Toggle_Manager` — A control node that batch-manages the bypass state and widget values of groups, subgraphs, nodes, and Boolean widgets on a per-scene basis.

> **No execution required**: Scene switching and toggle operations take effect immediately on the frontend. No queue addition needed.

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
