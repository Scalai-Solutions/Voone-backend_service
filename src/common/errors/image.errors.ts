import { AppError } from "./app-error";

/**
 * Everything an image upload can refuse, with the Spanish copy a clinic user reads.
 *
 * All exposed: each message is fixed text that echoes nothing from the upload or from the
 * storage provider. What the provider said stays in the server log.
 */

const NOT_AN_IMAGE = "Sube una imagen PNG, JPG o WebP.";

/** The bytes are not a PNG, JPEG or WebP, or are one that cannot be decoded. */
export class ImageUnsupportedError extends AppError {
  constructor(cause?: unknown) {
    super(NOT_AN_IMAGE, { statusCode: 422, code: "IMAGE_UNSUPPORTED", expose: true, cause });
  }
}

/** The request's content type is not one of the three accepted. */
export class ImageUnsupportedMediaTypeError extends AppError {
  constructor() {
    super(NOT_AN_IMAGE, { statusCode: 415, code: "IMAGE_MEDIA_TYPE", expose: true });
  }
}

export class ImageTooLargeError extends AppError {
  constructor() {
    super("La imagen supera los 5 MB.", {
      statusCode: 413,
      code: "IMAGE_TOO_LARGE",
      expose: true
    });
  }
}

/** Too small, too wide or tall, or more pixels than is safe to decode. */
export class ImageDimensionsError extends AppError {
  constructor() {
    super("El tamaño de la imagen no es válido.", {
      statusCode: 422,
      code: "IMAGE_DIMENSIONS",
      expose: true
    });
  }
}

export class ImageKindInvalidError extends AppError {
  constructor() {
    super("Tipo de imagen no válido.", {
      statusCode: 422,
      code: "IMAGE_KIND_INVALID",
      expose: true
    });
  }
}

/** Storage is not configured in this environment. */
export class ImageStorageUnavailableError extends AppError {
  constructor() {
    super("La subida de imágenes no está configurada.", {
      statusCode: 503,
      code: "IMAGE_STORAGE_UNCONFIGURED",
      expose: true
    });
  }
}

/** The provider refused the file, could not be reached, or timed out. */
export class ImageStorageError extends AppError {
  constructor(cause?: unknown) {
    super("No se ha podido guardar la imagen. Inténtalo de nuevo.", {
      statusCode: 502,
      code: "IMAGE_STORAGE_FAILED",
      expose: true,
      cause
    });
  }
}
