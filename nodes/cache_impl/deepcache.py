import logging
import torch
import comfy.model_patcher
import comfy.patcher_extension

logger = logging.getLogger("SAX_Bridge")

try:
    from comfy.ldm.modules.diffusionmodules.openaimodel import forward_timestep_embed, apply_control, timestep_embedding
    _DEEPCACHE_AVAILABLE = True
except ImportError:
    _DEEPCACHE_AVAILABLE = False
    logger.warning("[SAX_Bridge] DeepCache is disabled. Internal API from comfy.ldm.modules.diffusionmodules.openaimodel not found. Check your ComfyUI version.")


class DeepCacheState:
    """UNetブロックのキャッシュ状態を管理する"""
    def __init__(self, deepcache_interval=2, deepcache_start_ratio=0.0, cfg_skip_start_ratio=0.4, cfg_skip_multiplier=1):
        self.deepcache_interval = deepcache_interval
        self.deepcache_start_ratio = deepcache_start_ratio
        self.cfg_skip_start_ratio = cfg_skip_start_ratio
        self.cfg_skip_multiplier = cfg_skip_multiplier

        # ステップ追跡
        self.current_step = -1
        self.total_steps = 0
        self.cached_h = None  # スキップ終了地点の出力
        self.cached_negative = None  # CFGネガティブの最終出力キャッシュ
        self.last_timestep = None
        self.logged = False

        # スキップ設定
        self.skip_start_idx = -1
        self.skip_end_idx = -1

        # 追加: スキップステップ内でのカウンター
        self.skip_cycle_count = 0

        # 統計
        self.steps_computed = 0
        self.steps_cached = 0
        self.cfg_skipped = 0

    def prepare_sampling(self, total_steps):
        self.total_steps = total_steps
        self.current_step = -1
        self.cached_h = None
        self.cached_negative = None
        self.steps_computed = 0
        self.steps_cached = 0
        self.cfg_skipped = 0
        self.last_timestep = None
        self.logged = False
        self.skip_start_idx = -1
        self.skip_end_idx = -1
        self.skip_cycle_count = 0

    def update_step_from_timestep(self, timestep_val):
        """UNetに入力されるタイムステップの変動を見てステップをカウントする"""
        if self.last_timestep is None or abs(self.last_timestep - timestep_val) > 1e-4:
            self.last_timestep = timestep_val
            self.current_step += 1

    def should_skip(self):
        """現在のステップがスキップ対象か判定"""
        if self.deepcache_interval <= 1:
            return False
        # 最初と最後のステップはスキップしない (品質維持)
        if self.current_step == 0 or self.current_step >= self.total_steps - 1:
            return False
        # ratioによる開始判定
        start_step = int(self.total_steps * self.deepcache_start_ratio)
        if self.current_step < start_step:
            return False
        return (self.current_step % self.deepcache_interval) != 0


def deepcache_outer_sample_wrapper(executor, *args, **kwargs):
    """サンプリング開始時にステートを初期化する"""
    # outer_sample の引数はサンプラーやComfyUIのバージョンにより変動する可能性があるため、*args から安全に取得する
    # 通常のシグネチャ: (noise, latent_image, sampler, sigmas, denoise_mask, callback, disable_pbar, seed)

    # sigmas は通常 4番目の引数
    sigmas = kwargs.get("sigmas")
    if sigmas is None and len(args) >= 4:
        sigmas = args[3]

    transformer_options = kwargs.get("transformer_options")
    if transformer_options is None:
        model_options = getattr(executor.class_obj, "model_options", {})
        transformer_options = model_options.get("transformer_options", {})

    state = transformer_options.get("deepcache_state")
    if state:
        if sigmas is not None:
            state.prepare_sampling(len(sigmas) - 1)
        else:
            state.prepare_sampling(20)  # fallback
    # x0: サンプリングの実行
    result = executor(*args, **kwargs)

    # x1: サンプリング終了後のログ出力
    if state:
        total_evals = state.steps_computed + state.steps_cached
        if total_evals > 0 and not state.logged:
            state.logged = True
            total_passes = total_evals * 2
            actual_passes = (state.steps_computed * 2) + (state.steps_cached * 2) - state.steps_cached - state.cfg_skipped
            speedup = total_passes / max(actual_passes, 1)
            logger.info(f"[SAX_Bridge] DeepCache - computed: {state.steps_computed}, cached: {state.steps_cached}, CFG skipped: {state.cfg_skipped}, "
                        f"total evals: {total_evals} ({speedup:.2f}x theoretical speedup)")

    return result


