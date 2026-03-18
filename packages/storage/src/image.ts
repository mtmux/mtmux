// Sharp image processing pipeline
// Lazy-loaded to avoid bundling in client code

export async function processImage(
  buffer: Buffer,
  options: {
    width?: number;
    height?: number;
    quality?: number;
    format?: "jpeg" | "png" | "webp";
  } = {}
): Promise<Buffer> {
  const sharp = (await import("sharp")).default;

  let pipeline = sharp(buffer);

  if (options.width || options.height) {
    pipeline = pipeline.resize(options.width, options.height, {
      fit: "inside",
      withoutEnlargement: true,
    });
  }

  const format = options.format ?? "webp";
  const quality = options.quality ?? 80;

  switch (format) {
    case "jpeg":
      pipeline = pipeline.jpeg({ quality });
      break;
    case "png":
      pipeline = pipeline.png({ quality });
      break;
    case "webp":
      pipeline = pipeline.webp({ quality });
      break;
  }

  return pipeline.toBuffer();
}
