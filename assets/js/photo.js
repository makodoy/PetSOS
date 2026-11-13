// Refaz a foto no navegador antes do envio: o arquivo novo não carrega EXIF (que pode trazer o GPS de onde a foto foi
// tirada, muitas vezes a casa da pessoa) e fica leve para celular. Sem conseguir refazer, a foto não é enviada.
const FULL_SIZE = 1600;
const THUMB_SIZE = 480;
const QUALITY = 0.82;

function toBlob(canvas, type) {
  return new Promise((resolve) => canvas.toBlob(resolve, type, QUALITY));
}

async function render(bitmap, maxSide) {
  const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext("2d").drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  // Navegador sem WebP devolve PNG (pesado): aí vale JPEG.
  const webp = await toBlob(canvas, "image/webp");
  if (webp?.type === "image/webp") return webp;
  return toBlob(canvas, "image/jpeg");
}

export async function processPhoto(file) {
  const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  try {
    const [full, thumb] = await Promise.all([render(bitmap, FULL_SIZE), render(bitmap, THUMB_SIZE)]);
    if (!full || !thumb) throw new Error("canvas");
    return { full, thumb };
  } finally {
    bitmap.close();
  }
}
