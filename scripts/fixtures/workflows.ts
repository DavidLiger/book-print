// scripts/fixtures/workflows.ts — deux graphes synthétiques au format API, avec les nœuds, les liens et les types des workflows d'IL1 (spec §13.5),
// relevés en IC2 sur les graphes de David. Aucun workflow réel : textes, modèles et référence sont inventés. Seule la forme compte : identifiants
// de nœuds, `class_type`, champs et liens.

export function generationGraph(): Record<string, { class_type: string; inputs: Record<string, unknown> }> {
  return {
    '3': { class_type: 'KSampler', inputs: { seed: 1, steps: 30, cfg: 6, sampler_name: 'dpmpp_2m', scheduler: 'karras', denoise: 0.75, model: ['24', 0], positive: ['26', 0], negative: ['26', 1], latent_image: ['18', 0] } },
    '4': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'modele-essai.safetensors' } },
    '6': { class_type: 'CLIPTextEncode', inputs: { text: 'an imaginary animal on a plain, detailed illustration', clip: ['4', 1] } },
    '7': { class_type: 'CLIPTextEncode', inputs: { text: 'extra limbs, blurry, text', clip: ['4', 1] } },
    '8': { class_type: 'VAEDecode', inputs: { samples: ['3', 0], vae: ['4', 2] } },
    '9': { class_type: 'SaveImage', inputs: { filename_prefix: 'essai/generation', images: ['8', 0] } },
    '10': { class_type: 'LoadImage', inputs: { image: 'rendu-essai.png' } },
    '11': { class_type: 'LoadImage', inputs: { image: 'mist-essai.png' } },
    '12': { class_type: 'Canny', inputs: { low_threshold: 0.4, high_threshold: 0.8, image: ['10', 0] } },
    '13': { class_type: 'ControlNetLoader', inputs: { control_net_name: 'controlnet-essai.safetensors' } },
    '14': { class_type: 'SetUnionControlNetType', inputs: { type: 'depth', control_net: ['13', 0] } },
    '15': { class_type: 'SetUnionControlNetType', inputs: { type: 'canny/lineart/anime_lineart/mlsd', control_net: ['13', 0] } },
    '16': { class_type: 'ControlNetApplyAdvanced', inputs: { strength: 0.8, start_percent: 0, end_percent: 1, positive: ['6', 0], negative: ['7', 0], control_net: ['14', 0], image: ['11', 0] } },
    '17': { class_type: 'ControlNetApplyAdvanced', inputs: { strength: 0.5, start_percent: 0, end_percent: 0.8, positive: ['16', 0], negative: ['16', 1], control_net: ['15', 0], image: ['12', 0] } },
    '18': { class_type: 'VAEEncode', inputs: { pixels: ['10', 0], vae: ['4', 2] } },
    '22': { class_type: 'LoadImage', inputs: { image: 'reference-essai.png' } },
    '23': { class_type: 'IPAdapterUnifiedLoader', inputs: { preset: 'PLUS (high strength)', model: ['4', 0] } },
    '24': { class_type: 'IPAdapterAdvanced', inputs: { weight: 0.6, weight_type: 'style transfer', combine_embeds: 'concat', start_at: 0, end_at: 1, embeds_scaling: 'V only', model: ['23', 0], ipadapter: ['23', 1], image: ['22', 0] } },
    '25': { class_type: 'SetUnionControlNetType', inputs: { type: 'tile', control_net: ['13', 0] } },
    '26': { class_type: 'ControlNetApplyAdvanced', inputs: { strength: 0.35, start_percent: 0, end_percent: 0.6, positive: ['17', 0], negative: ['17', 1], control_net: ['25', 0], image: ['10', 0] } },
  };
}

export function upscaleGraph(): Record<string, { class_type: string; inputs: Record<string, unknown> }> {
  return {
    '4': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'modele-essai.safetensors' } },
    '6': { class_type: 'CLIPTextEncode', inputs: { text: 'style essai, fine detail', clip: ['4', 1] } },
    '7': { class_type: 'CLIPTextEncode', inputs: { text: 'blurry, extra limbs', clip: ['4', 1] } },
    '10': { class_type: 'LoadImage', inputs: { image: 'candidat-essai.png' } },
    '31': { class_type: 'UpscaleModelLoader', inputs: { model_name: 'agrandisseur-essai.pth' } },
    '32': { class_type: 'UltimateSDUpscale', inputs: { upscale_by: 2, seed: 1, denoise: 0.2, image: ['10', 0], model: ['4', 0], positive: ['6', 0], negative: ['7', 0], vae: ['4', 2], upscale_model: ['31', 0] } },
    '34': { class_type: 'ImageScale', inputs: { upscale_method: 'lanczos', width: 100, height: 100, crop: 'disabled', image: ['32', 0] } },
    '35': { class_type: 'SaveImage', inputs: { filename_prefix: 'essai/final', images: ['34', 0] } },
  };
}
