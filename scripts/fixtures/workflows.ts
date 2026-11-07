// scripts/fixtures/workflows.ts — deux graphes synthétiques au format API, avec les nœuds et les types des workflows d'IL1 (spec §13.5).
// Aucun workflow réel : textes, modèles et référence sont inventés. Seule la forme compte : identifiants de nœuds, `class_type` et champs.

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
    '18': { class_type: 'VAEEncode', inputs: { pixels: ['10', 0], vae: ['4', 2] } },
    '22': { class_type: 'LoadImage', inputs: { image: 'reference-essai.png' } },
    '23': { class_type: 'IPAdapterUnifiedLoader', inputs: { preset: 'PLUS (high strength)', model: ['4', 0] } },
    '24': { class_type: 'IPAdapterAdvanced', inputs: { weight: 0.6, weight_type: 'style transfer', model: ['23', 0], ipadapter: ['23', 1], image: ['22', 0] } },
    '26': { class_type: 'ControlNetApplyAdvanced', inputs: { strength: 0.35, start_percent: 0, end_percent: 0.6, positive: ['6', 0], negative: ['7', 0], image: ['10', 0] } },
  };
}

export function upscaleGraph(): Record<string, { class_type: string; inputs: Record<string, unknown> }> {
  return {
    '4': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'modele-essai.safetensors' } },
    '6': { class_type: 'CLIPTextEncode', inputs: { text: 'style essai', clip: ['4', 1] } },
    '7': { class_type: 'CLIPTextEncode', inputs: { text: 'blurry', clip: ['4', 1] } },
    '10': { class_type: 'LoadImage', inputs: { image: 'candidat-essai.png' } },
    '31': { class_type: 'UpscaleModelLoader', inputs: { model_name: 'agrandisseur-essai.pth' } },
    '32': { class_type: 'UltimateSDUpscale', inputs: { upscale_by: 2, seed: 1, denoise: 0.2, image: ['10', 0], model: ['4', 0], positive: ['6', 0], negative: ['7', 0], vae: ['4', 2], upscale_model: ['31', 0] } },
    '34': { class_type: 'ImageScale', inputs: { upscale_method: 'lanczos', width: 100, height: 100, crop: 'disabled', image: ['32', 0] } },
    '35': { class_type: 'SaveImage', inputs: { filename_prefix: 'essai/final', images: ['34', 0] } },
  };
}
