// Single place for HTTP: JSON in/out, the HttpOnly session cookie
// (credentials: 'include'), and uniform errors. Nothing here stores tokens.

export interface ApiIssue {
  path: string;
  message: string;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
    readonly issues: ApiIssue[] = [],
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

type UnauthorizedListener = () => void;
const unauthorizedListeners = new Set<UnauthorizedListener>();

// The auth provider subscribes so an expired session sends the user to login.
export function onUnauthorized(listener: UnauthorizedListener): () => void {
  unauthorizedListeners.add(listener);
  return () => unauthorizedListeners.delete(listener);
}

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  body?: unknown;
  signal?: AbortSignal;
  query?: Record<string, string | number | undefined>;
}

export async function request<T>(path: string, { method = 'GET', body, signal, query }: RequestOptions = {}): Promise<T> {
  let url = path;
  if (query) {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value !== '') params.set(key, String(value));
    }
    const qs = params.toString();
    if (qs) url += `?${qs}`;
  }

  let response: Response;
  try {
    response = await fetch(url, {
      method,
      credentials: 'include',
      headers: body !== undefined ? { 'content-type': 'application/json' } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal,
    });
  } catch (err) {
    if ((err as Error).name === 'AbortError') throw err;
    throw new ApiError(0, 'network_error', 'Cannot reach the server. Check your connection and try again.');
  }

  if (response.status === 204) return undefined as T;
  const data = (await response.json().catch(() => null)) as
    | { error?: { code?: string; message?: string; details?: unknown; issues?: ApiIssue[] } }
    | null;

  if (!response.ok) {
    const error = data?.error;
    if (response.status === 401) unauthorizedListeners.forEach((l) => l());
    throw new ApiError(
      response.status,
      error?.code ?? 'http_error',
      error?.message ?? (response.status >= 500 ? 'The server had a problem. Please try again.' : 'Request failed'),
      error?.details,
      error?.issues ?? [],
    );
  }
  return data as T;
}

// Human-readable message for any thrown value.
export function errorMessage(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.issues.length) return err.issues.map((i) => (i.path ? `${i.path}: ${i.message}` : i.message)).join(' · ');
    return err.message;
  }
  return err instanceof Error ? err.message : 'Something went wrong';
}