def deepcache_diffusion_model_wrapper(executor, x, timesteps, context, y=None, control=None, transformer_options=None, **kwargs):
    """
    DeepCache 方式の UNet 制御ラッパー
    """
    if transformer_options is None:
        transformer_options = kwargs.get("transformer_options", {})

    model = executor.class_obj
    state: DeepCacheState = transformer_options.get("deepcache_state")

    if state is None:
        # stateがない場合はDeepCacheを適用せず、元のexecutorを呼び出す
        return executor(x, timesteps, context, y, control, transformer_options, **kwargs)

    # ステップ更新
    timestep_val = timesteps[0].item()
    state.update_step_from_timestep(timestep_val)

    input_blocks = model.input_blocks
    output_blocks = model.output_blocks

    # スキップインデックスをモデルのブロック数から動的に決定（初回のみ）
    if state.skip_start_idx == -1:
        skip_start = max(1, len(input_blocks) // 3)
        state.skip_start_idx = skip_start
        state.skip_end_idx = len(output_blocks) - skip_start

    is_skip = state.should_skip() and state.cached_h is not None

    # --- 同期・倍率方式 (Plan B) 判定ロジック ---
    original_dtype = x.dtype
    do_cfg_skip = False
    batch_size = x.shape[0]

    # skip_cycle_count の更新（DeepCacheスキップが始まったらカウントアップ）
    if is_skip:
        state.skip_cycle_count += 1
    else:
        state.skip_cycle_count = 0

    # バッチの順番 (Positive/Negative) を判定 (0: Positive, 1: Negative)
    cond_or_uncond = transformer_options.get("cond_or_uncond", [])
    pos_idx = 0
    neg_idx = 1
    if len(cond_or_uncond) == 2:
        if cond_or_uncond[0] == 0:
            pos_idx = 0
            neg_idx = 1
        elif cond_or_uncond[0] == 1:
            neg_idx = 0
            pos_idx = 1

    if batch_size > 1 and state.cfg_skip_multiplier != 0 and len(cond_or_uncond) == 2:
        start_step = int(state.total_steps * state.cfg_skip_start_ratio)
        if state.current_step >= start_step and state.cached_negative is not None:
            if state.cfg_skip_multiplier == -1:
                do_cfg_skip = True
            elif is_skip and state.cfg_skip_multiplier >= 1:
                if (state.skip_cycle_count % state.cfg_skip_multiplier) == 0:
                    do_cfg_skip = True

    # 整合性維持のため: DeepCache がフル計算時は CFG スキップを禁止（Async時を除く）
    if not is_skip and state.cfg_skip_multiplier != -1:
        do_cfg_skip = False

    if do_cfg_skip:
        state.cfg_skipped += 1
        real_batch = batch_size // 2
        pos_start = pos_idx * real_batch
        pos_end = pos_start + real_batch

        x = x[pos_start:pos_end]
        timesteps = timesteps[pos_start:pos_end]
        context = context[pos_start:pos_end]
        if y is not None:
            y = y[pos_start:pos_end]
        if control is not None:
            new_control = {}
            for k, v in control.items():
                if isinstance(v, list):
                    new_control[k] = [item[pos_start:pos_end] if torch.is_tensor(item) else item for item in v]
                elif torch.is_tensor(v):
                    new_control[k] = v[pos_start:pos_end]
                else:
                    new_control[k] = v
            control = new_control

    # --- 共通の埋め込み計算 (CFGスキップ時は半分で済む) ---
    t_emb = timestep_embedding(timesteps, model.model_channels, repeat_only=False).to(original_dtype)
    emb = model.time_embed(t_emb)
    transformer_patches = transformer_options.get("patches", {})
    if "emb_patch" in transformer_patches:
        for p in transformer_patches["emb_patch"]:
            emb = p(emb, model.model_channels, transformer_options)
    if model.num_classes is not None and y is not None:
        if y.shape[0] == x.shape[0]:
            emb = emb + model.label_emb(y)

    num_video_frames = kwargs.get("num_video_frames", model.default_num_video_frames)
    image_only_indicator = kwargs.get("image_only_indicator", None)
    time_context = kwargs.get("time_context", None)

    if is_skip:
        # --- スキップ実行モード ---
        state.steps_cached += 1
        h = x
        hs = []

        # 1. 最初の Input Blocks を実行
        for id in range(state.skip_start_idx):
            module = input_blocks[id]
            transformer_options["block"] = ("input", id)
            h = forward_timestep_embed(module, h, emb, context, transformer_options,
                                     time_context=time_context, num_video_frames=num_video_frames,
                                     image_only_indicator=image_only_indicator)
            h = apply_control(h, control, 'input')
            if "input_block_patch" in transformer_patches:
                for p in transformer_patches.get("input_block_patch", []):
                    h = p(h, transformer_options)
            hs.append(h)
            if "input_block_patch_after_skip" in transformer_patches:
                for p in transformer_patches.get("input_block_patch_after_skip", []):
                    h = p(h, transformer_options)

        # 2. 中間をスキップし、キャッシュされた h を使用
        h_cache = state.cached_h.to(h.device, dtype=h.dtype)
        if h_cache.shape[0] > h.shape[0]:
            h_cache = h_cache[:h.shape[0]]
        h = h_cache

        # 3. 続きの Output Blocks を実行
        for id in range(state.skip_end_idx, len(output_blocks)):
            module = output_blocks[id]
            transformer_options["block"] = ("output", id)
            hsp = hs.pop()
            hsp = apply_control(hsp, control, 'output')

            # バッチサイズ不整合の修正
            if hsp.shape[0] > h.shape[0]:
                hsp = hsp[:h.shape[0]]

            if "output_block_patch" in transformer_patches:
                for p in transformer_patches.get("output_block_patch", []):
                    h, hsp = p(h, hsp, transformer_options)

            h = torch.cat([h, hsp], dim=1)
            output_shape = hs[-1].shape if len(hs) > 0 else None
            h = forward_timestep_embed(module, h, emb, context, transformer_options, output_shape,
                                     time_context=time_context, num_video_frames=num_video_frames,
                                     image_only_indicator=image_only_indicator)

    else:
        # --- 通常計算モード (およびキャッシュ更新) ---
        state.steps_computed += 1
        h = x
        hs = []

        # 1. Input Blocks
        for id, module in enumerate(input_blocks):
            transformer_options["block"] = ("input", id)
            h = forward_timestep_embed(module, h, emb, context, transformer_options,
                                     time_context=time_context, num_video_frames=num_video_frames,
                                     image_only_indicator=image_only_indicator)
            h = apply_control(h, control, 'input')
            if "input_block_patch" in transformer_patches:
                for p in transformer_patches.get("input_block_patch", []):
                    h = p(h, transformer_options)
            hs.append(h)
            if "input_block_patch_after_skip" in transformer_patches:
                for p in transformer_patches.get("input_block_patch_after_skip", []):
                    h = p(h, transformer_options)

        # 2. Middle Block
        transformer_options["block"] = ("middle", 0)
        if model.middle_block is not None:
            h = forward_timestep_embed(model.middle_block, h, emb, context, transformer_options,
                                     time_context=time_context, num_video_frames=num_video_frames,
                                     image_only_indicator=image_only_indicator)
        h = apply_control(h, control, 'middle')

        # 3. Output Blocks
        for id, module in enumerate(output_blocks):
            transformer_options["block"] = ("output", id)
            hsp = hs.pop()
            hsp = apply_control(hsp, control, 'output')

            if hsp.shape[0] > h.shape[0]:
                hsp = hsp[:h.shape[0]]

            if "output_block_patch" in transformer_patches:
                for p in transformer_patches.get("output_block_patch", []):
                    h, hsp = p(h, hsp, transformer_options)

            h = torch.cat([h, hsp], dim=1)
            output_shape = hs[-1].shape if len(hs) > 0 else None
            h = forward_timestep_embed(module, h, emb, context, transformer_options, output_shape,
                                     time_context=time_context, num_video_frames=num_video_frames,
                                     image_only_indicator=image_only_indicator)

            # スキップ終了地点に対応する Output Block の直後でキャッシュ保存
            if id == state.skip_end_idx - 1:
                state.cached_h = h.detach().clone()

    # 最後の大外枠
    h = h.type(original_dtype)
    if model.predict_codebook_ids:
        result = model.id_predictor(h)
    else:
        result = model.out(h)
    # --- CFGスキップの後処理 ---
    if do_cfg_skip:
        neg_cache = state.cached_negative.to(result.device, dtype=result.dtype)
        if neg_cache.shape[0] > result.shape[0]:
            neg_cache = neg_cache[:result.shape[0]]
        if neg_idx == 0:
            result = torch.cat([neg_cache, result], dim=0)
        else:
            result = torch.cat([result, neg_cache], dim=0)
    else:
        # 通常計算時のみキャッシュ更新（DeepCache全体スキップ時は不正確なネガティブが混ざるため除外）
        if batch_size > 1 and not is_skip and neg_idx != -1:
            real_batch = batch_size // 2
            neg_start = neg_idx * real_batch
            neg_end = neg_start + real_batch
            state.cached_negative = result[neg_start:neg_end].detach().clone()

    return result


def apply_deepcache(
    model: "comfy.model_patcher.ModelPatcher",
    deepcache_interval: int,
    deepcache_start_ratio: float,
    cfg_skip_start_ratio: float = 0.4,
    cfg_skip_multiplier: int = 1,
) -> "comfy.model_patcher.ModelPatcher":
    """model に DeepCache を適用して返す。_DEEPCACHE_AVAILABLE が False の場合は model をそのまま返す。"""
    if not _DEEPCACHE_AVAILABLE:
        logger.warning("[SAX_Bridge] DeepCache is unavailable; returning model as-is.")
        return model

    state = DeepCacheState(
        deepcache_interval=deepcache_interval,
        deepcache_start_ratio=deepcache_start_ratio,
        cfg_skip_start_ratio=cfg_skip_start_ratio,
        cfg_skip_multiplier=cfg_skip_multiplier,
    )

    m = model.clone()

    # ラッパー登録 API (ComfyUI 0.15.1+)
    m.add_wrapper_with_key(
        comfy.patcher_extension.WrappersMP.DIFFUSION_MODEL,
        "deepcache",
        deepcache_diffusion_model_wrapper,
    )
    m.add_wrapper_with_key(
        comfy.patcher_extension.WrappersMP.OUTER_SAMPLE,
        "deepcache",
        deepcache_outer_sample_wrapper,
    )

    m.model_options.setdefault("transformer_options", {})["deepcache_state"] = state

    return m
