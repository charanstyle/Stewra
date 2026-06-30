// Augments Express's Request with the authenticated user id set by requireAuth.
// Optional because it is only present after the requireAuth middleware runs.
declare global {
  namespace Express {
    interface Request {
      userId?: string;
    }
  }
}

export {};
