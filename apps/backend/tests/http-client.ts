// Minimal browser-like HTTP client for tests: keeps cookies, never follows
// redirects (so each OAuth hop can be inspected).

export interface TestResponse {
  status: number;
  location: string | null;
  setCookies: string[];
  body: any;
  text: string;
}

export class TestClient {
  readonly cookies = new Map<string, string>();

  constructor(readonly base: string) {}

  async request(
    method: string,
    path: string,
    { body, headers = {} }: { body?: unknown; headers?: Record<string, string> } = {},
  ): Promise<TestResponse> {
    const cookie = [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
    const response = await fetch(path.startsWith('http') ? path : this.base + path, {
      method,
      redirect: 'manual',
      headers: {
        ...(cookie ? { cookie } : {}),
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...headers,
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const setCookies = response.headers.getSetCookie();
    for (const header of setCookies) {
      const [pair] = header.split(';');
      const eq = pair!.indexOf('=');
      const name = pair!.slice(0, eq).trim();
      const value = decodeURIComponent(pair!.slice(eq + 1).trim());
      const expired = /max-age=0/i.test(header) || /expires=thu, 01 jan 1970/i.test(header) || value === '';
      if (expired) this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
    const text = await response.text();
    let parsed: unknown = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = null;
    }
    return { status: response.status, location: response.headers.get('location'), setCookies, body: parsed, text };
  }

  get = (path: string, headers?: Record<string, string>) => this.request('GET', path, { headers });
  post = (path: string, body?: unknown, headers?: Record<string, string>) => this.request('POST', path, { body, headers });
  patch = (path: string, body?: unknown) => this.request('PATCH', path, { body });
  delete = (path: string) => this.request('DELETE', path);
}
