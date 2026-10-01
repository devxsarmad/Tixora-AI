// Usage:
// Small fetch wrapper for frontend API calls. It keeps the API base URL in one
// place and throws clean errors for non-2xx responses.

// Production uses the /api proxy so HttpOnly cookies stay on the frontend's
// origin. A stale build-time backend URL must not bypass that proxy.
const API_BASE_URL = import.meta.env.PROD
  ? (import.meta.env.VITE_API_BASE_URL ?? "")
  : (import.meta.env.VITE_API_BASE_URL ?? "")

export const AUTH_EXPIRED_EVENT = "tixora:auth-expired";

type ApiErrorBody = {
  error?: {
    code?: string;
    message?: string;
    fields?: Record<string, string[] | undefined>;
  };
};

export class ApiError extends Error {
  status: number;
  code?: string;

  constructor(message: string, params: { status: number; code?: string }) {
    super(message);
    this.name = "ApiError";
    this.status = params.status;
    this.code = params.code;
  }
}

function notifyAuthExpired(errorBody: ApiErrorBody | null, response: Response) {
  const code = errorBody?.error?.code;
  if (
    response.status === 401 &&
    (code === "INVALID_TOKEN" || code === "AUTH_REQUIRED")
  ) {
    window.dispatchEvent(new CustomEvent(AUTH_EXPIRED_EVENT));
  }
}

export async function apiRequest<T>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const headers = {
    "Content-Type": "application/json",
    ...options.headers,
  };

  const response = await fetch(`${API_BASE_URL}${path}`, {
    ...options,
    credentials: "include",
    headers: {
      ...headers,
      "X-Tixora-Request": "1",
    },
  });

  const text = await response.text();
  const data = text ? (JSON.parse(text) as T & ApiErrorBody) : null;

  if (!response.ok) {
    const errorBody = data as ApiErrorBody | null;
    notifyAuthExpired(errorBody, response);

    const firstFieldError = errorBody?.error?.fields
      ? Object.values(errorBody.error.fields).flat().find(Boolean)
      : null;

    throw new ApiError(
      firstFieldError ?? errorBody?.error?.message ?? "API request failed",
      {
        status: response.status,
        code: errorBody?.error?.code,
      },
    );
  }

  return data as T;
}
