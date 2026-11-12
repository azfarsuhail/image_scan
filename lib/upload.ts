const MAX_BYTES = 4.5 * 1024 * 1024; // Vercel's request body cap (both APIs accept larger)
const TYPES = ["image/jpeg", "image/png", "image/webp"];

export const missingKey = (name: string) =>
  Response.json({ error: `Server is missing ${name}.` }, { status: 500 });

/** Pulls the `image` field out of a multipart request, or returns a 4xx Response to send back. */
export async function readImage(req: Request): Promise<File | Response> {
  const image = (await req.formData().catch(() => null))?.get("image");
  if (!(image instanceof File) || !TYPES.includes(image.type)) {
    return Response.json({ error: "Send a JPEG, PNG or WebP image in the 'image' field." }, { status: 400 });
  }
  if (image.size > MAX_BYTES) {
    return Response.json({ error: "Image is too large (max 4.5 MB)." }, { status: 413 });
  }
  return image;
}
