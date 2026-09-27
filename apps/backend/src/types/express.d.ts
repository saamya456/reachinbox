declare global {
  namespace Express {
    interface Request {
      // Set by requireAuth from the server-side session; the only source of the tenant.
      auth?: { userId: string; sessionId: string };
    }
  }
}

export {};
